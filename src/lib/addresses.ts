// LUD-25 Part 2: cx1 registration & the recovery scan that goes with it.
// Registration is a one-time online action (see registerUsername);
// everything a registered address later receives arrives with zero
// wallet involvement at payment time (the SERVICE auto-derives and mints
// under the next unused key on the registered branch itself) - so the
// wallet's only remaining job is to come online later and find what
// arrived, by re-deriving pk_0, pk_1, ... and checking each (see
// scanForAddressNotes). Registering (when overwriting an already-claimed
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

const addressProofUrl = (
  server: string,
  username: string,
  indexZeroSecretKey: Uint8Array,
  action: AddressProofAction
): URL => {
  const url = new URL(`/p/${encodeURIComponent(username)}`, server)
  url.searchParams.set(
    'sig',
    bytesToHex(signAddressProof(indexZeroSecretKey, action, username))
  )
  return url
}

// `server` is the mint's own origin (see urls.ts's serviceOriginOf) - the
// same identity every other trust decision in this kit is pinned to.
// `indexZeroSecretKey` is this branch's own index-0 note secret (see
// cashSecrets.ts's cashAddressSecretAtIndex(server, 0)) - always sent as
// `sig`, even for a fresh, unclaimed username: SERVICE only checks it
// against whatever branch is CURRENTLY on file, so it's simply ignored
// when there's nothing registered yet to prove continued ownership of.
export const registerUsername = async (
  server: string,
  username: string,
  cx1: string,
  indexZeroSecretKey: Uint8Array
): Promise<void> => {
  const url = addressProofUrl(server, username, indexZeroSecretKey, 'register')
  url.searchParams.set('cx1', cx1)
  const body = await lnurlFetch(url, 'POST')
  if (body?.status !== 'OK') {
    throw new Error('SERVICE did not confirm the registration.')
  }
}

// Frees `username` at SERVICE entirely - it goes back to being unclaimed,
// first-come-first-served for anyone (router.delete_registered_username).
// Unlike registerUsername, `sig` here is mandatory at SERVICE: there is no
// proof-free case for deleting an address someone else may depend on.
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
  // called as each note is found, so a caller can surface progress (or
  // start acting on a note) without waiting for the whole scan to finish
  onFound?: (result: AddressScanResult) => void
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
  let consecutiveUnknown = 0
  let index = opts.startIndex ?? 0

  while (consecutiveUnknown < gapLimit) {
    const pubkey = deriveNotePubkey(branch.pubkeyXOnly, branch.chainCode, index)
    const cp1 = encodeCp1(pubkey)
    try {
      const info = await fetchNoteInfoByPubkey(withdrawUrl, cp1)
      const result: AddressScanResult = {index, cp1, info}
      found.push(result)
      opts.onFound?.(result)
      consecutiveUnknown = 0
      index++
    } catch (err) {
      if (isRateLimited(err)) {
        await new Promise(resolve => setTimeout(resolve, backoffMs))
        continue // same index, does not count toward the gap limit
      }
      if (err instanceof NoteUnknownError) {
        consecutiveUnknown++
        index++
        continue
      }
      // an already-spent index is still proof this branch is in active
      // use (the mint DID mint something there at some point) - unlike an
      // unknown index, it must reset the gap counter rather than count
      // toward it, and it must never abort the scan the way a genuine
      // transport/protocol error below does: an earlier note this holder
      // already received and spent must not hide a later, still-unspent
      // one sitting at a higher index right behind it.
      if (err instanceof NoteSpentError) {
        consecutiveUnknown = 0
        index++
        continue
      }
      // anything else (transport failure, malformed response) is no
      // evidence either way - unlike an explicit "unknown note" verdict,
      // this must NOT count toward the gap limit and stop the scan early:
      // that would risk permanently missing a real note past a transient
      // blip. Surface it and let the caller resume the scan later (e.g.
      // from `index`, via startIndex) instead of silently truncating.
      throw classifyNoteError(err as Error)
    }
  }
  return found
}
