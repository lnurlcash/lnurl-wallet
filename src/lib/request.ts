import {requireNoteK1, serverOf, withNewK1} from './urls'
import {
  MINT_PUBKEY_PATTERN,
  NOTE_SIGNATURE_PATTERN,
  hashK1,
  parseMintKey,
  requireMutationSignature,
  recoverNoteOwnershipPubkey,
  cp1FromCk1
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
import {generateSecret, generatePubkeySecret} from './secrets'
import {lnurlFetch} from './net'
import {isCk1, isCp1, isCs1, decodeCk1, encodeCp1} from './recoverableNotes'

export type WithdrawRequestInfo = {
  tag: 'withdrawRequest'
  callback: string
  k1: string
  minWithdrawable: number
  maxWithdrawable: number
  defaultDescription?: string
  mintPubkey: string
  // LUD-25 Part 2 Offline verification: SERVICE MAY include this on the
  // plain informational GET itself now (not just a k1=ck1 lookup, and not
  // only after an explicit rotate) - a note that already has one needs no
  // rotate/refresh just to become offline-verifiable. Validated the same
  // way requireMutationSignature validates a mutation's own sig (hex or
  // cs1, preserved exactly as disclosed) - never trusted un-normalized off
  // the wire, and simply absent (not a malformed placeholder) if SERVICE
  // didn't send a recognizable one.
  sig?: string
}

export type HashWithdrawRequestInfo = Omit<WithdrawRequestInfo, 'k1'>

const parseOptionalSig = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  if (NOTE_SIGNATURE_PATTERN.test(value)) return value.toLowerCase()
  return isCs1(value) ? value.trim() : undefined
}

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
  // body's own (untyped, unvalidated) sig is deliberately excluded from the
  // spread below and only ever reintroduced via parseOptionalSig - a
  // malformed one must never leak through unnormalized
  const {sig: _rawSig, ...rest} = body
  const sig = parseOptionalSig(body.sig)
  return {
    ...rest,
    ...parseMintKey(body),
    ...(sig !== undefined ? {sig} : {})
  } as HashWithdrawRequestInfo
}

// the informational GET's note-reference field: bare `h`/`p` (never
// `p1`/`p2` - that renaming is /w/cb's own, a different endpoint, see
// callbackRequest's siblings below). `h` is still the legacy field name
// SERVICE aliases forever, so a plain hash keeps using it unchanged
// (works on every mint, old or new); `p` is LUD-25 Part 2's canonical name
// for a cp1 pubkey commitment, meaningful only to a Part-2-aware mint
// anyway - there's no compatibility reason to send a cp1 value under the
// old name.
const requestNoteInfoByField = async (
  url: string,
  field: 'h' | 'p',
  value: string
): Promise<HashWithdrawRequestInfo> => {
  const lookupUrl = new URL(url)
  lookupUrl.searchParams.delete('k1')
  lookupUrl.searchParams.delete('amount')
  lookupUrl.searchParams.delete('sig')
  lookupUrl.searchParams.set(field, value)
  const body = await lnurlFetch(lookupUrl)
  if (body.k1 !== undefined) {
    throw new Error('SERVICE returned k1 in a hash-only lookup response.')
  }
  return parseNoteLookupBody(body)
}

const requestNoteInfoByHash = async (
  url: string,
  h: string
): Promise<HashWithdrawRequestInfo> => {
  if (!/^[0-9a-f]{64}$/i.test(h)) {
    throw new Error('A note hash must be 32 bytes of hex.')
  }
  return requestNoteInfoByField(url, 'h', h.toLowerCase())
}

