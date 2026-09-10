import {lnurlFetch} from './net'
import type {MintFee} from './fees'
import {parseMintFee, withinMintFeeBand} from './fees'
import {verifyNoteSignatureHash} from './signature'
import {decodeBolt11AmountMsat, isPreimage, sameInvoice} from './bolt11'

// ---- minting via LUD-06 payRequest ----

export type PayRequestInfo = {
  tag: 'payRequest'
  callback: string
  minSendable: number
  maxSendable: number
  metadata: string
  // LUD-25: present when paying this mints a bearer note at this raw
  // LUD-17 withdraw endpoint. Current minting binds the note to a
  // wallet-chosen secret through the mandatory callback comment.
  withdrawLink?: string
  // Optional on this payRequest shape.  When present it is the SERVICE
  // signing key, which may deliberately differ from the invoice/node key.
  mintPubkey?: string
  // LUD-25 (optional): parsed from metadata (see fees.ts's parseMintFee) -
  // absent means SERVICE didn't advertise one, which the spec says to read
  // as fee-free, not "unknown"
  mintFee?: MintFee
  // LUD-12 capacity. It is optional for a generic payRequest, but a current
  // LUD-25 mint payRequest must advertise at least 64 characters so the
  // wallet can send the hex sha256 commitment naming the new note.
  commentAllowed?: number
  // Additive ForgeSworn/Moneyer extension. Literal true means the mint also
  // accepts the matching `h` field and may offer an authenticated receipt;
  // it never substitutes for commentAllowed above.
  mintToHash?: boolean
}

export const fetchPayRequest = async (url: string): Promise<PayRequestInfo> => {
  const body = await lnurlFetch(url)
  if (body?.tag !== 'payRequest' || typeof body.callback !== 'string') {
    throw new Error('Not a payRequest (unexpected response).')
  }
  const mintFee =
    typeof body.metadata === 'string' ? parseMintFee(body.metadata) : null
  return {
    ...body,
    mintFee: mintFee ?? undefined,
    mintToHash: body.mintToHash === true,
    commentAllowed:
      typeof body.commentAllowed === 'number' ? body.commentAllowed : undefined
  } as PayRequestInfo
}

export type BoundMintCommitment = {
  h: string
  amountMsat: number
  signature?: string
}

const parseBoundMintCommitment = (
  value: unknown
): BoundMintCommitment | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (
    typeof raw.h !== 'string' ||
    !/^[0-9a-fA-F]{64}$/.test(raw.h) ||
    typeof raw.amount !== 'number' ||
    !Number.isSafeInteger(raw.amount) ||
    raw.amount <= 0 ||
    (raw.sig !== undefined && typeof raw.sig !== 'string')
  ) {
    return undefined
  }
  return {
    h: raw.h.toLowerCase(),
    amountMsat: raw.amount,
    ...(typeof raw.sig === 'string' ? {signature: raw.sig} : {})
  }
}

export type InvoiceResult = {
  pr: string
  // LUD-21 (optional): a URL to poll for this invoice's settlement status
  verify?: string
  // LUD-11: false means SERVICE wants the payRequest LNURL/Lightning
  // Address itself (not this one invoice, which is always spent once
  // paid regardless) kept around and reused - per spec, disposable being
  // null/absent MUST be read as true, so only an explicit `false` counts
  disposable: boolean
  // Per-quote acknowledgement and optional pre-settlement commitment for
  // the additive bound-receipt extension.
  mintToHash: boolean
  mint?: BoundMintCommitment
}

