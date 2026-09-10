import {describe, expect, it} from 'vitest'
import {bech32} from '@scure/base'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {
  sameInvoice,
  isPreimage,
  isBolt11Invoice,
  decodeBolt11AmountMsat,
  decodeBolt11PaymentHash,
  verifyMeltPreimage
} from './bolt11'
import {toBech32Lnurl} from './urls'

const K1 = 'a'.repeat(64)
const NOTE_URL = `https://mint.example.com/withdraw?k1=${K1}&amount=21000`

describe('preimage', () => {
  it('is 32 bytes hex', () => {
    expect(isPreimage(K1)).toBe(true)
    expect(isPreimage(` ${K1.toUpperCase()} `)).toBe(true)
    expect(isPreimage('a'.repeat(63))).toBe(false)
    expect(isPreimage('z'.repeat(64))).toBe(false)
  })
})

describe('bolt11 invoice', () => {
  it('compares invoices case-insensitively (bech32)', () => {
    expect(sameInvoice('  LNBC21N1ABC  ', 'lnbc21n1abc')).toBe(true)
    expect(sameInvoice('lnbc21n1abc', 'lnbc21n1abd')).toBe(false)
  })

  it('recognizes mainnet/testnet/regtest prefixes with and without an amount', () => {
    expect(isBolt11Invoice('lnbc1p0examplebech32data')).toBe(true)
    expect(isBolt11Invoice('lnbc210n1p0examplebech32data')).toBe(true)
    expect(isBolt11Invoice('lntb1p0examplebech32data')).toBe(true)
    expect(isBolt11Invoice('lnbcrt1p0examplebech32data')).toBe(true)
    expect(isBolt11Invoice(`  ${'LNBC1P0EXAMPLEBECH32DATA'}  `)).toBe(true)
  })

  it('rejects LNURLs and unrelated strings despite the ln prefix', () => {
    expect(isBolt11Invoice(toBech32Lnurl(NOTE_URL))).toBe(false)
    expect(isBolt11Invoice('not an invoice')).toBe(false)
    expect(isBolt11Invoice('')).toBe(false)
  })

  it('decodes the amount from each multiplier, and null without one', () => {
    // '1' never appears in bech32 data (it's the reserved separator), so
    // these use only charset-safe filler after the real separator
    expect(decodeBolt11AmountMsat('lnbc1u1p0examplebech32data')).toBe(100_000)
    expect(decodeBolt11AmountMsat('lnbc10m1p0examplebech32data')).toBe(
      1_000_000_000
    )
    expect(decodeBolt11AmountMsat('lnbc250n1p0examplebech32data')).toBe(25_000)
    expect(decodeBolt11AmountMsat('lnbc10p1p0examplebech32data')).toBe(1)
    // digits with no multiplier suffix means whole BTC
    expect(decodeBolt11AmountMsat('lnbc11p0examplebech32data')).toBe(
      100_000_000_000
    )
    // network prefix runs straight into the separator - no amount at all
    expect(decodeBolt11AmountMsat('lnbc1p0examplebech32data')).toBeNull()
    expect(decodeBolt11AmountMsat('lntb1p0examplenoamount')).toBeNull()
    expect(decodeBolt11AmountMsat('not an invoice')).toBeNull()
  })
})

describe('bolt11 payment hash', () => {
  // hand-builds a minimal-but-real bech32 invoice: [7 words timestamp]
  // [tagged field: type=1 (payment_hash) + 2-word length + data]
  // [104 words dummy signature] - exactly the layout
  // decodeBolt11PaymentHash expects, so this exercises its actual word-math
  // rather than a real invoice string that would need to be transcribed
  // from somewhere and trusted as correct
  const buildFakeInvoice = (paymentHashHex: string): string => {
    const hashWords = bech32.toWords(hexToBytes(paymentHashHex))
    const words = [
      ...new Array(7).fill(0),
      1,
      Math.floor(hashWords.length / 32),
      hashWords.length % 32,
      ...hashWords,
      ...new Array(104).fill(0)
    ]
    return bech32.encode('lnbc', words, 2048)
  }

  it('extracts the payment hash tagged field', () => {
    const hash = 'ab'.repeat(32)
    expect(decodeBolt11PaymentHash(buildFakeInvoice(hash))).toBe(hash)
  })

  it('returns null for anything that is not a valid bech32 invoice', () => {
    expect(decodeBolt11PaymentHash('not an invoice')).toBeNull()
    expect(decodeBolt11PaymentHash('lnbc1invalidchecksum')).toBeNull()
  })

  it('verifies a preimage that actually hashes to the payment hash', () => {
    const preimage = 'cd'.repeat(32)
    const hash = bytesToHex(sha256(hexToBytes(preimage)))
    expect(verifyMeltPreimage(buildFakeInvoice(hash), preimage)).toBe(true)
  })

  it('rejects a preimage that does not match the invoice', () => {
    const pr = buildFakeInvoice('ab'.repeat(32))
    expect(verifyMeltPreimage(pr, 'cd'.repeat(32))).toBe(false)
  })

  it('rejects a malformed preimage outright', () => {
    const pr = buildFakeInvoice('ab'.repeat(32))
    expect(verifyMeltPreimage(pr, 'not-hex')).toBe(false)
  })
})
