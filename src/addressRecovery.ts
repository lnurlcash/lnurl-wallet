import {cashAddressBranch, cashAddressSecretAtIndex} from './cashSecrets'
import {
  resolveMintInput,
  fetchPayRequest,
  fromLud17,
  serverOf,
  noteK1,
  withNewK1,
  scanForAddressNotes,
  encodeCk1,
  signNoteOwnership
} from './lnurlcash'
import {gapLimit} from './gapLimit'
import {msatToSats} from './helpers'
import {markAddressScanned} from './addressRegistry'
import type {Bearer, ActivityKind} from './storage'
import type {NewBearer} from './WalletContext'

// LUD-25 Part 2 counterpart to recovery.ts's scanMintForNotes - same shape,
// same dedup convention (existing bearers checked by serverOf+noteK1, see
// receive.ts), but scans a REGISTERED address's own watch-only branch
// (cashSecrets.ts's cashAddressBranch) via the public-commitment lookup
// (src/lib/addresses.ts's scanForAddressNotes) rather than re-deriving
// legacy hash-based secrets. Every note this finds signs its own ck1 on
// the spot (signNoteOwnership) - the scan itself never redeems anything,
// it only proves this wallet CAN.

export type AddressScanOutcome = {
  server: string
  username: string
  recovered: NewBearer[]
  // highest index this scan actually found a note at - null when nothing
  // was found this pass (still may be non-null from an EARLIER pass - see
  // nextScanIndex, which tracks that across calls even when this one finds
  // nothing new)
  highestIndex: number | null
  // resume floor for the NEXT incremental "check notes" pass, as opposed
  // to a full "rescan all" (startIndex: 0) - the higher of: whatever floor
  // the caller already passed in (never regresses below what's already
  // been checked), this scan's own highest found index + 1, and SERVICE's
  // own advertised next-index hint (LUD-25 Part 2's text/xpub metadata,
  // see mintRequest.ts's PayRequestInfo.internalTransfer). Always present,
  // even on an error before any of that was learned, so a caller can feed
  // it straight back into addressRegistry.ts's markAddressScanned
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
  const branch = cashAddressBranch(server)
  if (!branch) {
    return {
      server,
      username,
      recovered: [],
      highestIndex: null,
      nextScanIndex: startFloor,
      error:
        'No seed-derived key is loaded for this wallet - restore or re-enter your seed first.'
    }
  }

  let host: string
  try {
    host = new URL(server).host
  } catch {
    return {
      server,
      username,
      recovered: [],
      highestIndex: null,
      nextScanIndex: startFloor,
      error: 'Not a valid mint address.'
    }
  }
  const payUrl = resolveMintInput(`${username}@${host}`)
  if (!payUrl) {
    return {
      server,
      username,
      recovered: [],
      highestIndex: null,
      nextScanIndex: startFloor,
      error: 'Not a recognizable mint address.'
    }
  }

  let withdrawUrl: string
  let startIndex = startFloor
  try {
    const info = await fetchPayRequest(payUrl)
    if (!info.withdrawLink) {
      return {
        server,
        username,
        recovered: [],
        highestIndex: null,
        nextScanIndex: startFloor,
        error: 'This mint does not advertise LNURLcash minting.'
      }
    }
    withdrawUrl = fromLud17(info.withdrawLink)
    // SERVICE's own best-known next-unused index (if it advertised one) -
    // only ever raises the floor, never lowers it below what this device
    // already confirmed for itself
    startIndex = Math.max(startFloor, info.internalTransfer?.startIndex ?? 0)
  } catch (err) {
    return {
      server,
      username,
      recovered: [],
      highestIndex: null,
      nextScanIndex: startFloor,
      error: (err as Error).message
    }
  }

  const recovered: NewBearer[] = []
  let highestIndex: number | null = null
  try {
    const results = await scanForAddressNotes(withdrawUrl, branch, {
      gapLimit: gapLimit(),
      startIndex,
      onFound: result => {
        highestIndex = result.index
      }
    })
    for (const result of results) {
      const secretKey = cashAddressSecretAtIndex(server, result.index)
      // the cash root can only disappear mid-scan if the wallet locked
      // while it was running - skip rather than crash; a re-scan once
      // unlocked again picks this index right back up
      if (!secretKey) continue
      const ck1 = encodeCk1(signNoteOwnership(secretKey))
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
        b => serverOf(b.url) === serverOf(url) && noteK1(b.url) === ck1
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
      nextScanIndex: Math.max(startIndex, (highestIndex ?? -1) + 1),
      error: (err as Error).message
    }
  }

  return {
    server,
    username,
    recovered,
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
// (Address.tsx's manual scan, Mint.tsx's per-mint "check notes"/"rescan
// all", AddressAutoScanner's periodic tick) needs identically. Always
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
