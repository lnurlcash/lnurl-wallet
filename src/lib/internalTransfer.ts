// LUD-26's "Internal transfer": a WALLET holding a note on the same SERVICE
// as a registered Lightning Address may pay it without Lightning, by sending
// the note itself to the address's payRequest `callback` - `amount` (the
// note's full value) and `k1` (its spend) - instead of asking for an
// invoice. The SERVICE handles the spend as a rotate whose resulting note it
// picks: it burns the note and credits its full value, free of fees, to the
// payee's share's next unused note, which the payer never learns. The two
// are the same mint when the payRequest's `withdrawLink` is on the note's
// own domain; anywhere else this would hand a bearer secret to a SERVICE
// that does not hold the note, so it is refused before anything is sent.
//
// To pay part of a note, or several notes at once, the wallet first splits
// or merges into a fresh note of its own worth exactly what it sends, then
// sends that one. Any failure after that point carries the new notes'
// secrets out (AmbiguousMutationError) - they are this wallet's money either
// way, and the caller keeps them as notes until a lookup says otherwise.
import {serverOf} from './urls'
import {AmbiguousMintError, AmbiguousMutationError} from './errors'
import {serviceDomainOf} from './branchDerivation'
import {isCk1, isPubkeyCommitment} from './recoverableNotes'
import {lnurlFetch} from './net'
import {
  mergeNotesWithHash,
  splitNoteWithHash,
  generateOutputSecret,
  disclosedValue,
  fetchNoteInfoByHash,
  fetchNoteInfoByPubkey
} from './request'

// what of a payee's payRequest an internal transfer needs
export type InternalTransferPayee = {
  callback: string
  withdrawLink?: string
  commentAllowed?: number
  minSendable: number
  maxSendable: number
}

// whether a payRequest is a registered LUD-26 Lightning Address: it carries
// its mint's withdrawLink, but - unlike the mint's own payRequest, whose
// comment names the note to mint - MUST NOT set commentAllowed, since the
// SERVICE picks the note it credits
export const isRegisteredAddress = (payee: {
  withdrawLink?: string
  commentAllowed?: number
}): boolean => !!payee.withdrawLink && !payee.commentAllowed

const domainOfUrl = (url: string): string =>
  serviceDomainOf(url.replace(/^lnurlw:/i, 'https:'))

// whether `payee` is a registered Lightning Address at the mint `noteUrl`
// (any URL of the note's mint - its note URL, withdraw link or callback) is
// a note of
export const canPayInternally = (
  payee: InternalTransferPayee,
  noteUrl: string
): boolean => {
  if (!payee.withdrawLink || !isRegisteredAddress(payee)) return false
  try {
    return domainOfUrl(payee.withdrawLink) === domainOfUrl(noteUrl)
  } catch {
    return false
  }
}

const assertSendable = (payee: InternalTransferPayee, amountMsat: number) => {
  if (amountMsat < payee.minSendable || amountMsat > payee.maxSendable) {
    throw new Error(
      `${amountMsat} msat is outside what that address accepts (${payee.minSendable}-${payee.maxSendable} msat).`
    )
  }
}

const assertSameMint = (payee: InternalTransferPayee, noteUrl: string) => {
  if (!canPayInternally(payee, noteUrl)) {
    throw new Error(
      "That Lightning Address is not at the note's mint - pay it over Lightning instead."
    )
  }
}

// Sends one whole note, worth exactly `amountMsat`, to the payee. A refusal
// is the SERVICE's answer (classified as for any spend - "already in use"
// is the note already spent); a lost answer is ambiguous, and the note may
// already be the payee's.
export const sendNoteInternally = async (
  payee: InternalTransferPayee,
  noteUrl: string,
  k1: string,
  amountMsat: number
): Promise<void> => {
  assertSameMint(payee, noteUrl)
  assertSendable(payee, amountMsat)
  const url = new URL(payee.callback)
  url.searchParams.set('amount', String(amountMsat))
  url.searchParams.set('k1', k1)
  const body = await lnurlFetch(url)
  if (body?.status !== 'OK') {
    throw new AmbiguousMintError(
      'The service did not confirm the transfer - the note may already be spent.'
    )
  }
}

export type InternalTransferResult = {
  // what the payee was credited: `amountMsat`, or for several notes paid
  // whole the merged note's value, which a fee-charging mint's merge refund
  // may have raised
  paidMsat: number
  // a split's change, this wallet's own new note
  change?: string
  changeSignature?: string
}

// Pays `amountMsat` out of `k1s` (worth `totalInputMsat` together) to a
// Lightning Address at their own mint: one note worth exactly that is sent
// as is; anything else is split (amount < total) or merged (several notes,
// whole) into a fresh note of this wallet's first. `withdrawLink` and
// `callback` are the notes' own mint's informational withdraw endpoint and
// its callback.
export const payInternalTransfer = async (
  payee: InternalTransferPayee,
  withdrawLink: string,
  callback: string,
  k1s: string[],
  amountMsat: number,
  totalInputMsat: number
): Promise<InternalTransferResult> => {
  if (amountMsat > totalInputMsat) {
    throw new Error('Cannot pay more than the selected notes are worth.')
  }
  assertSameMint(payee, callback)
  assertSendable(payee, amountMsat)
  if (k1s.length === 1 && amountMsat === totalInputMsat) {
    await sendNoteInternally(payee, callback, k1s[0]!, amountMsat)
    return {paidMsat: amountMsat}
  }

  const domain = serverOf(callback)
  const preferPubkey = k1s.every(isCk1)
  // a fresh note of this wallet's own, worth what is sent
  const output = generateOutputSecret(domain, preferPubkey, 'output')
  if (amountMsat === totalInputMsat) {
    try {
      await mergeNotesWithHash(callback, k1s, disclosedValue(output))
    } catch (err) {
      if (err instanceof AmbiguousMintError) {
        throw new AmbiguousMutationError((err as Error).message, [output])
      }
      throw err
    }
    return sendKept(payee, withdrawLink, callback, output, [output], {})
  }

  const change = generateOutputSecret(domain, preferPubkey, 'change')
  let changeSignature: string | undefined
  try {
    const result = await splitNoteWithHash(
      callback,
      k1s,
      amountMsat,
      disclosedValue(output),
      disclosedValue(change)
    )
    changeSignature = result.changeSignature
  } catch (err) {
    if (err instanceof AmbiguousMintError) {
      throw new AmbiguousMutationError((err as Error).message, [output, change])
    }
    throw err
  }
  return sendKept(payee, withdrawLink, callback, output, [output, change], {
    change,
    ...(changeSignature === undefined ? {} : {changeSignature})
  })
}

// Sends the wallet's own fresh note `output` whole, at its real value. Any
// failure carries every new note's secret out: the split or merge before it
// has landed, so they are this wallet's money until a lookup says otherwise.
const sendKept = async (
  payee: InternalTransferPayee,
  withdrawLink: string,
  callback: string,
  output: string,
  secrets: string[],
  extra: Omit<InternalTransferResult, 'paidMsat'>
): Promise<InternalTransferResult> => {
  try {
    const ref = disclosedValue(output)
    const info = isPubkeyCommitment(ref)
      ? await fetchNoteInfoByPubkey(withdrawLink, ref)
      : await fetchNoteInfoByHash(withdrawLink, ref)
    await sendNoteInternally(payee, callback, output, info.maxWithdrawable)
    return {paidMsat: info.maxWithdrawable, ...extra}
  } catch (err) {
    throw new AmbiguousMutationError((err as Error).message, secrets)
  }
}
