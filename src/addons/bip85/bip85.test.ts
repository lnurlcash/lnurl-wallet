import {describe, expect, it} from 'vitest'
import {
  deriveBip39Mnemonic,
  deriveHexEntropy,
  deriveWif,
  deriveXprv,
  isUsableSeedPhrase
} from './bip85'

// BIP85's own published master root key, re-expressed as the BIP39
// mnemonic that produces it - the BIP itself only ever states the xprv
// form, so this mnemonic was derived by hand once and is pinned here by
// asserting it reproduces the BIP's own "case 1"/"case 2" test vectors
// below (the deepest cross-check available without vendoring an xprv
// parser this addon has no other use for).
const BIP85_TEST_MNEMONIC =
  'install scatter logic circle pencil average fall shoe quantum disease suspect usage'

describe('isUsableSeedPhrase', () => {
  it('accepts a valid BIP39 mnemonic, rejects garbage', () => {
    expect(isUsableSeedPhrase(BIP85_TEST_MNEMONIC)).toBe(true)
    expect(isUsableSeedPhrase('not a real mnemonic at all here')).toBe(false)
    expect(isUsableSeedPhrase('')).toBe(false)
  })
})

describe('deriveBip39Mnemonic - BIP85 own test vectors', () => {
  it('12 English words (m/83696968’/39’/0’/12’/0’)', () => {
    expect(deriveBip39Mnemonic(BIP85_TEST_MNEMONIC, 12, 0)).toBe(
      'girl mad pet galaxy egg matter matrix prison refuse sense ordinary nose'
    )
  })

  it('18 English words (m/83696968’/39’/0’/18’/0’)', () => {
    expect(deriveBip39Mnemonic(BIP85_TEST_MNEMONIC, 18, 0)).toBe(
      'near account window bike charge season chef number sketch tomorrow excuse sniff circle vital hockey outdoor supply token'
    )
  })

  it('24 English words (m/83696968’/39’/0’/24’/0’)', () => {
    expect(deriveBip39Mnemonic(BIP85_TEST_MNEMONIC, 24, 0)).toBe(
      'puppy ocean match cereal symbol another shed magic wrap hammer bulb intact gadget divorce twin tonight reason outdoor destroy simple truth cigar social volcano'
    )
  })

  it('a different index produces a different, still-valid mnemonic', () => {
    const a = deriveBip39Mnemonic(BIP85_TEST_MNEMONIC, 12, 0)
    const b = deriveBip39Mnemonic(BIP85_TEST_MNEMONIC, 12, 1)
    expect(a).not.toBe(b)
    expect(b?.split(' ')).toHaveLength(12)
  })

  it('rejects an unusable word count, a negative index, or an invalid seed', () => {
    expect(deriveBip39Mnemonic(BIP85_TEST_MNEMONIC, 13, 0)).toBeNull()
    expect(deriveBip39Mnemonic(BIP85_TEST_MNEMONIC, 12, -1)).toBeNull()
    expect(deriveBip39Mnemonic('not a seed', 12, 0)).toBeNull()
  })
})

describe('deriveHexEntropy - BIP85’s own test vector', () => {
  it('64 bytes (m/83696968’/128169’/64’/0’)', () => {
    expect(deriveHexEntropy(BIP85_TEST_MNEMONIC, 64, 0)).toBe(
      '492db4698cf3b73a5a24998aa3e9d7fa96275d85724a91e71aa2d645442f878555d078fd1f1f67e368976f04137b1f7a0d19232136ca50c44614af72b5582a5c'
    )
  })

  it('truncates to exactly numBytes, not the full 64-byte digest', () => {
    const hex = deriveHexEntropy(BIP85_TEST_MNEMONIC, 16, 0)
    expect(hex).toHaveLength(32)
  })

  it('rejects a numBytes outside [16, 64]', () => {
    expect(deriveHexEntropy(BIP85_TEST_MNEMONIC, 15, 0)).toBeNull()
    expect(deriveHexEntropy(BIP85_TEST_MNEMONIC, 65, 0)).toBeNull()
  })
})

describe('deriveWif - BIP85’s own test vector', () => {
  it('m/83696968’/2’/0’', () => {
    expect(deriveWif(BIP85_TEST_MNEMONIC, 0)).toBe(
      'Kzyv4uF39d4Jrw2W7UryTHwZr1zQVNk4dAFyqE6BuMrMh1Za7uhp'
    )
  })
})

describe('deriveXprv - BIP85’s own test vector', () => {
  it('m/83696968’/32’/0’', () => {
    expect(deriveXprv(BIP85_TEST_MNEMONIC, 0)).toBe(
      'xprv9s21ZrQH143K2srSbCSg4m4kLvPMzcWydgmKEnMmoZUurYuBuYG46c6P71UGXMzmriLzCCBvKQWBUv3vPB3m1SATMhp3uEjXHJ42jFg7myX'
    )
  })

  it('a different index produces a genuinely different root', () => {
    const a = deriveXprv(BIP85_TEST_MNEMONIC, 0)
    const b = deriveXprv(BIP85_TEST_MNEMONIC, 1)
    expect(a).not.toBe(b)
    expect(b?.startsWith('xprv')).toBe(true)
  })
})
