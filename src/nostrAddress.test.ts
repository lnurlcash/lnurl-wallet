import {describe, expect, it} from 'vitest'
import {bech32, bech32m} from '@scure/base'
import {isValidNpub} from './nostrAddress'

const validNpub = bech32.encode(
  'npub',
  bech32.toWords(new Uint8Array(32).fill(0xab))
)

describe('isValidNpub', () => {
  it('accepts a well-formed npub', () => {
    expect(isValidNpub(validNpub)).toBe(true)
  })

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(isValidNpub(`  ${validNpub.toUpperCase()}  `)).toBe(true)
  })

  it('rejects the wrong hrp', () => {
    const nsec = bech32.encode(
      'nsec',
      bech32.toWords(new Uint8Array(32).fill(0xab))
    )
    expect(isValidNpub(nsec)).toBe(false)
  })

  it('rejects the wrong payload length', () => {
    const short = bech32.encode(
      'npub',
      bech32.toWords(new Uint8Array(31).fill(0xab))
    )
    expect(isValidNpub(short)).toBe(false)
  })

  it('rejects a bech32m encoding (npub is classic bech32, not bech32m)', () => {
    const wrongChecksum = bech32m.encode(
      'npub',
      bech32m.toWords(new Uint8Array(32).fill(0xab))
    )
    expect(isValidNpub(wrongChecksum)).toBe(false)
  })

  it('rejects garbage, empty, and non-bech32 input', () => {
    expect(isValidNpub('')).toBe(false)
    expect(isValidNpub('not an npub')).toBe(false)
    expect(isValidNpub('npub1invalidchecksum')).toBe(false)
    expect(isValidNpub('alice@mint.example.com')).toBe(false)
  })
})
