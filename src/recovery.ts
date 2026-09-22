import {cashAddressBranch, cashAddressSecretAtIndex} from './cashSecrets'
import {
  resolveMintInput,
  fetchPayRequest,
  withNewK1,
  serverOf,
  noteK1,
  scanForAddressNotes,
  encodeCk1,
  signNoteOwnership
} from './lnurlcash'
import {gapLimit} from './gapLimit'
import type {Bearer} from './storage'

// LUD-25 "Seed & derivation" (25.md) recovery, scoped to a mint directly
// (as opposed to addressRecovery.ts's scanRegisteredAddress, which resolves
// a registered username@host first) - this is the spec's own general
// recovery paragraph: "WALLET re-derives pk_0, pk_1, ... for each known
// SERVICE and, for each, GETs the withdraw LNURL with ?p=cp1<pk_i>", so a
// lost/reinstalled wallet can reconstruct any Part 2 note it minted directly
// from nothing but the seed phrase and a list of mints to try. There is no
// way to discover *which* mints to scan from the seed alone (a domain name
// isn't recoverable from an HMAC over it) - the holder has to supply that
// list themselves (Setup.tsx's restore flow), picking from known public
// mints or typing an address by hand.
//
// Only ever finds notes whose secret was actually derived on this wallet's
// own cx1 branch to begin with - nothing here recovers a Part 1 note
// (generateNoteSecret/generateMintSecret are plain, non-seed-derived
// randomness - see cashSecrets.ts's own header comment for why) or one
// accepted from a third party.

export type RecoveredNote = {
  url: string
  callback: string
  amount: number
  verified: true
  mintPubkey?: string
}

export type MintScanResult = {
  server: string
  recovered: RecoveredNote[]
  // highest index this scan confirmed was ever used (live or spent) - null
  // when nothing was ever found. The caller should bump this domain's
  // stored next-index counter (cashSecrets.ts's mergeCashAddressSecretIndices)
  // past it, so a note this wallet mints here next never reuses an index a
  // past incarnation already consumed.
  highestUsedIndex: number | null
  // set when the scan stopped on something other than hitting the gap
  // limit (an unresolvable address, no LNURLcash support, a request
  // failure) - recovered/highestUsedIndex still reflect whatever was
  // confirmed before that happened
  error?: string
}

// scans one mint (a public-mint entry, a Lightning Address, a bech32 LNURL,
// or a bare domain - anything resolveMintInput already accepts) for
// recoverable Part 2 notes, via the shared gap-limit primitive
// (scanForAddressNotes) addressRecovery.ts also builds on. onProgress, when
// given, is called with each index right before it's probed, so a caller
// can show live scanning progress. existing (the wallet's current bearers,
// same shape as receive.ts's own dedup) is checked so an index still held
// under this wallet's own record for it isn't handed back to the caller as
// "recovered" a second time - it still counts toward highestUsedIndex
// exactly as if it had been, since the index really was used.
export const scanMintForNotes = async (
  input: string,
  onProgress?: (index: number) => void,
  existing: Bearer[] = []
): Promise<MintScanResult> => {
  const payUrl = resolveMintInput(input)
  if (!payUrl) {
    return {
      server: input.trim(),
      recovered: [],
      highestUsedIndex: null,
      error: 'Not a recognizable mint address or LNURL.'
    }
  }
  const server = serverOf(payUrl)

  const branch = cashAddressBranch(server)
  if (!branch) {
    return {
      server,
      recovered: [],
      highestUsedIndex: null,
      error:
        'No seed-derived key is loaded for this wallet - restore your seed again first.'
    }
  }

  let withdrawLink: string
  try {
    const info = await fetchPayRequest(payUrl)
    if (!info.withdrawLink) {
      return {
        server,
        recovered: [],
        highestUsedIndex: null,
        error: 'This mint does not advertise LNURLcash minting.'
      }
    }
    withdrawLink = info.withdrawLink
  } catch (err) {
    return {
      server,
      recovered: [],
      highestUsedIndex: null,
      error: (err as Error).message
    }
  }

  const recovered: RecoveredNote[] = []
  let highestUsedIndex: number | null = null
  try {
    // built directly in onFound (not batched after scanForAddressNotes
    // returns) so a later index's transport failure can't discard an
    // earlier one already found this same pass - the caller still gets
    // back whatever was confirmed before the error (see the catch below)
    await scanForAddressNotes(withdrawLink, branch, {
      gapLimit: gapLimit(),
      // re-verifies gapLimit indices below the start floor too - a no-op
      // today (this scan always starts at 0, so there is nothing behind it
      // to check), but keeps this in lockstep with addressRecovery.ts's
      // scanRegisteredAddress if a resume floor is ever added here too -
      // see scanForAddressNotes' own doc comment
      checkBehind: true,
      onProgress,
      onSpent: index => {
        highestUsedIndex = Math.max(highestUsedIndex ?? -1, index)
      },
      onFound: result => {
        highestUsedIndex = Math.max(highestUsedIndex ?? -1, result.index)
        const secretKey = cashAddressSecretAtIndex(server, result.index)
        // the cash root can only disappear mid-scan if the wallet locked
        // while it was running - skip rather than crash; a re-scan once
        // unlocked again picks this index right back up
        if (!secretKey) return
        const {pubkeyXOnly, signature} = signNoteOwnership(secretKey)
        const ck1 = encodeCk1(pubkeyXOnly, signature)
        // attach an already-disclosed offline-verification sig immediately
        // (see WithdrawRequestInfo's own comment) rather than requiring a
        // separate rotate/refresh afterward just to obtain one
        const url = withNewK1(
          withdrawLink,
          ck1,
          result.info.maxWithdrawable,
          result.info.sig
        )
        const alreadyHeld = existing.some(
          b => serverOf(b.url) === server && noteK1(b.url) === ck1
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
    })
  } catch (err) {
    return {
      server,
      recovered,
      highestUsedIndex,
      error: (err as Error).message
    }
  }

  return {server, recovered, highestUsedIndex}
}
