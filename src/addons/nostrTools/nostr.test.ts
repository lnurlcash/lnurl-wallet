import {describe, expect, it} from 'vitest'
import {bech32, bech32m} from '@scure/base'
import {schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {mnemonicToSeedSync} from '@scure/bip39'
import {HDKey} from '@scure/bip32'
import {
  encodeBech32,
  generateNostrKeypair,
  keypairFromPrivateKey,
  bechToHex,
  parseHexBytes,
  deriveNostrKeypair
} from './nostr'

const SEED =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('encodeBech32', () => {
  it("uses plain bech32, not bech32m (NIP-19, unlike this app's own cp1/cx1)", () => {
    const bytes = new Uint8Array(32).fill(0x11)
    const encoded = encodeBech32('npub', bytes)
    expect(encoded.startsWith('npub1')).toBe(true)
    // a real bech32 string must decode cleanly as bech32...
    expect(() =>
      bech32.decode(encoded as `${string}1${string}`, false)
    ).not.toThrow()
    // ...and must NOT also validate as bech32m (the two checksums are
    // mutually exclusive by construction) - catches an accidental
    // bech32/bech32m mixup, which NIP-19-reading software would reject
    expect(() =>
      bech32m.decode(encoded as `${string}1${string}`, false)
    ).toThrow()
  })
})

describe('generateNostrKeypair / keypairFromPrivateKey', () => {
  it('round-trips: npub/nsec decode back to the exact pubkey/privkey bytes', () => {
    const privateKey = schnorr.utils.randomSecretKey()
    const {npub, nsec} = keypairFromPrivateKey(privateKey)
    expect(npub.startsWith('npub1')).toBe(true)
    expect(nsec.startsWith('nsec1')).toBe(true)
    expect(bechToHex(nsec)).toBe(bytesToHex(privateKey))
    expect(bechToHex(npub)).toBe(bytesToHex(schnorr.getPublicKey(privateKey)))
  })

  it('generates a fresh, distinct keypair each call', () => {
    const a = generateNostrKeypair()
    const b = generateNostrKeypair()
    expect(a.nsec).not.toBe(b.nsec)
    expect(a.npub).not.toBe(b.npub)
  })
})

describe('bechToHex', () => {
  it('decodes a known npub back to its 32-byte hex payload', () => {
    const pubkey = schnorr.getPublicKey(schnorr.utils.randomSecretKey())
    const npub = encodeBech32('npub', pubkey)
    expect(bechToHex(npub)).toBe(bytesToHex(pubkey))
  })

  it('is generic - decodes any well-formed bech32 value, not just npub/nsec', () => {
    const encoded = encodeBech32('note', new Uint8Array(32).fill(0xab))
    expect(bechToHex(encoded)).toBe('ab'.repeat(32))
  })

  it('returns null (never throws) for garbage input', () => {
    expect(bechToHex('not bech32 at all')).toBeNull()
    expect(bechToHex('')).toBeNull()
    expect(bechToHex('npub1invalidchecksum')).toBeNull()
  })
})

describe('parseHexBytes', () => {
  it('parses valid even-length hex', () => {
    const bytes = parseHexBytes('ab'.repeat(32))
    expect(bytes).toHaveLength(32)
  })

  it('rejects odd-length or non-hex input without throwing', () => {
    expect(parseHexBytes('abc')).toBeNull()
    expect(parseHexBytes('zz'.repeat(16))).toBeNull()
    expect(parseHexBytes('')).toBeNull()
  })
})

describe('deriveNostrKeypair (NIP-06)', () => {
  it("matches a direct m/44'/1237'/<account>'/0/0 derivation off the same seed", () => {
    const master = HDKey.fromMasterSeed(mnemonicToSeedSync(SEED))
    const expectedNode = master.derive("m/44'/1237'/0'/0/0")
    const result = deriveNostrKeypair(SEED, 0)
    expect(result).not.toBeNull()
    expect(hexToBytes(bechToHex(result!.nsec)!)).toEqual(
      expectedNode.privateKey
    )
  })

  it('is deterministic for the same seed and account', () => {
    const a = deriveNostrKeypair(SEED, 0)
    const b = deriveNostrKeypair(SEED, 0)
    expect(a).toEqual(b)
  })

  it('differs per account index', () => {
    const a = deriveNostrKeypair(SEED, 0)!
    const b = deriveNostrKeypair(SEED, 1)!
    expect(a.nsec).not.toBe(b.nsec)
    expect(a.npub).not.toBe(b.npub)
  })

  it('is null for an invalid seed phrase', () => {
    expect(deriveNostrKeypair('not a real seed phrase', 0)).toBeNull()
    expect(deriveNostrKeypair('', 0)).toBeNull()
  })
})
