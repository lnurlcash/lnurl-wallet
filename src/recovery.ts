import {schnorr} from '@noble/curves/secp256k1.js'
import {
  hasCashRoot,
  cashAddressSecretAtIndex,
  changeSecretAtIndex,
  legacySecretAtIndex
} from './cashSecrets'
import {
  resolveMintInput,
  fetchPayRequest,
  withNewK1,
  serverOf,
  noteK1,
  scanForAddressNotes,
  encodeCk1,
  signNoteOwnership,
  k1SpendsNote,
  LEGACY_NOTE_PURPOSE_WALLET,
  LEGACY_NOTE_PURPOSE_CHANGE
} from './lnurlcash'
import {gapLimit} from './gapLimit'
import type {Bearer} from './storage'

// LUD-26 recovery, scoped to a mint directly (as opposed to
// addressRecovery.ts's scanRegisteredAddress, which resolves a registered
// username@host first): the wallet re-derives the notes S/0'/0/i and
// S/0'/1/i for each known SERVICE and GETs the withdraw LNURL with
// ?p=cp1<Q_i> for each, stopping after a gap limit of unused ones (a burned
// note, answered "already in use", is used), so a
// lost/reinstalled wallet can reconstruct any key-path note it minted directly
// from nothing but the seed phrase and a list of mints to try. There is no
// way to discover *which* mints to scan from the seed alone (a domain name
// isn't recoverable from an HMAC over it) - the holder has to supply that
// list themselves (Setup.tsx's restore flow), picking from known public
// mints or typing an address by hand.
//
// Only ever finds notes whose secret was actually derived on this wallet's
// own seed to begin with - nothing here recovers a bearer note
// (generateNoteSecret/generateMintSecret are plain, non-seed-derived
// randomness - see cashSecrets.ts's own header comment for why) or one
// accepted from a third party. A third pass sweeps what a version of this
// wallet from before LUD-26 left on the superseded tweak scheme
// (cashSecrets.ts's legacySecretAtIndex): those notes are recovered like any
// other, and a rotate moves them onto the new chains.

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
  // highest index this scan confirmed was ever used (live or spent) on the
  // wallet chain - null when nothing was ever found there. The
  // caller should bump this domain's stored next-index counter
  // (cashSecrets.ts's mergeCashAddressSecretIndices) past it, so a note
  // this wallet mints here next never reuses an index a past incarnation
  // already consumed.
  highestUsedIndex: number | null
  // the change-chain counterpart to highestUsedIndex above - a split's own
  // change notes are a separate counter and so need their own high-water
  // mark, bumped via
  // mergeCashChangeSecretIndices instead.
  highestUsedChangeIndex: number | null
  // set when the scan stopped on something other than hitting the gap
  // limit (an unresolvable address, no LNURLcash support, a request
  // failure) - recovered/highestUsedIndex/highestUsedChangeIndex still
  // reflect whatever was confirmed before that happened
  error?: string
}

// what a recovery scan learned about one index, for IndexMap's picture of
// it: a live note it just handed back as recovered, a live note this wallet
// already holds, a spent one, or nothing there at all
export type IndexStatus = 'recovered' | 'held' | 'spent' | 'unknown'

