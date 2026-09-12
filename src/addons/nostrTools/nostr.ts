// Nostr (NIP-01/NIP-06/NIP-19) key math - pure, no addon-framework
// dependency, so it's directly unit-testable (mirrors raffle/lottery.ts's
// own split between "the math" and manifest.ts's "the addon wiring").
// Entirely independent of this wallet's own LUD-25 derivation: a
// different curve encoding (BIP-340 x-only, same as this wallet's own
// note pubkeys, but under Nostr's own NIP-01 meaning), a different bech32
// HRP set, and - for the BIP32 path below - plain unmodified BIP32,
// never this wallet's own taproot-style per-note tweak.
import {bech32} from '@scure/base'
import {schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {mnemonicToSeedSync} from '@scure/bip39'
import {HDKey} from '@scure/bip32'
import {isValidSeedPhrase} from '../../keys'

export const NPUB_HRP = 'npub'
export const NSEC_HRP = 'nsec'

// NIP-19 uses plain bech32 (BIP-173), not bech32m - unlike this wallet's
// own cp1/ck1/cx1 encoding (LUD-25 Part 2) or LUD-01's own bech32 LNURL,
// easy to mix up since both live right next to bech32m elsewhere in this
// app. 32 bytes (a pubkey or privkey) fits well within bech32's own
// default ~90-character limit, so no length override is needed the way
// LUD-01's own longer payload needs one.
export const encodeBech32 = (hrp: string, bytes: Uint8Array): string =>
  bech32.encode(hrp, bech32.toWords(bytes))

export type NostrKeypair = {npub: string; nsec: string}

export const keypairFromPrivateKey = (
  privateKey: Uint8Array
): NostrKeypair => ({
  // Nostr's own pubkey format (NIP-01) is already the exact x-only 32
  // bytes BIP-340 Schnorr signing uses - no compressed-key prefix to
  // strip, unlike this wallet's own HDKey.publicKey elsewhere
  npub: encodeBech32(NPUB_HRP, schnorr.getPublicKey(privateKey)),
  nsec: encodeBech32(NSEC_HRP, privateKey)
})

export const generateNostrKeypair = (): NostrKeypair =>
  keypairFromPrivateKey(schnorr.utils.randomSecretKey())

// decodes ANY well-formed bech32 string to its raw payload as hex -
// generic (not restricted to npub/nsec's own HRPs), so it doubles as a
// plain bech32-to-hex tool for other Nostr bech32 values (note1, nprofile1,
// ...) or anything else bech32-encoded pasted in. Never throws.
export const bechToHex = (value: string): string | null => {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed || !trimmed.includes('1')) return null
  try {
    const decoded = bech32.decode(trimmed as `${string}1${string}`, false)
    return bytesToHex(bech32.fromWords(decoded.words))
  } catch {
    return null
  }
}

export const parseHexBytes = (value: string): Uint8Array | null => {
  const trimmed = value.trim().toLowerCase()
  if (!/^[0-9a-f]+$/.test(trimmed) || trimmed.length % 2 !== 0) return null
  try {
    return hexToBytes(trimmed)
  } catch {
    return null
  }
}

// NIP-06: basic key derivation from a BIP39 mnemonic seed phrase, at the
// fixed path m/44'/1237'/<account>'/0/0 - plain BIP32 all the way down (no
// taproot-style tweak the way this wallet's own LUD-25 Part 2 derivation
// needs), so the derived node's own private key IS the Nostr private key
// directly.
export const deriveNostrKeypair = (
  seedPhrase: string,
  accountIndex: number
): NostrKeypair | null => {
  const seed = seedPhrase.trim()
  if (!seed || !isValidSeedPhrase(seed)) return null
  const account = Math.max(0, Math.floor(accountIndex || 0))
  const master = HDKey.fromMasterSeed(mnemonicToSeedSync(seed))
  const node = master.derive(`m/44'/1237'/${account}'/0/0`)
  return node.privateKey ? keypairFromPrivateKey(node.privateKey) : null
}
