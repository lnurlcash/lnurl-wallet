import {requireNoteK1, serverOf, withNewK1} from './urls'
import {
  MINT_PUBKEY_PATTERN,
  hashK1,
  parseMintKey,
  requireMutationSignature
} from './signature'
import {
  AmbiguousMintError,
  AmbiguousMutationError,
  NoteSpentError,
  NoteUnknownError,
  PendingNoteError,
  ServiceError,
  classifyNoteError
} from './errors'
import {generateSecret} from './secrets'
import {lnurlFetch} from './net'

export type WithdrawRequestInfo = {
  tag: 'withdrawRequest'
  callback: string
  k1: string
  minWithdrawable: number
  maxWithdrawable: number
  defaultDescription?: string
  mintPubkey: string
}

export type HashWithdrawRequestInfo = Omit<WithdrawRequestInfo, 'k1'>

const parseNoteLookupBody = (body: any): HashWithdrawRequestInfo => {
  if (
    body?.tag !== 'withdrawRequest' ||
    typeof body.callback !== 'string' ||
    typeof body.maxWithdrawable !== 'number' ||
    !Number.isFinite(body.maxWithdrawable) ||
    body.maxWithdrawable < 0 ||
    (body.minWithdrawable !== undefined &&
      (typeof body.minWithdrawable !== 'number' ||
        !Number.isFinite(body.minWithdrawable) ||
        body.minWithdrawable < 0 ||
        body.minWithdrawable > body.maxWithdrawable))
  ) {
    throw new Error('Not a withdrawRequest (unexpected response).')
  }
  return {...body, ...parseMintKey(body)} as HashWithdrawRequestInfo
}

const requestNoteInfoByHash = async (
  url: string,
  h: string
): Promise<HashWithdrawRequestInfo> => {
  if (!/^[0-9a-f]{64}$/i.test(h)) {
    throw new Error('A note hash must be 32 bytes of hex.')
  }
  const hashUrl = new URL(url)
  hashUrl.searchParams.delete('k1')
  hashUrl.searchParams.delete('amount')
  hashUrl.searchParams.delete('sig')
  hashUrl.searchParams.set('h', h.toLowerCase())
  const body = await lnurlFetch(hashUrl)
  if (body.k1 !== undefined) {
    throw new Error('SERVICE returned k1 in a hash-only lookup response.')
  }
  return parseNoteLookupBody(body)
}

// For device-held notes the companion already has h in public recovery
// metadata and never needs to export k1 merely to inspect value or signing
// keys.  No raw-k1 compatibility fallback is possible or attempted here.
export const fetchNoteInfoByHash = async (
  url: string,
  h: string
): Promise<HashWithdrawRequestInfo> => {
  try {
    return await requestNoteInfoByHash(url, h)
  } catch (err) {
    throw classifyNoteError(err as Error)
  }
}

// The informational GET (LUD-03 step 1) never burns, rotates or alters the
// note.  Prefer LUD-25's h=hex(sha256(k1)) lookup so merely checking value and
// signing keys does not expose the bearer secret.  Fall back to raw k1 only
// when an older SERVICE explicitly reports that k1 is the missing/required
// parameter.  Unknown/spent replies and transport failures never trigger a
// secret-revealing retry.
export const fetchNoteInfo = async (
  url: string
): Promise<WithdrawRequestInfo> => {
  // A device-backed bearer deliberately keeps only a secret-free mirror URL
  // in browser storage. Never send that mirror to /w: SERVICE quite rightly
  // rejects a withdraw lookup without k1, but its validation error hides the
  // useful recovery action (reconnect the vault and export there). Every
  // legitimate caller already reconstructs a secret-bearing URL first.
  const queried = requireNoteK1(url)
  const rawUrl = new URL(url)
  rawUrl.searchParams.delete('sig')
  try {
    const info = await requestNoteInfoByHash(rawUrl.toString(), hashK1(queried))
    return {...info, k1: queried}
  } catch (err) {
    const missingK1 =
      err instanceof ServiceError &&
      /(?:missing|required|specify).{0,40}\bk1\b|\bk1\b.{0,40}(?:missing|required)/i.test(
        err.reason
      )
    if (!missingK1) throw classifyNoteError(err as Error)
  }
  let body: any
  try {
    body = await lnurlFetch(rawUrl)
  } catch (fallbackError) {
    throw classifyNoteError(fallbackError as Error)
  }
  // A raw compatibility response MUST echo the actual bearer secret, never a
  // derived/opaque id.  The hash response omits it; restore the wallet's own
  // already-known value only in the local return object for existing callers.
  if (typeof body.k1 !== 'string' || body.k1.toLowerCase() !== queried) {
    throw new Error(
      "Service echoed back a different k1 than queried - the note may have been redeemed elsewhere, or the service isn't spec-compliant."
    )
  }
  return {
    ...parseNoteLookupBody(body),
    k1: queried
  } as WithdrawRequestInfo
}

