import {bytesToHex} from '@noble/hashes/utils.js'
import {
  addressBranch,
  addressSecretAtIndex,
  FIRST_ADDRESS_SLOT
} from './cashSecrets'
import {
  resolveMintInput,
  fetchPayRequest,
  fromLud17,
  serverOf,
  noteK1,
  withNewK1,
  scanForAddressNotes,
  resolveScanStartIndex,
  encodeCk1,
  signNoteOwnership,
  k1SpendsNote,
  NOTE_PURPOSE_LIGHTNING_ADDRESS,
  ServiceError
} from './lnurlcash'
import {gapLimit} from './gapLimit'
import {msatToSats} from './helpers'
import {
  markAddressScanned,
  registeredAddresses,
  forgottenAddresses
} from './addressRegistry'
import type {Bearer, ActivityKind} from './storage'
import type {IndexStatus} from './recovery'
import type {NewBearer} from './WalletContext'

// LUD-25 counterpart to recovery.ts's scanMintForNotes - same shape,
// same dedup convention (existing bearers checked by serverOf+noteK1, see
// receive.ts), but scans a REGISTERED address's own watch-only branch
// (cashSecrets.ts's addressBranch, one per address) at
// NOTE_PURPOSE_LIGHTNING_ADDRESS - never the counters recovery.ts's own
// NOTE_PURPOSE_WALLET/NOTE_PURPOSE_CHANGE scans walk - via the
// public-commitment lookup (src/lib/addresses.ts's scanForAddressNotes) rather than
// re-deriving legacy hash-based secrets. Every note this finds signs its
// own ck1 on the spot (signNoteOwnership) - the scan itself never redeems
// anything, it only proves this wallet CAN.

export type AddressScanOutcome = {
  server: string
  username: string
  recovered: NewBearer[]
  // highest index this scan actually found a note at - null when nothing
  // was found this pass (still may be non-null from an EARLIER pass - see
  // nextScanIndex, which tracks that across calls even when this one finds
  // nothing new)
  highestIndex: number | null
  // the index this pass actually started its forward walk from (after
  // resolveScanStartIndex reconciled the caller's own floor against
  // SERVICE's hint) - what checkBehind's window sits just below. Purely
  // informational (a caller display value), never fed back into a later
  // call the way nextScanIndex is.
  checkedFrom: number
  // SERVICE's own advertised next-unused-index hint for this pass (LUD-25
  // LUD-25's text/cpub metadata, see mintRequest.ts's
  // PayRequestInfo.internalTransfer) - null when SERVICE didn't advertise
  // one, or this pass never got far enough to learn it. Purely
  // informational: resolveScanStartIndex already decided how (or whether)
  // to use it: never trust this alone as "already recovered."
  serviceHint: number | null
  // resume floor for the NEXT incremental "check notes" pass, as opposed
  // to a full "rescan all" (startIndex: 0) - the higher of: whatever floor
  // the caller already passed in (never regresses below what's already
  // been checked), this scan's own highest found index + 1, and - after a
  // clean pass that covered everything up to it - SERVICE's own hint. Always
  // present, even on an error before any of that was learned, so a caller
  // can feed it straight back into addressRegistry.ts's markAddressScanned
  // unconditionally
  nextScanIndex: number
  error?: string
}

export type AddressScanOptions = {
  // the address's own branch (addressRegistry.ts's RegisteredAddress.slot,
  // see cashSecrets.ts's FIRST_ADDRESS_SLOT) - undefined is the legacy
  // domain branch. runAddressScan fills it in from the registry
  slot?: number
  startIndex?: number
  // startIndex was picked by hand (AddressScanDialog's start index field): walk
  // from exactly there, never letting SERVICE's hint move it, and don't
  // treat it as an already-checked floor either - nothing below it was
  // necessarily ever checked, so nextScanIndex only advances past what
  // this pass actually finds (same as a full rescan from 0)
  exactStart?: boolean
  // every index probed, hit or not - see scanForAddressNotes' onProgress
  onProgress?: (index: number) => void
  // every index's final verdict - see recovery.ts's IndexStatus
  onIndex?: (index: number, status: IndexStatus) => void
}

