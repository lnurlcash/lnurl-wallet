// LUD-26: Lightning Address registration, and the recovery scan that goes
// with every key-path note. Registration is a one-time online action (see
// registerUsername): a share's cx1 goes on file at the very address it
// claims, and everything that address later receives arrives with zero
// wallet involvement at payment time (the SERVICE derives the share's next
// unused note itself and credits it when the payment settles) - so the
// wallet's only remaining job is to come online later and find what
// arrived, by re-deriving the share's notes and checking each (see
// scanForAddressNotes, which walks the wallet and change chains the same
// way). Every registration, update and unregistration is proven by a
// share's own key (signature.ts's signAddressProof), sent form-encoded to
// POST/PUT/DELETE /.well-known/lnurlp/<username>.
import {bytesToHex} from '@noble/hashes/utils.js'
import {lnurlFetch} from './net'
import {
  ServiceError,
  NoteUnknownError,
  NoteSpentError,
  classifyNoteError
} from './errors'
import {fetchNoteInfoByPubkey, type HashWithdrawRequestInfo} from './request'
import {encodeCp1, encodeCx1, type Cx1} from './recoverableNotes'
import {signAddressProof} from './signature'

// the SERVICE's own Lightning Address endpoint for `username`, where its
// registration lives too
const addressUrl = (server: string, username: string): URL =>
  new URL(
    `/.well-known/lnurlp/${encodeURIComponent(username.trim().toLowerCase())}`,
    server
  )

const confirmed = (body: any, what: string): void => {
  if (body?.status !== 'OK') {
    throw new Error(`SERVICE did not confirm the ${what}.`)
  }
}

// `server` is the mint's own origin (see urls.ts's serviceOriginOf) - the
// same identity every other trust decision in this kit is pinned to; its
// hostname is the `domain` every proof binds. `shareKey` is the share's own
// private key (branchDerivation.ts's deriveShareNode), and `share` its cx1.
// A SERVICE never overwrites a registration ("already registered") and
// never accepts a share twice ("cx1 already used"): use a fresh share for
// every registration. `npub`, if given, doubles the username as a NIP-05
// name - sent exactly as typed; SERVICE decodes it itself. If the SERVICE
// charges an address fee it answers with a `pr` to pay, returned here.
export const registerUsername = async (
  server: string,
  username: string,
  share: Cx1,
  shareKey: Uint8Array,
  npub?: string
): Promise<{pr?: string}> => {
  const cx1 = encodeCx1(share)
  const form: Record<string, string> = {
    cx1,
    sig: bytesToHex(
      signAddressProof(shareKey, 'register', server, username, cx1)
    )
  }
  if (npub) form.npub = npub
  const body = await lnurlFetch(addressUrl(server, username), 'POST', form)
  confirmed(body, 'registration')
  return typeof body.pr === 'string' ? {pr: body.pr} : {}
}

// Moves a registered `username` to a new share without ever freeing it
// (LUD-26's PUT): `currentKey` is the key of the share on file (or, for a
// username registered before LUD-26, of the old branch node), signing the
// update over the new cx1; `nextKey` is the new share's, signing the
// register message a POST would carry. Auto-mint starts over at the new
// share's index 0; notes already credited to the old share stay there.
// `npub`, if given, is sent along as with registerUsername - an unsigned
// extra field a SERVICE MAY honour.
export const updateUsername = async (
  server: string,
  username: string,
  currentKey: Uint8Array,
  next: Cx1,
  nextKey: Uint8Array,
  npub?: string
): Promise<void> => {
  const cx1 = encodeCx1(next)
  const body = await lnurlFetch(addressUrl(server, username), 'PUT', {
    ...(npub && {npub}),
    cx1,
    sig: bytesToHex(
      signAddressProof(currentKey, 'update', server, username, cx1)
    ),
    newsig: bytesToHex(
      signAddressProof(nextKey, 'register', server, username, cx1)
    )
  })
  confirmed(body, 'update')
}