// `outputHash` names a current LUD-25 mint output. It is sent as the
// mandatory LUD-12 comment and repeated as the additive `h` extension. The
// parameter is omitted for ordinary Lightning payments.
export const requestInvoice = async (
  payCallback: string,
  amountMsat: number,
  outputHash?: string
): Promise<InvoiceResult> => {
  const cbUrl = new URL(payCallback)
  cbUrl.searchParams.set('amount', String(amountMsat))
  if (outputHash !== undefined) {
    if (!isPreimage(outputHash)) {
      throw new Error(
        'An output hash must be 32 bytes of hex - no invoice was requested.'
      )
    }
    const h = outputHash.trim().toLowerCase()
    cbUrl.searchParams.set('comment', h)
    cbUrl.searchParams.set('h', h)
  }
  const body = await lnurlFetch(cbUrl)
  if (typeof body?.pr !== 'string') {
    throw new Error('Service did not return an invoice.')
  }
  // a service that answers an amount request with an invoice for a
  // DIFFERENT amount is broken or hostile - the invoice's amount is
  // checked wherever it decodes (an amountless one is passed through:
  // nothing to check it against here, the mint judges it later)
  const invoiceMsat = decodeBolt11AmountMsat(body.pr)
  if (invoiceMsat !== null && invoiceMsat !== amountMsat) {
    throw new Error(
      `Service returned an invoice for ${invoiceMsat} msat, not the ${amountMsat} requested.`
    )
  }
  return {
    pr: body.pr,
    verify: typeof body.verify === 'string' ? body.verify : undefined,
    disposable: body.disposable !== false,
    mintToHash: body.mintToHash === true,
    mint: parseBoundMintCommitment(body.mint)
  }
}

export type VerifyResult = {
  settled: boolean
  preimage: string | null
  pr: string
  mint?: BoundMintCommitment
}

// LUD-21: polls whether an invoice from requestInvoice has settled, via the
// URL it optionally returned as `verify`. `preimage` is only populated by a
// service that chooses to return it. For current comment-bound minting it is
// safe settlement proof and is not the note secret; callers must still bind
// the response to the exact requested invoice with sameInvoice.
export const fetchInvoiceVerification = async (
  verifyUrl: string
): Promise<VerifyResult> => {
  const body = await lnurlFetch(verifyUrl)
  if (typeof body?.settled !== 'boolean' || typeof body?.pr !== 'string') {
    throw new Error('Service returned an unexpected verify response.')
  }
  return {
    settled: body.settled,
    preimage: typeof body.preimage === 'string' ? body.preimage : null,
    pr: body.pr,
    mint: parseBoundMintCommitment(body.mint)
  }
}

// Refuse before an invoice is displayed unless the mint committed this exact
// quote to the staged device hash and a fee-compatible net amount. A
// pre-settlement signature would falsely claim value already exists.
export const requireBoundMintQuote = (
  invoice: InvoiceResult,
  expectedH: string,
  grossMsat: number,
  fee?: MintFee
): BoundMintCommitment => {
  const h = expectedH.trim().toLowerCase()
  if (!isPreimage(h)) throw new Error('The expected mint output is malformed.')
  const commitment = invoice.mint
  if (!invoice.mintToHash || !invoice.verify || !commitment) {
    throw new Error(
      'The mint did not offer an authenticated device-bound receipt for this quote.'
    )
  }
  if (commitment.h !== h) {
    throw new Error('The mint committed the quote to a different output.')
  }
  const amountAccepted = fee
    ? withinMintFeeBand(grossMsat, commitment.amountMsat, fee)
    : commitment.amountMsat === grossMsat
  if (!amountAccepted) {
    throw new Error(
      'The mint committed the quote to an unexpected note amount.'
    )
  }
  if (commitment.signature !== undefined) {
    throw new Error('The mint signed an output before its invoice settled.')
  }
  return commitment
}

// Authenticate the settled receipt without k1: the signature is over the
// already-known output hash. Invoice, hash and amount must all repeat the
// pre-payment commitment before the device can move PENDING -> CONFIRMED.
export const validateBoundMintReceipt = (
  invoice: InvoiceResult,
  verification: VerifyResult,
  expectedH: string,
  expectedAmountMsat: number,
  mintPubkey: string
): Required<BoundMintCommitment> => {
  if (!verification.settled) throw new Error('The invoice has not settled.')
  if (!sameInvoice(invoice.pr, verification.pr)) {
    throw new Error('The settlement receipt names a different invoice.')
  }
  const receipt = verification.mint
  if (
    !receipt ||
    receipt.h !== expectedH.trim().toLowerCase() ||
    receipt.amountMsat !== expectedAmountMsat
  ) {
    throw new Error('The settlement receipt does not match the mint quote.')
  }
  if (
    !receipt.signature ||
    !verifyNoteSignatureHash(
      receipt.h,
      receipt.amountMsat,
      receipt.signature,
      mintPubkey
    )
  ) {
    throw new Error('The settled mint receipt has an invalid signature.')
  }
  return {...receipt, signature: receipt.signature}
}
