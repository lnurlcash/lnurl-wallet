// BIP85 "Deterministic Entropy From BIP32 Keychains"
// https://github.com/bitcoin/bips/blob/master/bip-0085.mediawiki
//
// "One Seed to rule them all" - derives independent, deterministic entropy
// (a whole separate BIP39 mnemonic, raw hex bytes, a WIF private key, or an
// XPRV extended key) from a BIP32 master root, purely as a function of
// (root, application, index). Genuinely independent: nothing about the
// derived output lets anyone work backward to the root that produced it
// (that's the entire point of running the derived child key through
// HMAC-SHA512 rather than handing it out directly), so a holder can freely
// use/share a BIP85-derived seed for some other, less-trusted wallet
// without weakening their real one.
//
// This addon's OWN seed phrase field is holder-entered, page-local state
// (Renderer.tsx's 'run' mode - never persisted, gone on reload), never
// cashSecrets.ts's real unlocked cash root - same "an addon never reaches
// the real wallet seed" boundary the sibling seedGenerator addon's own
// header comment documents. A holder who wants BIP85 sub-entropy from
// their REAL wallet seed types it in here deliberately, exactly as they
// would into any other BIP85 tool (a hardware wallet, Sparrow, etc.) - this
// is a compatibility tool, not a wallet-internal derivation, so its output
// MUST match every other implementation bit-for-bit. Every application
// below is checked against the BIP's own published test vectors
// (bip85.test.ts), not just internal self-consistency.
import {HDKey, HARDENED_OFFSET} from '@scure/bip32'
import {hmac} from '@noble/hashes/hmac.js'
import {sha256, sha512} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {mnemonicToSeedSync, entropyToMnemonic} from '@scure/bip39'
import {wordlist} from '@scure/bip39/wordlists/english.js'
import {createBase58check} from '@scure/base'
import {isValidSeedPhrase} from '../../keys'

const BIP85_PURPOSE = 83696968

// HDKey.deriveChild takes a raw BIP32 child index; every BIP85 path
// component is hardened (see the BIP's own path format, {app_no}'/
// {index}' etc.) - HARDENED_OFFSET is added here so every caller below can
// just write the plain numbers the spec itself uses
const deriveEntropy = (seedPhrase: string, appPath: number[]): Uint8Array => {
  const seed = mnemonicToSeedSync(seedPhrase.trim().toLowerCase())
  const master = HDKey.fromMasterSeed(seed)
  let node = master.deriveChild(BIP85_PURPOSE + HARDENED_OFFSET)
  for (const index of appPath) {
    node = node.deriveChild(index + HARDENED_OFFSET)
  }
  if (!node.privateKey) {
    throw new Error('Could not derive BIP85 entropy at this index.')
  }
  // "the derived key (k) is then processed with HMAC-SHA512, where the key
  // is 'bip-entropy-from-k', and the message payload is the private key k"
  return hmac(sha512, utf8ToBytes('bip-entropy-from-k'), node.privateKey)
}

const cleanSeedPhrase = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .toLowerCase()

export const isUsableSeedPhrase = (value: unknown): boolean =>
  isValidSeedPhrase(cleanSeedPhrase(value))

const isNonNegativeInt = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0

// ---- BIP39 (app 39') - an entirely separate, independent mnemonic ----

export const BIP39_WORD_COUNT_BITS: Record<number, number> = {
  12: 128,
  15: 160,
  18: 192,
  21: 224,
  24: 256
}

export const deriveBip39Mnemonic = (
  seedPhrase: unknown,
  wordCount: unknown,
  index: unknown
): string | null => {
  const phrase = cleanSeedPhrase(seedPhrase)
  if (!isValidSeedPhrase(phrase)) return null
  const words = Number(wordCount)
  const bits = BIP39_WORD_COUNT_BITS[words]
  const i = Number(index)
  if (!bits || !isNonNegativeInt(i)) return null
  try {
    // path: m/83696968'/39'/{language}'/{words}'/{index}' - language 0' is
    // English; this addon only ever offers English (matching this app's
    // own single wordlist, see keys.ts's own generateSeedPhrase)
    const entropy = deriveEntropy(phrase, [39, 0, words, i])
    return entropyToMnemonic(entropy.slice(0, bits / 8), wordlist)
  } catch {
    return null
  }
}

// ---- HEX (app 128169') - raw entropy for anything else ----

export const deriveHexEntropy = (
  seedPhrase: unknown,
  numBytes: unknown,
  index: unknown
): string | null => {
  const phrase = cleanSeedPhrase(seedPhrase)
  if (!isValidSeedPhrase(phrase)) return null
  const n = Number(numBytes)
  const i = Number(index)
  if (!Number.isInteger(n) || n < 16 || n > 64 || !isNonNegativeInt(i)) {
    return null
  }
  try {
    const entropy = deriveEntropy(phrase, [128169, n, i])
    return bytesToHex(entropy.slice(0, n))
  } catch {
    return null
  }
}

// ---- HD-Seed WIF (app 2') - a single compressed-WIF private key ----

const base58check = createBase58check(sha256)

export const deriveWif = (
  seedPhrase: unknown,
  index: unknown
): string | null => {
  const phrase = cleanSeedPhrase(seedPhrase)
  if (!isValidSeedPhrase(phrase)) return null
  const i = Number(index)
  if (!isNonNegativeInt(i)) return null
  try {
    // path: m/83696968'/2'/{index}' - "most significant 256 bits of
    // entropy as the secret exponent", mainnet (0x80), compressed (trailing
    // 0x01) - this app has no testnet concept anywhere else either
    const entropy = deriveEntropy(phrase, [2, i])
    const privateKey = entropy.slice(0, 32)
    return base58check.encode(new Uint8Array([0x80, ...privateKey, 0x01]))
  } catch {
    return null
  }
}

// ---- XPRV (app 32') - a whole new, independent BIP32 root ----

// mainnet xprv version bytes (0x0488ADE4) - see BIP32's own registered
// list; this app has no testnet concept anywhere else either (mint
// pubkeys, invoices - all mainnet-shaped), so there's no signal to ever
// emit a tprv instead
const XPRV_VERSION = hexToBytes('0488ade4')

export const deriveXprv = (
  seedPhrase: unknown,
  index: unknown
): string | null => {
  const phrase = cleanSeedPhrase(seedPhrase)
  if (!isValidSeedPhrase(phrase)) return null
  const i = Number(index)
  if (!isNonNegativeInt(i)) return null
  try {
    // path: m/83696968'/32'/{index}' - "the first 32 bytes are the chain
    // code, and the second 32 bytes are the private key" (BIP85's own
    // explicit warning: this is the REVERSE of BIP32's own xprv byte
    // order, which puts the private key first). Depth, parent fingerprint
    // and child number are all forced to zero per the spec, making this
    // look exactly like a freshly-generated, unrelated master root to
    // anything that reads it.
    const entropy = deriveEntropy(phrase, [32, i])
    const chainCode = entropy.slice(0, 32)
    const privateKey = entropy.slice(32, 64)
    const payload = new Uint8Array([
      ...XPRV_VERSION,
      0, // depth
      0,
      0,
      0,
      0, // parent fingerprint
      0,
      0,
      0,
      0, // child number
      ...chainCode,
      0, // key-type prefix (private key is always 33 bytes: 0x00 || key)
      ...privateKey
    ])
    return base58check.encode(payload)
  } catch {
    return null
  }
}
