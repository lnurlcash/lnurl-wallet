// LUD-25 Part 2 onchain receiving: the SAME cp1 note pubkey this wallet
// derives for a registered SERVICE/index (see ../../cashSecrets.ts's
// cashAddressBranch/cashAddressSecretAtIndex and
// ../../lib/recoverableNotes.ts's deriveNotePubkey/deriveNoteSecretKey),
// wrapped in the standard BIP341/BIP86 key-path-only Taproot tweak so it is
// ALSO spendable as a plain bc1p... onchain output - reusing the exact
// already-tested derivation this wallet's ecash side relies on
// (recoverableNotes.test.ts cross-checks it against real lnurl-mint
// vectors), not a second, parallel derivation scheme invented for this
// addon.
//
// Reusing one keypair across two protocols this way is deliberate, not
// incidental: LUD-25 Part 2 never discloses this note's PRIVATE key to a
// mint, only a BIP-340 Schnorr signature over a fixed message (ck1 - see
// ../../lib/signature.ts), and a signature does not leak the scalar that
// produced it. The onchain side, in turn, never signs with this raw scalar
// directly either - BIP341's key-path spend requires the TWEAKED scalar
// (sk_i + tagged_hash("TapTweak", pk_i), see taprootTweakPrivKey below), a
// distinct value from sk_i itself. So a mint that has only ever seen a ck1
// signature learns nothing that lets it spend the onchain output, and an
// onchain spend of the tweaked key discloses nothing about sk_i either -
// the two sides stay cryptographically independent even though they start
// from the same note. This is exactly BIP86's own single-key convention
// (@scure/btc-signer's p2tr() with no script tree tweaks the same way),
// not a novel scheme.
//
// Like the sibling bip85/seedGenerator addons, the seed phrase here is
// page-local, holder-entered state (Renderer.tsx's 'run' mode - never
// persisted, gone on reload) - never cashSecrets.ts's real unlocked cash
// root, which this file never imports.
import {p2tr} from '@scure/btc-signer/payment.js'
import {NETWORK, taprootTweakPrivKey} from '@scure/btc-signer/utils.js'
import {createBase58check} from '@scure/base'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex} from '@noble/hashes/utils.js'
import {deriveLud25CashRootNode, isValidSeedPhrase} from '../../keys'
import {deriveDomainBranchNode} from '../../lib/branchDerivation'
import {
  deriveNotePubkey,
  deriveNoteSecretKey,
  encodeCp1
} from '../../lib/recoverableNotes'

const base58check = createBase58check(sha256)

const cleanSeedPhrase = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .toLowerCase()

const cleanDomain = (value: unknown): string => String(value ?? '').trim()

const isNonNegativeInt = (n: number): boolean => Number.isInteger(n) && n >= 0

export type OnchainReceiveResult = {
  cp1: string
  internalPubkeyHex: string
  address: string
  wif: string
}

// null on anything not yet fillable (bad seed phrase, empty domain,
// non-integer index) rather than throwing - same "live validation, no
// exceptions mid-typing" convention every other addon's own
// derive-as-you-type helper follows (see bip85.ts's own null returns)
export const deriveOnchainReceive = (
  seedPhrase: unknown,
  domain: unknown,
  index: unknown
): OnchainReceiveResult | null => {
  const phrase = cleanSeedPhrase(seedPhrase)
  if (!isValidSeedPhrase(phrase)) return null
  const d = cleanDomain(domain)
  if (!d) return null
  const i = Number(index)
  if (!isNonNegativeInt(i)) return null
  try {
    const cashRoot = deriveLud25CashRootNode(phrase)
    const branch = deriveDomainBranchNode(cashRoot, d)
    const chainCode = branch.chainCode
    const branchPubkeyXOnly = branch.publicKey?.slice(1)
    if (!branchPubkeyXOnly || !chainCode || !branch.privateKey) return null

    // the exact cp1 the mint would compute for this SERVICE + index (watch-
    // only math, identical to what a cx1 export lets the mint derive on its
    // own) - shown so a holder can cross-check "this address's key really
    // is this exact note"
    const notePubkeyXOnly = deriveNotePubkey(branchPubkeyXOnly, chainCode, i)

    // only the wallet (holder of the branch's own private key) can go this
    // direction - see deriveNoteSecretKey's own parity-handling comment in
    // recoverableNotes.ts for why this is safe to reuse as the taproot
    // internal key's spending scalar
    const noteSecretKey = deriveNoteSecretKey(branch.privateKey, chainCode, i)
    const tweakedPrivateKey = taprootTweakPrivKey(noteSecretKey)

    const {address} = p2tr(notePubkeyXOnly, undefined, NETWORK)
    if (!address) return null

    return {
      cp1: encodeCp1(notePubkeyXOnly),
      internalPubkeyHex: bytesToHex(notePubkeyXOnly),
      address,
      // mainnet (0x80), compressed (trailing 0x01) - this app has no
      // testnet concept anywhere else either (see bip85.ts's own deriveWif,
      // same convention)
      wif: base58check.encode(
        new Uint8Array([0x80, ...tweakedPrivateKey, 0x01])
      )
    }
  } catch {
    return null
  }
}