// after an AmbiguousMutationError: did the burn the request asked for
// actually happen? Probes one of the input k1s with an informational GET:
// 'live' (still outstanding - the request never landed, so the fresh
// secrets the error carries minted nothing and can be dropped safely),
// 'gone' (the service reports it spent/unknown - the burn landed and the
// carried secrets are the only money left), or 'unknown' (the probe itself
// failed - no information either way, keep everything)
export const probeBurnedNote = async (
  url: string
): Promise<'live' | 'gone' | 'unknown'> => {
  try {
    await fetchNoteInfo(url)
    return 'live'
  } catch (err) {
    if (err instanceof NoteSpentError || err instanceof NoteUnknownError) {
      return 'gone'
    }
    return 'unknown'
  }
}

// LUD-25 mint address (theoretical/experimental - see lnurl-mint's README):
// the withdraw-side discovery response a mint MAY publish there - this
// mint's own node identity (alias/uri/color/capacity), the amount bounds a
// freshly minted note can actually fall into, and payLink back to the real
// payRequest. Unlike WithdrawRequestInfo there's no real k1 behind this -
// it's purely informational (this mint only ever custodies bearer notes,
// never per-user accounts, so there's no balance behind a username to
// withdraw), so it's typed and parsed separately rather than reusing that
// type with an optional k1: nothing here is ever safe to treat as
// spendable.
export type MintAddressInfo = {
  tag: 'withdrawRequest'
  callback: string
  minWithdrawable: number
  maxWithdrawable: number
  defaultDescription?: string
  // SERVICE signing identity.  It is deliberately separate from nodePubkey:
  // backends without a compatible node signer use a persistent dedicated key.
  mintPubkey: string
  // Best-effort Lightning node identity parsed from nodeUri, for display only.
  nodePubkey?: string
  payLink: string
  nodeAlias?: string
  nodeUri?: string
  nodeColor?: string
  // the wire field is `nodeCapacity` (msat, see lnurl-mint's
  // LnurlMintAddressResponse) - suffixed here so a caller doesn't read a
  // bare capacity as sats, and mapped below, since a rename that isn't
  // mapped just reads undefined
  nodeCapacityMsat?: number
  nodeNumChannels?: number
  nodeNumPeers?: number
  // advance warning of a planned shutdown (lnurl-mint's config.py
  // SUNSET_DATE), ISO-8601 (e.g. "2026-12-31") - absent for a mint with no
  // planned sunset (most of them), or one that predates this field.
  // Independent of the mint actually having stopped minting: this is
  // purely a heads-up to melt/rotate/transfer notes away before that day,
  // not a live status check
  sunsetDate?: string
  // this mint's total outstanding liability, msat (lnurl-mint's
  // NoteStore.outstanding_msat via LnurlMintAddressResponse) - the combined
  // value of every bearer note it has issued and never burned, straight
  // from its own database rather than anything a funding source reports.
  // Server-side this is always present (defaults to 0), but optional here
  // like every other field on this response: a mint that predates it just
  // omits it
  outstandingNotesMsat?: number
}

// Best-effort discovery only: this endpoint is experimental (not part of
// any numbered LUD), so most mints - including ones a client otherwise
// works fine with - simply won't have it. Callers should treat a rejection
// here as "no extra info available" and fall back to the payRequest lookup
// (fetchPayRequest, see mintRequest.ts), which remains the only functional
// path to actually mint a note.
export const fetchMintAddress = async (
  url: string
): Promise<MintAddressInfo> => {
  const body = await lnurlFetch(url)
  if (
    body?.tag !== 'withdrawRequest' ||
    typeof body.callback !== 'string' ||
    typeof body.payLink !== 'string' ||
    typeof body.maxWithdrawable !== 'number'
  ) {
    throw new Error('Not a mint address response (unexpected shape).')
  }
  const {mintPubkey, nodeCapacity, outstandingNotesMsat, ...rest} = body
  const signingKey = parseMintKey({mintPubkey})
  const nodePubkey =
    typeof body.nodeUri === 'string' &&
    MINT_PUBKEY_PATTERN.test(body.nodeUri.split('@')[0] ?? '')
      ? body.nodeUri.split('@')[0]!.toLowerCase()
      : undefined
  return {
    ...rest,
    ...signingKey,
    nodePubkey,
    nodeCapacityMsat:
      typeof nodeCapacity === 'number' ? nodeCapacity : undefined,
    outstandingNotesMsat:
      typeof outstandingNotesMsat === 'number'
        ? outstandingNotesMsat
        : undefined
  } as MintAddressInfo
}

