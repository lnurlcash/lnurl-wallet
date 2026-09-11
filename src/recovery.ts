import {cashSecretAtIndex} from './cashSecrets'
import {
  resolveMintInput,
  fetchPayRequest,
  fetchNoteInfo,
  buildNoteUrl,
  serverOf,
  noteK1,
  NoteSpentError,
  NoteUnknownError
} from './lnurlcash'
import {gapLimit} from './gapLimit'
import type {Bearer} from './storage'

// LUD-25 "Seed-recoverable note secrets" recovery: cashSecrets.ts already
// derives every note secret_i this wallet ever mints/rotates/splits/merges
// deterministically from the seed plus a small per-SERVICE index
// (cashSecretAtIndex), specifically so a lost/reinstalled wallet can
// reconstruct them from nothing but the seed phrase and a list of mints to
// try - this module is that reconstruction: for a given mint, it re-derives
// secret_0, secret_1, ... and probes each with the ordinary informational
// GET, exactly as 25.md's own recovery paragraph describes: "WALLET stops
// scanning a given SERVICE after some gap limit of consecutive unknown
// indices, the same convention HD wallets already use for address
// recovery." There is no way to discover *which* mints to scan from the
// seed alone (a domain name isn't recoverable from an HMAC over it) - the
// holder has to supply that list themselves (Setup.tsx's restore flow),
// picking from known public mints or typing an address by hand.
//
// Only ever finds notes whose secret was actually seed-derived to begin
// with - nothing here recovers a note minted while unlocked without a cash
// root loaded (falls back to plain randomness, see
// lnurlcash.ts's generateNoteSecret) or one accepted from a third party.

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
  // stored next-index counter (cashSecrets.ts's mergeCashSecretIndices)
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
// recoverable notes. Sequential, one index at a time: this wallet has no
// batched informational-GET endpoint, and probing a mint's outstanding
// notes is exactly the kind of thing that shouldn't be parallelized against
// a service that didn't ask for a burst of requests. onProgress, when
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
  let consecutiveUnknown = 0
  let index = 0
  const limit = gapLimit()
  while (consecutiveUnknown < limit) {
    const secret = cashSecretAtIndex(server, index)
    if (!secret) {
      return {
        server,
        recovered,
        highestUsedIndex,
        error:
          'No seed-derived key is loaded for this wallet - restore your seed again first.'
      }
    }
    onProgress?.(index)
    try {
      const note = await fetchNoteInfo(buildNoteUrl(withdrawLink, secret))
      highestUsedIndex = index
      consecutiveUnknown = 0
      const alreadyHeld = existing.some(
        b => serverOf(b.url) === server && noteK1(b.url) === secret
      )
      if (!alreadyHeld) {
        recovered.push({
          url: buildNoteUrl(withdrawLink, secret, note.maxWithdrawable),
          callback: note.callback,
          amount: note.maxWithdrawable,
          verified: true,
          mintPubkey: note.mintPubkey
        })
      }
    } catch (err) {
      if (err instanceof NoteSpentError) {
        // proves this index was used at some point, even though there's
        // nothing left to recover from it - doesn't count toward the gap
        highestUsedIndex = index
        consecutiveUnknown = 0
      } else if (err instanceof NoteUnknownError) {
        consecutiveUnknown++
      } else {
        // a transport failure or anything else unclassified is no evidence
        // either way (see lnurlcash.ts's classifyNoteError) - stop rather
        // than guess, so a network blip can't silently truncate the scan
        // via the gap counter or get miscounted as a real gap
        return {
          server,
          recovered,
          highestUsedIndex,
          error: (err as Error).message
        }
      }
    }
    index++
  }
  return {server, recovered, highestUsedIndex}
}
