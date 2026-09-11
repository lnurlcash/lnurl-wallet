import {cashAddressBranch, cashAddressSecretAtIndex} from './cashSecrets'
import {
  resolveMintInput,
  fetchPayRequest,
  fromLud17,
  serverOf,
  noteK1,
  buildNoteUrl,
  scanForAddressNotes,
  encodeCk1,
  signNoteOwnership
} from './lnurlcash'
import {gapLimit} from './gapLimit'
import type {Bearer} from './storage'
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
  // was found. Purely informational today (there is no per-address
  // "next index" counter to bump the way legacy cashSecretAtIndex has one -
  // a registered address's notes are always mint-derived, never
  // wallet-claimed ahead of time, so there is nothing here to reserve)
  highestIndex: number | null
  error?: string
}

export const scanRegisteredAddress = async (
  server: string,
  username: string,
  existing: Bearer[] = []
): Promise<AddressScanOutcome> => {
  const branch = cashAddressBranch(server)
  if (!branch) {
    return {
      server,
      username,
      recovered: [],
      highestIndex: null,
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
      error: 'Not a recognizable mint address.'
    }
  }

  let withdrawUrl: string
  try {
    const info = await fetchPayRequest(payUrl)
    if (!info.withdrawLink) {
      return {
        server,
        username,
        recovered: [],
        highestIndex: null,
        error: 'This mint does not advertise LNURLcash minting.'
      }
    }
    withdrawUrl = fromLud17(info.withdrawLink)
  } catch (err) {
    return {
      server,
      username,
      recovered: [],
      highestIndex: null,
      error: (err as Error).message
    }
  }

  const recovered: NewBearer[] = []
  let highestIndex: number | null = null
  try {
    const results = await scanForAddressNotes(withdrawUrl, branch, {
      gapLimit: gapLimit(),
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
      const url = buildNoteUrl(withdrawUrl, ck1, result.info.maxWithdrawable)
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
      error: (err as Error).message
    }
  }

  return {server, username, recovered, highestIndex}
}