// a found note's initial label: the address it was paid to as a tag (so
// the Wallet page's tag filter groups every note from one address) plus
// the branch index it was scanned at - see noteTags.ts for the syntax
export const addressNoteLabel = (
  username: string,
  host: string,
  index: number
): string => `[${username}@${host}] index ${index}`

export const scanRegisteredAddress = async (
  server: string,
  username: string,
  existing: Bearer[] = [],
  opts: AddressScanOptions = {}
): Promise<AddressScanOutcome> => {
  const startFloor = opts.startIndex ?? 0
  const floorOf = (start: number, highest: number | null): number =>
    Math.max(opts.exactStart ? 0 : start, (highest ?? -1) + 1)
  // addressBranch/addressSecretAtIndex derive under the bare host
  // (serverOf, same as this function's own `host` below) - never `server`
  // itself, which callers pass as a full origin (TrustedMint.server/
  // RegisteredAddress.server) for identity-tracking purposes unrelated to
  // this branch. See src/lib/urls.ts's serverOf for why a seed-derived
  // branch must not fragment across schemes/ports the way a signing-key
  // pin legitimately does.
  let host: string
  try {
    host = new URL(server).host
  } catch {
    return {
      server,
      username,
      recovered: [],
      highestIndex: null,
      checkedFrom: startFloor,
      serviceHint: null,
      nextScanIndex: floorOf(startFloor, null),
      error: 'Not a valid mint address.'
    }
  }
  const branch = addressBranch(host, opts.slot)
  if (!branch) {
    return {
      server,
      username,
      recovered: [],
      highestIndex: null,
      checkedFrom: startFloor,
      serviceHint: null,
      nextScanIndex: floorOf(startFloor, null),
      error:
        'No seed-derived key is loaded for this wallet - restore or re-enter your seed first.'
    }
  }

  const payUrl = resolveMintInput(`${username}@${host}`)
  if (!payUrl) {
    return {
      server,
      username,
      recovered: [],
      highestIndex: null,
      checkedFrom: startFloor,
      serviceHint: null,
      nextScanIndex: floorOf(startFloor, null),
      error: 'Not a recognizable mint address.'
    }
  }

  let withdrawUrl: string
  let startIndex = startFloor
  let serviceHint: number | null = null
  try {
    const info = await fetchPayRequest(payUrl)
    if (!info.withdrawLink) {
      return {
        server,
        username,
        recovered: [],
        highestIndex: null,
        checkedFrom: startFloor,
        serviceHint: null,
        nextScanIndex: floorOf(startFloor, null),
        error: 'This mint does not advertise LNURLcash minting.'
      }
    }
    withdrawUrl = fromLud17(info.withdrawLink)
    serviceHint = info.internalTransfer?.startIndex ?? null
    // see resolveScanStartIndex's own doc comment (src/lib/addresses.ts) for
    // why this must never trust SERVICE's hint to skip a fresh scan (or an
    // explicit "full rescan", which always calls this with startIndex: 0)
    // past index 0 - the regression this guards against is documented there
    startIndex = opts.exactStart
      ? startFloor
      : resolveScanStartIndex(startFloor, serviceHint ?? undefined)
  } catch (err) {
    return {
      server,
      username,
      recovered: [],
      highestIndex: null,
      checkedFrom: startFloor,
      serviceHint: null,
      nextScanIndex: floorOf(startFloor, null),
      error: (err as Error).message
    }
  }

  const recovered: NewBearer[] = []
  let highestIndex: number | null = null
  const limit = gapLimit()
  try {
    await scanForAddressNotes(
      withdrawUrl,
      branch,
      NOTE_PURPOSE_LIGHTNING_ADDRESS,
      {
        gapLimit: limit,
        startIndex,
        // re-verifies gapLimit indices below startIndex too, every pass -
        // the safety net that catches startIndex itself being wrong (a
        // stale local floor, or a SERVICE hint that outran actual
        // settlement) even when it is - see scanForAddressNotes' own doc
        // comment
        checkBehind: true,
        // the complementary guarantee at the other end: a forward walk must
        // not give up on some unrelated stretch of abandoned reservations
        // well short of where SERVICE says it has actually handed out
        // invoices (next_index advances at invoice-CREATION time, not
        // settlement - see scanForAddressNotes' own doc comment on
        // minIndex). +limit is deliberate margin past the hint itself, not
        // just up to it, so a genuine gapLimit search still happens beyond
        // it too.
        minIndex: serviceHint !== null ? serviceHint + limit : undefined,
        onProgress: opts.onProgress,
        onOutcome: (index, outcome) => {
          // 'found' is reported from onFound below instead, once it's known
          // whether this wallet already held it
          if (outcome !== 'found') opts.onIndex?.(index, outcome)
        },
        // built directly in onFound (not batched after the scan returns), same
        // as recovery.ts's scanPurposeNotes, so a later index's transport
        // failure can't discard a note already found this same pass
        onFound: result => {
          highestIndex = Math.max(highestIndex ?? -1, result.index)
          const secretKey = addressSecretAtIndex(host, result.index, opts.slot)
          // the cash root can only disappear mid-scan if the wallet locked
          // while it was running - skip rather than crash; a re-scan once
          // unlocked again picks this index right back up
          if (!secretKey) return
          const {pubkeyXOnly: ownershipPubkey, signature: ownershipSignature} =
            signNoteOwnership(secretKey, withdrawUrl)
          const ck1 = encodeCk1(ownershipPubkey, ownershipSignature)
          // attach an already-disclosed offline-verification sig immediately
          // (see WithdrawRequestInfo's own comment) rather than requiring a
          // separate rotate/refresh afterward just to obtain one
          const url = withNewK1(
            withdrawUrl,
            ck1,
            result.info.maxWithdrawable,
            result.info.c
          )
          const alreadyHeld = existing.some(
            b =>
              serverOf(b.url) === serverOf(url) &&
              k1SpendsNote(noteK1(b.url), ownershipPubkey)
          )
          if (!alreadyHeld) {
            recovered.push({
              url,
              callback: result.info.callback,
              amount: result.info.maxWithdrawable,
              verified: true,
              mintPubkey: result.info.mintPubkey,
              label: addressNoteLabel(username, host, result.index)
            })
          }
          opts.onIndex?.(result.index, alreadyHeld ? 'held' : 'recovered')
        }
      }
    )
  } catch (err) {
    return {
      server,
      username,
      recovered,
      highestIndex,
      checkedFrom: startIndex,
      serviceHint,
      nextScanIndex: floorOf(startIndex, highestIndex),
      error: (err as Error).message
    }
  }

  // a pass that finished cleanly has walked every index up to SERVICE's
  // hint (minIndex forces it there, see above) - so the hint itself becomes
  // the resume floor, provided everything BELOW where this pass started was
  // already covered: always true for an ordinary pass (startIndex is either
  // 0 or a floor resolveScanStartIndex already trusts), and for a hand-
  // picked exactStart only when its checkBehind window reached all the way
  // down to 0. An invoice reserved below the hint but paid only later is
  // still caught by the next pass's own checkBehind window (gapLimit below
  // the floor), or by a full rescan beyond that.
  const coveredUpToHint =
    serviceHint !== null && (!opts.exactStart || startIndex - limit <= 0)

  return {
    server,
    username,
    recovered,
    checkedFrom: startIndex,
    serviceHint,
    highestIndex,
    nextScanIndex: Math.max(
      floorOf(startIndex, highestIndex),
      coveredUpToHint ? serviceHint! : 0
    )
  }
}

