import {cashAddressBranch, addressSecretAtIndex} from './cashSecrets'
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
  NOTE_PURPOSE_LIGHTNING_ADDRESS
} from './lnurlcash'
import {gapLimit} from './gapLimit'
import {msatToSats} from './helpers'
import {markAddressScanned} from './addressRegistry'
import type {Bearer, ActivityKind} from './storage'
import type {NewBearer} from './WalletContext'

// LUD-25 counterpart to recovery.ts's scanMintForNotes - same shape,
// same dedup convention (existing bearers checked by serverOf+noteK1, see
// receive.ts), but scans a REGISTERED address's own watch-only branch
// (cashSecrets.ts's cashAddressBranch) at NOTE_PURPOSE_LIGHTNING_ADDRESS -
// a separate counter from recovery.ts's own NOTE_PURPOSE_WALLET/
// NOTE_PURPOSE_CHANGE scans of that same branch - via the public-commitment
// lookup (src/lib/addresses.ts's scanForAddressNotes) rather than
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
  // LUD-25's text/xpub metadata, see mintRequest.ts's
  // PayRequestInfo.internalTransfer) - null when SERVICE didn't advertise
  // one, or this pass never got far enough to learn it. Purely
  // informational: resolveScanStartIndex already decided how (or whether)
  // to use it: never trust this alone as "already recovered."
  serviceHint: number | null
  // resume floor for the NEXT incremental "check notes" pass, as opposed
  // to a full "rescan all" (startIndex: 0) - the higher of: whatever floor
  // the caller already passed in (never regresses below what's already
  // been checked) and this scan's own highest found index + 1. Always
  // present, even on an error before any of that was learned, so a caller
  // can feed it straight back into addressRegistry.ts's markAddressScanned
  // unconditionally
  nextScanIndex: number
  error?: string
}

export const scanRegisteredAddress = async (
  server: string,
  username: string,
  existing: Bearer[] = [],
  opts: {startIndex?: number} = {}
): Promise<AddressScanOutcome> => {
  const startFloor = opts.startIndex ?? 0
  // cashAddressBranch/cashAddressSecretAtIndex derive under the bare host
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
      nextScanIndex: startFloor,
      error: 'Not a valid mint address.'
    }
  }
  const branch = cashAddressBranch(host)
  if (!branch) {
    return {
      server,
      username,
      recovered: [],
      highestIndex: null,
      checkedFrom: startFloor,
      serviceHint: null,
      nextScanIndex: startFloor,
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
      nextScanIndex: startFloor,
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
        nextScanIndex: startFloor,
        error: 'This mint does not advertise LNURLcash minting.'
      }
    }
    withdrawUrl = fromLud17(info.withdrawLink)
    serviceHint = info.internalTransfer?.startIndex ?? null
    // see resolveScanStartIndex's own doc comment (src/lib/addresses.ts) for
    // why this must never trust SERVICE's hint to skip a fresh scan (or an
    // explicit "full rescan", which always calls this with startIndex: 0)
    // past index 0 - the regression this guards against is documented there
    startIndex = resolveScanStartIndex(startFloor, serviceHint ?? undefined)
  } catch (err) {
    return {
      server,
      username,
      recovered: [],
      highestIndex: null,
      checkedFrom: startFloor,
      serviceHint: null,
      nextScanIndex: startFloor,
      error: (err as Error).message
    }
  }

  const recovered: NewBearer[] = []
  let highestIndex: number | null = null
  const limit = gapLimit()
  try {
    const results = await scanForAddressNotes(
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
        onFound: result => {
          highestIndex = Math.max(highestIndex ?? -1, result.index)
        }
      }
    )
    for (const result of results) {
      const secretKey = addressSecretAtIndex(host, result.index)
      // the cash root can only disappear mid-scan if the wallet locked
      // while it was running - skip rather than crash; a re-scan once
      // unlocked again picks this index right back up
      if (!secretKey) continue
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
        result.info.sig
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
          mintPubkey: result.info.mintPubkey
        })
      }
    }
  } catch (err) {
    return {
      server,
      username,
      recovered,
      highestIndex,
      checkedFrom: startIndex,
      serviceHint,
      nextScanIndex: Math.max(startIndex, (highestIndex ?? -1) + 1),
      error: (err as Error).message
    }
  }

  return {
    server,
    username,
    recovered,
    checkedFrom: startIndex,
    serviceHint,
    highestIndex,
    nextScanIndex: Math.max(startIndex, (highestIndex ?? -1) + 1)
  }
}

export type AddressScanWalletOps = {
  addBearer: (note: NewBearer) => Promise<unknown>
  logActivity: (kind: ActivityKind, message: string, label?: string) => void
}

// runs scanRegisteredAddress and actually claims anything it finds into
// the wallet (addBearer + activity log) - the one piece every caller
// (AddressDialog's "check notes"/"full rescan", AddressAutoScanner's
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
  opts: {startIndex?: number} = {}
): Promise<AddressScanOutcome> => {
  const result = await scanRegisteredAddress(server, username, existing, opts)
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