export type WithdrawSuccessResponse = {
  status: 'OK'
  sig?: string
  sig2?: string
  // LUD-25 melt proof (optional): only present on a melt's response, and
  // only when SERVICE advertises it - see meltNote
  pr?: string
  verify?: string
}

const callbackRequest = async (
  callback: string,
  params: [string, string][]
): Promise<WithdrawSuccessResponse> => {
  // Every mutation below is a bearer operation and therefore needs at least
  // one non-empty k1. Fail locally with the same actionable message as a
  // secret-free informational GET instead of leaking an empty query to the
  // mint and surfacing its generic request-validation response.
  const k1s = params.filter(([key]) => key === 'k1').map(([, value]) => value)
  if (k1s.length === 0 || k1s.some(k1 => k1.trim() === '')) {
    throw new Error(
      'This note has no secret in the browser. If it is marked "on device", reconnect the vault before refreshing or spending it.'
    )
  }
  let cbUrl: URL
  try {
    cbUrl = new URL(callback)
  } catch {
    throw new Error('The service provided an invalid callback URL.')
  }
  // append (not set): merge repeats the k1 param
  for (const [key, value] of params) cbUrl.searchParams.append(key, value)
  let body: any
  try {
    body = await lnurlFetch(cbUrl)
  } catch (err) {
    // a k1 already mid-melt (see meltNote) rejects any other callback
    // naming it with this exact reason string, verbatim per spec
    if (err instanceof ServiceError && err.reason === 'pending') {
      throw new PendingNoteError()
    }
    // a transport-level failure leaves the mutation's outcome unknown -
    // it must reach callers typed, not reclassified from its message text
    if (err instanceof AmbiguousMintError) throw err
    throw classifyNoteError(err as Error)
  }
  if (body?.status !== 'OK') {
    throw new AmbiguousMintError('Operation was not confirmed by the service.')
  }
  return body as WithdrawSuccessResponse
}

export type MeltResult = {
  // LUD-25 melt proof (optional): a LUD-21-style URL SERVICE MAY return,
  // proving this exact outgoing payment settled - see mintRequest.ts's
  // fetchInvoiceVerification. Absent unless SERVICE advertises it
  // (lnurl-mint: only when VERIFY_ENABLED).
  verify?: string
  // the invoice being paid, echoed back alongside the proof - lets the
  // caller bind a later settled report to THIS melt, not some other
  // payment's (see sameInvoice)
  pr?: string
}

// melt: burn a single note, the service pays `pr` of exactly its value -
// merge first to melt several notes in one payment (the spec dropped
// multi-k1 melt). `{"status":"OK"}` here only means the payment is now in
// flight, NOT that the note is confirmed spent: SERVICE pays pr
// asynchronously and only finalizes the burn once it settles, restoring
// the note to outstanding if the payment fails instead. Callers should
// treat this as "melt requested," not "melt done."
export const meltNote = async (
  callback: string,
  k1: string,
  pr: string
): Promise<MeltResult> => {
  const body = await callbackRequest(callback, [
    ['k1', k1],
    ['pr', pr.trim()]
  ])
  return {
    verify: body.verify,
    pr: typeof body.pr === 'string' ? body.pr : undefined
  }
}

// ---- hash-parameterized primitives ----
//
// The actual mint call behind rotate/split/merge, taking a hash the caller
// already has instead of generating one itself. This is what a device/
// hardware-vault integration would drive directly - its own new_secret/
// new_secret_pair produces `h`/`h2` there, not this module's own
// generateSecret(). rotateNote/splitNote/mergeNotes below are just the
// caller-generates-its-own-secret case of these.

export type HashedMutationResult = {signature: string}

export const rotateNoteWithHash = async (
  callback: string,
  k1: string,
  h: string
): Promise<HashedMutationResult> => {
  const body = await callbackRequest(callback, [
    ['k1', k1],
    ['h', h]
  ])
  return {signature: requireMutationSignature(body, 'sig')}
}

export type HashedSplitResult = {
  signature: string
  changeSignature: string
}

export const splitNoteWithHash = async (
  callback: string,
  k1s: string[],
  amountMsat: number,
  h: string,
  h2: string
): Promise<HashedSplitResult> => {
  const body = await callbackRequest(callback, [
    ...k1s.map((k1): [string, string] => ['k1', k1]),
    ['amount', String(amountMsat)],
    ['h', h],
    ['h2', h2]
  ])
  return {
    signature: requireMutationSignature(body, 'sig'),
    changeSignature: requireMutationSignature(body, 'sig2')
  }
}