// Frees `username` at SERVICE entirely - it goes back to being unclaimed,
// first-come-first-served for anyone, though its share is never accepted
// again. Proven by the key of the share on file: there is no proof-free
// case for deleting an address someone else may depend on.
export const unregisterUsername = async (
  server: string,
  username: string,
  currentKey: Uint8Array
): Promise<void> => {
  const body = await lnurlFetch(addressUrl(server, username), 'DELETE', {
    sig: bytesToHex(
      signAddressProof(currentKey, 'unregister', server, username)
    )
  })
  confirmed(body, 'unregistration')
}

export type AddressScanResult = {
  index: number
  cp1: string
  info: HashWithdrawRequestInfo
}

export type ScanOutcome = 'found' | 'unknown' | 'spent'

export type AddressScanOptions = {
  // standard HD-wallet address-gap-limit convention: stop once this many
  // consecutive indices come back unknown
  gapLimit?: number
  startIndex?: number
  // also re-checks up to `gapLimit` indices immediately BELOW startIndex
  // (down to 0) before the ordinary forward walk - a fixed-size safety net
  // that re-verifies the exact range startIndex claims is already covered,
  // rather than only ever trusting it. Unlike the forward walk, this never
  // stops early on a run of unknowns (there is nothing to "give up" on -
  // it's a bounded, already-sized window, not an open-ended search), so it
  // always checks the full window. See resolveScanStartIndex's own doc
  // comment for the concrete regression this guards against: startIndex
  // itself can be wrong (a stale local floor, or a SERVICE hint that
  // reserved-but-never-settled invoices inflated), and this is the check
  // that catches it even when it is.
  checkBehind?: boolean
  // forces the forward walk to keep going through indices <= this one even
  // after gapLimit consecutive unknowns would otherwise have stopped it -
  // the normal gapLimit-based stop applies again as soon as index passes
  // it. For a caller that knows some index was handed out (a highest index
  // recorded locally, say) and wants a from-scratch walk to reach at least
  // that far rather than stop early on a stretch of unpaid invoices short
  // of it. Typically that index + gapLimit, so the ordinary gap-limit
  // search still applies past it.
  minIndex?: number
  // called as each note is found, so a caller can surface progress (or
  // start acting on a note) without waiting for the whole scan to finish
  onFound?: (result: AddressScanResult) => void
  // called right before each index is probed (including a rate-limited
  // retry of the same index) - unlike onFound, which only ever fires on a
  // hit, this lets a caller show live "checking index N" progress across
  // the whole scan, hit or not
  onProgress?: (index: number) => void
  // called when an index is confirmed used but already spent - distinct
  // from onFound (which only ever fires for a still-live, recoverable
  // note): lets a caller track the true highest-used index for its own
  // "next index" bookkeeping even past one it can no longer recover
  onSpent?: (index: number) => void
  // called once per index with its final verdict, whichever it was - the
  // one callback that also reports "unknown", so a caller can draw a full
  // map of what the scan saw (gaps included). An index whose probe threw
  // (aborting the scan) never gets one.
  onOutcome?: (index: number, outcome: ScanOutcome) => void
  // ms to wait before retrying a rate-limited probe - never counted
  // toward the gap limit itself (25.md: "WALLET MUST NOT count a rate
  // limit response as one of the gap limit's 'unknown' ones")
  rateLimitBackoffMs?: number
}

const DEFAULT_GAP_LIMIT = 20
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 2000

const isRateLimited = (err: unknown): boolean =>
  err instanceof ServiceError && /rate.?limit/i.test(err.reason)