// one chain's worth of the scan below, against its own secret-at-index
// function and its own high-water mark
const scanChain = async (
  server: string,
  withdrawLink: string,
  secretAtIndex: (domain: string, index: number) => Uint8Array | null,
  existing: Bearer[],
  startIndex: number,
  onProgress?: (index: number) => void,
  onIndex?: (index: number, status: IndexStatus) => void
): Promise<{
  recovered: RecoveredNote[]
  highestUsedIndex: number | null
  error?: string
}> => {
  const recovered: RecoveredNote[] = []
  let highestUsedIndex: number | null = null
  try {
    // built directly in onFound (not batched after scanForAddressNotes
    // returns) so a later index's transport failure can't discard an
    // earlier one already found this same pass - the caller still gets
    // back whatever was confirmed before the error (see the catch below)
    const noteKeyAt = (index: number) => {
      const secretKey = secretAtIndex(server, index)
      if (!secretKey) throw new Error('The wallet locked during the scan.')
      return schnorr.getPublicKey(secretKey)
    }
    await scanForAddressNotes(withdrawLink, noteKeyAt, {
      gapLimit: gapLimit(),
      startIndex,
      // re-verifies gapLimit indices below a nonzero start too (a no-op
      // from 0) - same safety net as addressRecovery.ts's
      // scanRegisteredAddress, see scanForAddressNotes' own doc comment
      checkBehind: true,
      onProgress,
      onSpent: index => {
        highestUsedIndex = Math.max(highestUsedIndex ?? -1, index)
      },
      // 'found' is reported from onFound below instead, once it's known
      // whether this wallet already held it
      onOutcome: (index, outcome) => {
        if (outcome !== 'found') onIndex?.(index, outcome)
      },
      onFound: result => {
        highestUsedIndex = Math.max(highestUsedIndex ?? -1, result.index)
        const secretKey = secretAtIndex(server, result.index)
        // the cash root can only disappear mid-scan if the wallet locked
        // while it was running - skip rather than crash; a re-scan once
        // unlocked again picks this index right back up
        if (!secretKey) return
        const {pubkeyXOnly, signature} = signNoteOwnership(
          secretKey,
          withdrawLink
        )
        const ck1 = encodeCk1(pubkeyXOnly, signature)
        // attach an already-disclosed offline-verification sig immediately
        // (see WithdrawRequestInfo's own comment) rather than requiring a
        // separate rotate/refresh afterward just to obtain one
        const url = withNewK1(
          withdrawLink,
          ck1,
          result.info.maxWithdrawable,
          result.info.c
        )
        const alreadyHeld = existing.some(
          b =>
            serverOf(b.url) === serverOf(url) &&
            k1SpendsNote(noteK1(b.url), pubkeyXOnly)
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
        onIndex?.(result.index, alreadyHeld ? 'held' : 'recovered')
      }
    })
  } catch (err) {
    return {recovered, highestUsedIndex, error: (err as Error).message}
  }
  return {recovered, highestUsedIndex}
}

// scans one mint (a public-mint entry, a Lightning Address, a bech32 LNURL,
// or a bare domain - anything resolveMintInput already accepts) for
// recoverable key-path notes, via the shared gap-limit primitive
// (scanForAddressNotes) addressRecovery.ts also builds on - once for the
// wallet chain (this wallet's own mint/rotate/merge/split-result notes),
// once for the change chain (a split's own change notes), and - unless
// opts.legacy is false - once more over the superseded scheme's purposes 0
// and 1 and its pre-purpose variant, each from 0. onProgress, when given, is called with
// each index right before it's probed, and which of the two passes it
// belongs to, so a caller can show live scanning progress. opts.walletStart/
// opts.changeStart start either pass somewhere other than 0 (still
// re-checking gapLimit indices below it) - only what a pass actually finds
// ever raises highestUsedIndex/highestUsedChangeIndex, never the start
// itself. existing (the
// wallet's current bearers, same shape as receive.ts's own dedup) is
// checked so an index still held under this wallet's own record for it
// isn't handed back to the caller as "recovered" a second time - it still
// counts toward the relevant highest-used index exactly as if it had been,
// since the index really was used.
export type MintScanPass = 'wallet' | 'change' | 'legacy'

export const scanMintForNotes = async (
  input: string,
  onProgress?: (index: number, pass: MintScanPass) => void,
  existing: Bearer[] = [],
  opts: {
    walletStart?: number
    changeStart?: number
    // every index's final verdict, per pass - see IndexStatus
    onIndex?: (index: number, status: IndexStatus, pass: MintScanPass) => void
    // sweep the superseded scheme too (default true)
    legacy?: boolean
  } = {}
): Promise<MintScanResult> => {
  const payUrl = resolveMintInput(input)
  if (!payUrl) {
    return {
      server: input.trim(),
      recovered: [],
      highestUsedIndex: null,
      highestUsedChangeIndex: null,
      error: 'Not a recognizable mint address or LNURL.'
    }
  }
  const server = serverOf(payUrl)

  if (!hasCashRoot()) {
    return {
      server,
      recovered: [],
      highestUsedIndex: null,
      highestUsedChangeIndex: null,
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
        highestUsedChangeIndex: null,
        error: 'This mint does not advertise LNURLcash minting.'
      }
    }
    withdrawLink = info.withdrawLink
  } catch (err) {
    return {
      server,
      recovered: [],
      highestUsedIndex: null,
      highestUsedChangeIndex: null,
      error: (err as Error).message
    }
  }

  const wallet = await scanChain(
    server,
    withdrawLink,
    cashAddressSecretAtIndex,
    existing,
    opts.walletStart ?? 0,
    onProgress && (index => onProgress(index, 'wallet')),
    opts.onIndex && ((index, status) => opts.onIndex!(index, status, 'wallet'))
  )
  const change = await scanChain(
    server,
    withdrawLink,
    changeSecretAtIndex,
    existing,
    opts.changeStart ?? 0,
    onProgress && (index => onProgress(index, 'change')),
    opts.onIndex && ((index, status) => opts.onIndex!(index, status, 'change'))
  )

  const legacy: {recovered: RecoveredNote[]; error?: string}[] = []
  if (opts.legacy !== false) {
    for (const purpose of [
      LEGACY_NOTE_PURPOSE_WALLET,
      LEGACY_NOTE_PURPOSE_CHANGE,
      null
    ]) {
      legacy.push(
        await scanChain(
          server,
          withdrawLink,
          (domain, index) => legacySecretAtIndex(domain, purpose, index),
          existing,
          0,
          onProgress && (index => onProgress(index, 'legacy')),
          opts.onIndex &&
            ((index, status) => opts.onIndex!(index, status, 'legacy'))
        )
      )
    }
  }

  return {
    server,
    recovered: [
      ...wallet.recovered,
      ...change.recovered,
      ...legacy.flatMap(l => l.recovered)
    ],
    highestUsedIndex: wallet.highestUsedIndex,
    highestUsedChangeIndex: change.highestUsedIndex,
    error: wallet.error ?? change.error ?? legacy.find(l => l.error)?.error
  }
}