export type AddressScanWalletOps = {
  addBearer: (note: NewBearer) => Promise<unknown>
  logActivity: (kind: ActivityKind, message: string, label?: string) => void
}

// runs scanRegisteredAddress and actually claims anything it finds into
// the wallet (addBearer + activity log) - the one piece every caller
// (AddressScanDialog's "check notes"/"full rescan", AddressAutoScanner's
// periodic tick) needs identically. Always
// records how far this pass got (markAddressScanned) so the NEXT
// incremental "check notes" pass resumes past it, regardless of whether
// this one found anything. What each caller does with the returned
// outcome (toast, silence-unless-found, a Notification, ...) stays
// caller-specific.
export const runAddressScan = async (
  server: string,
  username: string,
  existing: Bearer[],
  wallet: AddressScanWalletOps,
  opts: AddressScanOptions = {}
): Promise<AddressScanOutcome> => {
  const slot =
    opts.slot ??
    registeredAddresses().find(
      a => a.server === server && a.username === username
    )?.slot
  const result = await scanRegisteredAddress(server, username, existing, {
    ...opts,
    slot
  })
  for (const note of result.recovered) {
    await wallet.addBearer(note)
    wallet.logActivity(
      'recovered',
      `Received ${msatToSats(note.amount)} sats at ${username}@${serverOf(server)}.`
    )
  }
  markAddressScanned(server, username, result.nextScanIndex)
  return result
}