// re-derives Q_0, Q_1, ... on one chain - `noteKeyAt(i)` is the note key Q
// (x-only, 32 bytes) at index i: a share's (deriveNotePubkey on its cx1),
// the wallet or change chain's (branchDerivation.ts's deriveNoteKey), or a
// superseded scheme's for sweeping - and checks each via an informational
// GET by its cp1 (fetchNoteInfoByPubkey), never a ck1 secret, so a scan
// alone can never itself let anyone else redeem what it finds. LUD-26: an
// index is used if the SERVICE answers it with a note or "already in use"
// (a burned note); the scan stops after `gapLimit` consecutive unused
// ones. `withdrawUrl` is the mint's own informational withdraw
// endpoint (the same one an existing note's own url already points a
// browser at for this mint - see urls.ts/mintAddressUrl for how a caller
// resolves one for a given trusted mint).
export const scanForAddressNotes = async (
  withdrawUrl: string,
  noteKeyAt: (index: number) => Uint8Array,
  opts: AddressScanOptions = {}
): Promise<AddressScanResult[]> => {
  const gapLimit = opts.gapLimit ?? DEFAULT_GAP_LIMIT
  const backoffMs = opts.rateLimitBackoffMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS
  const found: AddressScanResult[] = []
  const startIndex = opts.startIndex ?? 0

  // probes a single index, transparently retrying through rate limits -
  // shared by both the backward safety-net window and the ordinary forward
  // walk below so the two report through the exact same onProgress/onFound/
  // onSpent callbacks and a caller can't tell which pass found what
  const probeOnce = async (index: number): Promise<ScanOutcome> => {
    const outcome = await probeIndex(index)
    opts.onOutcome?.(index, outcome)
    return outcome
  }

  const probeIndex = async (index: number): Promise<ScanOutcome> => {
    for (;;) {
      opts.onProgress?.(index)
      const cp1 = encodeCp1(noteKeyAt(index))
      try {
        const info = await fetchNoteInfoByPubkey(withdrawUrl, cp1)
        const result: AddressScanResult = {index, cp1, info}
        found.push(result)
        opts.onFound?.(result)
        return 'found'
      } catch (err) {
        if (isRateLimited(err)) {
          await new Promise(resolve => setTimeout(resolve, backoffMs))
          continue // same index, does not count toward the gap limit
        }
        if (err instanceof NoteUnknownError) return 'unknown'
        // an already-spent index is still proof this branch is in active
        // use (the mint DID mint something there at some point) - unlike an
        // unknown index, it must reset the forward walk's gap counter
        // rather than count toward it
        if (err instanceof NoteSpentError) {
          opts.onSpent?.(index)
          return 'spent'
        }
        // anything else (transport failure, malformed response) is no
        // evidence either way - unlike an explicit "unknown note" verdict,
        // this must NOT count toward the gap limit and stop the scan
        // early: that would risk permanently missing a real note past a
        // transient blip. Surface it and let the caller resume the scan
        // later (e.g. from `index`, via startIndex) instead of silently
        // truncating.
        throw classifyNoteError(err as Error)
      }
    }
  }

  if (opts.checkBehind) {
    const behindFloor = Math.max(0, startIndex - gapLimit)
    for (let index = startIndex - 1; index >= behindFloor; index--) {
      await probeOnce(index)
    }
  }

  let consecutiveUnknown = 0
  let index = startIndex
  while (consecutiveUnknown < gapLimit || index <= (opts.minIndex ?? -1)) {
    const outcome = await probeOnce(index)
    consecutiveUnknown = outcome === 'unknown' ? consecutiveUnknown + 1 : 0
    index++
  }
  return found
}

// The resume-floor rule for combining a caller's own already-confirmed
// floor with a hint of the next index in use (e.g. one recorded on another
// device). A hint can run ahead of what was ever confirmed recovered - an
// index counts as handed out once an invoice names it, paid or not - so it
// is never trusted as a floor by itself.
//
// `localFloor` is whatever the caller already independently trusts as
// "everything below this has been checked" - a device's own resume point
// from an earlier pass, or 0 for either a device that has never scanned
// this chain before, or an explicit "start over from the very beginning"
// request. Only once `localFloor` is already nonzero is the hint trusted to
// skip it forward; at `localFloor === 0` the hint is ignored outright, so
// neither case can ever skip past the very first index.
export const resolveScanStartIndex = (
  localFloor: number,
  serviceHint?: number
): number =>
  localFloor > 0 ? Math.max(localFloor, serviceHint ?? 0) : localFloor
