// LUD-25 Part 2: cx1 registration & the recovery scan that goes with it.
// Registration is a one-time online action (see registerUsername);
// everything a registered address later receives arrives with zero
// wallet involvement at payment time (the SERVICE auto-derives and mints
// under the next unused key on the registered branch itself) - so the
// wallet's only remaining job is to come online later and find what
// arrived, by re-deriving pk_0, pk_1, ... and checking each (see
// scanForAddressNotes). Registering (always - even a fresh, unclaimed
// username) or unregistering one MUST be proven, not just asserted
// (25.md's Seed & derivation) - see signAddressProof. This mirrors
// lnurl-mint's own router.py: POST/DELETE `/p/{username}`, never the
// plain k1-bearing GET callback style the rest of this kit uses (Redeeming
// a bearer note) - username registration is its own REST-ish management
// surface, not a bearer-note mutation.
import {bytesToHex} from '@noble/hashes/utils.js'
import {lnurlFetch} from './net'
import {
  ServiceError,
  NoteUnknownError,
  NoteSpentError,
  classifyNoteError
} from './errors'
import {fetchNoteInfoByPubkey, type HashWithdrawRequestInfo} from './request'
import {deriveNotePubkey, encodeCp1, type Cx1} from './recoverableNotes'
import {signAddressProof, type AddressProofAction} from './signature'

// the bare, lowercase hostname a SERVICE checks a proof's `domain` against
// (lnurl-mint's router.py resolves this from its own configured base_url/
// onion_url, via urlparse().hostname - never a scheme, port, or the
// request's own Host header) - deliberately NOT `server` itself (a full
// origin, scheme+host+port, per urls.ts's serviceOriginOf) or the domain
// string cashAddressBranch/cashAddressSecretAtIndex derive under (a
// WALLET-internal choice no SERVICE ever re-derives or checks) - see
// signAddressProof's own domain-binding comment (signature.ts) for why this
// must match the verifier's string exactly.
const addressProofDomain = (server: string): string => new URL(server).hostname

const addressProofUrl = (
  server: string,
  username: string,
  indexZeroSecretKey: Uint8Array,
  action: AddressProofAction
): URL => {
  const url = new URL(`/p/${encodeURIComponent(username)}`, server)
  url.searchParams.set(
    'sig',
    bytesToHex(
      signAddressProof(
        indexZeroSecretKey,
        action,
        addressProofDomain(server),
        username
      )
    )
  )
  return url
}

// `server` is the mint's own origin (see urls.ts's serviceOriginOf) - the
// same identity every other trust decision in this kit is pinned to.
// `indexZeroSecretKey` is this branch's own index-0 note secret (see
// cashSecrets.ts's cashAddressSecretAtIndex(server, 0)) - `sig` is
// mandatory at SERVICE now, even for a fresh, unclaimed username: what it
// proves differs by case (SERVICE checks a fresh claim's `sig` against the
// NEW `cx1` in this same request - a self-proof that this wallet actually
// controls the branch it's registering, not just a public cx1 it copied
// from someone else - and an overwrite's `sig` against whichever branch is
// CURRENTLY on file instead), but this wallet always signs with the SAME
// key either way (its own branch's index-0 secret), which happens to
// satisfy both. `npub`, if given, doubles this same username as a NIP-05
// name (see SERVICE's own get_nip05) - sent exactly as typed (NIP-19's
// own bech32, not bech32m); SERVICE decodes it itself, this package never
// needs the raw bytes, so validating its shape before ever calling this is
// entirely the caller's own concern. Omitting it on an overwrite clears
// any previously registered one - never merges, always replaces wholesale,
// same as `cx1` itself.
export const registerUsername = async (
  server: string,
  username: string,
  cx1: string,
  indexZeroSecretKey: Uint8Array,
  npub?: string
): Promise<void> => {
  const url = addressProofUrl(server, username, indexZeroSecretKey, 'register')
  url.searchParams.set('cx1', cx1)
  if (npub) url.searchParams.set('npub', npub)
  const body = await lnurlFetch(url, 'POST')
  if (body?.status !== 'OK') {
    throw new Error('SERVICE did not confirm the registration.')
  }
}