// Whether `username`@`server` is still registered at SERVICE to the branch
// THIS wallet derives - the question an "Invalid ownership signature."
// refusal (unclaim, re-register) leaves open. SERVICE publishes the cx1 it
// has on file in the payRequest's text/cpub entry (internalTransfer.ts), so
// it can be compared directly:
// - 'ours': same branch - a refusal was something else (worth a retry)
// - 'not-ours': registered to some other branch (a different seed, an
//   address claimed under an older derivation, or someone else re-claimed
//   it after it was freed) - this wallet can neither unclaim it nor ever
//   find notes paid to it, so there is nothing left to do but forget it
// - 'unregistered': SERVICE doesn't know the name at all any more
// - 'unknown': couldn't tell (offline, no seed, no text/cpub advertised)
export type AddressOwnership = 'ours' | 'not-ours' | 'unregistered' | 'unknown'

// how many address slots past the highest one this device knows about a
// reclaim still checks - covers names claimed from another device on the
// same seed, which this device has no record of
const SLOT_PROBE = 20

// checkAddressOwnership, plus WHICH of this wallet's branches the mint has
// on file (the legacy domain branch is `slot: undefined`) - what a reclaim
// needs to know to re-add the address with the right keys
export const resolveAddressOwnership = async (
  server: string,
  username: string
): Promise<{ownership: AddressOwnership; slot?: number}> => {
  let host: string
  try {
    host = new URL(server).host
  } catch {
    return {ownership: 'unknown'}
  }
  const payUrl = resolveMintInput(`${username}@${host}`)
  if (!payUrl || !addressBranch(host)) return {ownership: 'unknown'}
  let onFile
  try {
    onFile = (await fetchPayRequest(payUrl)).internalTransfer?.cx1
  } catch (err) {
    if (err instanceof ServiceError && /unknown user/i.test(err.reason)) {
      return {ownership: 'unregistered'}
    }
    return {ownership: 'unknown'}
  }
  if (!onFile) return {ownership: 'unknown'}
  const known = [...registeredAddresses(), ...forgottenAddresses()]
    .filter(a => a.slot !== undefined)
    .map(a => a.slot!)
  const last = Math.max(FIRST_ADDRESS_SLOT - 1, ...known) + SLOT_PROBE
  const slots: (number | undefined)[] = [undefined]
  for (let slot = FIRST_ADDRESS_SLOT; slot <= last; slot++) slots.push(slot)
  for (const slot of slots) {
    const branch = addressBranch(host, slot)
    if (
      branch &&
      bytesToHex(onFile.pubkeyXOnly) === bytesToHex(branch.pubkeyXOnly) &&
      bytesToHex(onFile.chainCode) === bytesToHex(branch.chainCode)
    ) {
      return {ownership: 'ours', slot}
    }
  }
  return {ownership: 'not-ours'}
}

export const checkAddressOwnership = async (
  server: string,
  username: string
): Promise<AddressOwnership> =>
  (await resolveAddressOwnership(server, username)).ownership