export const mergeNotesWithHash = async (
  callback: string,
  k1s: string[],
  h: string
): Promise<HashedMutationResult> => {
  const body = await callbackRequest(callback, [
    ...k1s.map((k1): [string, string] => ['k1', k1]),
    ['h', h]
  ])
  return {signature: requireMutationSignature(body, 'sig')}
}

export type RotateResult = {k1: string; signature: string}

// rotate: burn k1, get a fresh secret of the same value - closes the window
// in which any previous holder (or logged URL) could redeem the note. Also
// how a wallet obtains a compact, offline-verifiable copy of a note that
// doesn't have one yet (e.g. straight after minting). Per LUD-25, the
// wallet - not the service - generates that fresh secret and discloses
// only its hash (h): the service never sees, generates, or persists the
// replacement note's raw secret, closing the prior-holder exposure a
// server-generated one would otherwise reopen every time.
export const rotateNote = async (
  callback: string,
  k1: string
): Promise<RotateResult> => {
  const newK1 = generateSecret(serverOf(callback))
  try {
    const result = await rotateNoteWithHash(callback, k1, hashK1(newK1))
    return {k1: newK1, signature: result.signature}
  } catch (err) {
    // the request may have landed - the fresh secret is then the only copy
    // of the rotated note, so it rides the error rather than vanishing
    if (err instanceof AmbiguousMintError) {
      throw new AmbiguousMutationError((err as Error).message, [newK1])
    }
    throw err
  }
}

export type SplitResult = {
  k1: string
  signature: string
  change: string
  changeSignature: string
}

// split: burn one or many k1s (LUD-25: "one or many | no | yes"), mint one
// note worth `amountMsat` and one carrying the remainder of their combined
// value - both secrets wallet-generated per LUD-25 (see rotateNote),
// disclosed as h/h2. Splitting several notes at once needs no prior merge:
// this burns all of them in a single request, same as mergeNotes does
export const splitNote = async (
  callback: string,
  k1s: string[],
  amountMsat: number
): Promise<SplitResult> => {
  const domain = serverOf(callback)
  const newK1 = generateSecret(domain)
  const changeK1 = generateSecret(domain)
  try {
    const result = await splitNoteWithHash(
      callback,
      k1s,
      amountMsat,
      hashK1(newK1),
      hashK1(changeK1)
    )
    return {
      k1: newK1,
      signature: result.signature,
      change: changeK1,
      changeSignature: result.changeSignature
    }
  } catch (err) {
    // the request may have landed - the fresh secrets are then the only
    // copies of both outputs, so they ride the error rather than vanishing
    if (err instanceof AmbiguousMintError) {
      throw new AmbiguousMutationError((err as Error).message, [
        newK1,
        changeK1
      ])
    }
    throw err
  }
}

// merge: burn all given notes, mint one worth their sum - wallet-generated
// secret per LUD-25 (see rotateNote), disclosed as h
export const mergeNotes = async (
  callback: string,
  k1s: string[]
): Promise<RotateResult> => {
  const newK1 = generateSecret(serverOf(callback))
  try {
    const result = await mergeNotesWithHash(callback, k1s, hashK1(newK1))
    return {k1: newK1, signature: result.signature}
  } catch (err) {
    // the request may have landed - the fresh secret is then the only copy
    // of the merged note, so it rides the error rather than vanishing
    if (err instanceof AmbiguousMintError) {
      throw new AmbiguousMutationError((err as Error).message, [newK1])
    }
    throw err
  }
}

export type SettledNote = {
  k1: string
  amountMsat: number
  signature?: string
  callback: string
}

// Resolves what a split's change note or a merge's result note is actually
// worth without mutating it again. Neither response
// carries its own amount (WithdrawSuccessResponse has none - the spec's
// only source of truth for a note's value is an informational GET), and a
// mint that charges fees (LUD-25) may have deducted some from a split's
// change, or refunded some into a merge's result - using the naively
// computed pre-fee amount instead pairs a wrong `amount` with a signature
// the mint actually issued for the true one, so the note looks unsigned
// even though it isn't. The lookup uses h=sha256(k1), so the existing note and
// its signature can be retained without another mutation.
export const settleNote = async (
  baseUrl: string,
  k1: string,
  expectedAmountMsat: number,
  signature: string | undefined
): Promise<SettledNote> => {
  const info = await fetchNoteInfo(
    withNewK1(baseUrl, k1, expectedAmountMsat, signature)
  )
  return {
    k1,
    amountMsat: info.maxWithdrawable,
    signature,
    callback: info.callback
  }
}