const requestNoteInfoByPubkey = async (
  url: string,
  cp1Value: string
): Promise<HashWithdrawRequestInfo> => {
  if (!isCp1(cp1Value)) {
    throw new Error('A note pubkey must be a valid cp1 value.')
  }
  return requestNoteInfoByField(url, 'p', cp1Value)
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

// LUD-25 Part 2 counterpart to fetchNoteInfoByHash - looks a cp1 note up by
// its public commitment, never its ck1 secret. The one piece a recovery
// scan (deriving pk_0, pk_1, ... off a registered cx1 branch) needs: each
// probe is exactly this call, never anything that could redeem the note it
// finds.
export const fetchNoteInfoByPubkey = async (
  url: string,
  cp1Value: string
): Promise<HashWithdrawRequestInfo> => {
  try {
    return await requestNoteInfoByPubkey(url, cp1Value)
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

  // LUD-25 Part 2: a ck1 note is looked up by its PUBLIC commitment
  // (p=cp1<pk>), recovered locally from the ck1 signature itself - never
  // by sending the ck1 secret to an informational GET, for the same
  // privacy reason a legacy note is looked up by hash rather than raw k1.
  // No raw-k1-style compatibility fallback exists for this path: a mint
  // that doesn't understand cp1/p at all doesn't support this note kind
  // regardless of field name.
  if (isCk1(queried)) {
    const signatureBytes = decodeCk1(queried)
    const pubkey = signatureBytes
      ? recoverNoteOwnershipPubkey(signatureBytes)
      : null
    if (!pubkey) {
      throw new Error("This note's ck1 secret is malformed.")
    }
    const info = await fetchNoteInfoByPubkey(
      rawUrl.toString(),
      encodeCp1(pubkey)
    )
    return {...info, k1: queried}
  }

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

// LUD-25 Part 2 renamed /w/cb's h/h2 to p1/p2 - h/h2 are still accepted
// forever as the old names (SERVICE aliases them), so a plain hash keeps
// being sent that way unchanged; a cp1 pubkey commitment is sent as
// p1/p2 instead, the current canonical name and the only one a Part-2
// mint is guaranteed to recognize anyway. Dispatched per-field by the
// value's own shape, same as every other dual-mode field in this module -
// never a version flag.
const OUTPUT_FIELD_NAMES: Record<'1' | '2', {legacy: string; current: string}> =
  {
    '1': {legacy: 'h', current: 'p1'},
    '2': {legacy: 'h2', current: 'p2'}
  }

const outputFieldName = (value: string, suffix: '1' | '2'): string =>
  isCp1(value)
    ? OUTPUT_FIELD_NAMES[suffix].current
    : OUTPUT_FIELD_NAMES[suffix].legacy

export const rotateNoteWithHash = async (
  callback: string,
  k1: string,
  h: string
): Promise<HashedMutationResult> => {
  const body = await callbackRequest(callback, [
    ['k1', k1],
    [outputFieldName(h, '1'), h]
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
    [outputFieldName(h, '1'), h],
    [outputFieldName(h2, '2'), h2]
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
    [outputFieldName(h, '1'), h]
  ])
  return {signature: requireMutationSignature(body, 'sig')}
}

export type RotateResult = {k1: string; signature: string}

// LUD-25 Part 2: an output whose OWN k1 is already ck1-shaped proves key
// ownership already - reissuing it as a legacy preimage on every rotate/
// split/merge would silently downgrade it back to Part 1 forever (a pub/
// sig note that never survives its first refresh). `preferPubkey` names
// whether the note(s) feeding this mutation were themselves ck1-shaped;
// generatePubkeySecret returning null (no Part 2 provider configured, or
// the seed-derived key isn't available right now) always falls back to
// the ordinary legacy provider, same as an application that never wired
// Part 2 up at all - this never throws on its own.
const generateOutputSecret = (
  domain: string,
  preferPubkey: boolean
): string => {
  if (preferPubkey) {
    const pubkeySecret = generatePubkeySecret(domain)
    if (pubkeySecret) return pubkeySecret
  }
  return generateSecret(domain)
}

// the value actually disclosed to SERVICE for a freshly generated output -
// outputFieldName below picks the matching field name (p1/h1, p2/h2) from
// this same shape
const disclosedValue = (secret: string): string => {
  if (isCk1(secret)) {
    const cp1 = cp1FromCk1(secret)
    // generateOutputSecret only ever returns a pubkey secret from a
    // configured provider that is itself trusted to hand back a real ck1
    // (see PubkeySecretProvider's own contract) - unreachable in practice,
    // but a malformed one must fail loudly rather than silently disclose
    // nothing (which would tell SERVICE to key the note by no value at all)
    if (!cp1) throw new Error('Generated an invalid pubkey secret.')
    return cp1
  }
  return hashK1(secret)
}

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
  const newK1 = generateOutputSecret(serverOf(callback), isCk1(k1))
  try {
    const result = await rotateNoteWithHash(callback, k1, disclosedValue(newK1))
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
// this burns all of them in a single request, same as mergeNotes does.
// Both outputs prefer a pubkey-bound secret only when EVERY input already
// is one - a mixed batch (at least one legacy input) keeps the existing,
// safe default rather than guessing which side of the split "owns" the
// upgrade.
export const splitNote = async (
  callback: string,
  k1s: string[],
  amountMsat: number
): Promise<SplitResult> => {
  const domain = serverOf(callback)
  const preferPubkey = k1s.every(isCk1)
  const newK1 = generateOutputSecret(domain, preferPubkey)
  const changeK1 = generateOutputSecret(domain, preferPubkey)
  try {
    const result = await splitNoteWithHash(
      callback,
      k1s,
      amountMsat,
      disclosedValue(newK1),
      disclosedValue(changeK1)
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
// secret per LUD-25 (see rotateNote), disclosed as h. Same all-or-nothing
// pubkey preference as splitNote above.
export const mergeNotes = async (
  callback: string,
  k1s: string[]
): Promise<RotateResult> => {
  const newK1 = generateOutputSecret(serverOf(callback), k1s.every(isCk1))
  try {
    const result = await mergeNotesWithHash(
      callback,
      k1s,
      disclosedValue(newK1)
    )
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