// Frees `username` at SERVICE entirely - it goes back to being unclaimed,
// first-come-first-served for anyone (router.delete_registered_username).
// `sig` is mandatory here too - there is no proof-free case for deleting
// an address someone else may depend on.
export const unregisterUsername = async (
  server: string,
  username: string,
  indexZeroSecretKey: Uint8Array
): Promise<void> => {
  const url = addressProofUrl(
    server,
    username,
    indexZeroSecretKey,
    'unregister'
  )
  const body = await lnurlFetch(url, 'DELETE')
  if (body?.status !== 'OK') {
    throw new Error('SERVICE did not confirm the unregistration.')
  }
}

export type AddressScanResult = {
  index: number
  cp1: string
  info: HashWithdrawRequestInfo
}

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
  // ms to wait before retrying a rate-limited probe - never counted
  // toward the gap limit itself (25.md: "WALLET MUST NOT count a rate
  // limit response as one of the gap limit's 'unknown' ones")
  rateLimitBackoffMs?: number
}

const DEFAULT_GAP_LIMIT = 20
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 2000

const isRateLimited = (err: unknown): boolean =>
  err instanceof ServiceError && /rate.?limit/i.test(err.reason)

// re-derives pk_0, pk_1, ... off a registered branch (cx1's own payload -
// see cashSecrets.ts's cashAddressBranch for where WALLET gets this) and
// checks each via an informational GET (fetchNoteInfoByPubkey) - never a
// ck1 secret, so a scan alone can never itself let anyone else redeem what
// it finds. `withdrawUrl` is the mint's own informational withdraw
// endpoint (the same one an existing note's own url already points a
// browser at for this mint - see urls.ts/mintAddressUrl for how a caller
// resolves one for a given trusted mint).
export const scanForAddressNotes = async (
  withdrawUrl: string,
  branch: Cx1,
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
  const probeOnce = async (
    index: number
  ): Promise<'found' | 'unknown' | 'spent'> => {
    for (;;) {
      opts.onProgress?.(index)
      const pubkey = deriveNotePubkey(
        branch.pubkeyXOnly,
        branch.chainCode,
        index
      )
      const cp1 = encodeCp1(pubkey)
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
  while (consecutiveUnknown < gapLimit) {
    const outcome = await probeOnce(index)
    consecutiveUnknown = outcome === 'unknown' ? consecutiveUnknown + 1 : 0
    index++
  }
  return found
}

// LUD-25 Part 2's own resume-floor rule for combining a caller's own
// already-confirmed floor with a SERVICE-advertised `text/xpub` index hint
// (25.md's Internal mint transfers metadata - see internalTransfer.ts's
// parseInternalTransferHint for the identical wire format). The hint names
// the next index SERVICE will hand out - it advances the moment SERVICE
// creates an invoice for that index, not once it settles (nothing on the
// wire distinguishes the two), so an address with exactly one payment
// already advertises hint=1 even though index 0 - the note that payment
// minted - has never been confirmed recovered by anyone scanning it.
//
// `localFloor` is whatever the caller already independently trusts as
// "everything below this has been checked" - a device's own resume point
// from an earlier pass, or 0 for either a device that has never scanned
// this branch before, or an explicit "start over from the very beginning"
// request. Only once `localFloor` is already nonzero - a genuine
// self-confirmed resume point - is the hint trusted to skip it forward
// faster than re-walking one index at a time; at `localFloor === 0` the
// hint is ignored outright, so neither case above can ever skip past the
// very first index, however high SERVICE's own hint claims to be.
export const resolveScanStartIndex = (
  localFloor: number,
  serviceHint?: number
): number =>
  localFloor > 0 ? Math.max(localFloor, serviceHint ?? 0) : localFloor
