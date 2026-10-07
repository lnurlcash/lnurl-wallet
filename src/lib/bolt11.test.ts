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
  decodeBolt11DescriptionHash,
  invoiceMatchesMetadata,
  verifyMeltPreimage,
  encodeBolt11AmountSuffix,
  decodeBolt11AmountSuffix
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

describe('bolt11 amount suffix (LUD-25 cs1 amount encoding)', () => {
  it('picks the coarsest multiplier that represents the amount exactly', () => {
    // cross-checked against lnurl-mint's own bech32m.py doctring example
    // (via the real `bolt11` Python package's msat_to_amount)
    expect(encodeBolt11AmountSuffix(1000)).toBe('10n')
    expect(encodeBolt11AmountSuffix(100_000)).toBe('1u')
    expect(encodeBolt11AmountSuffix(1_000_000_000)).toBe('10m')
    expect(encodeBolt11AmountSuffix(1)).toBe('10p')
    expect(encodeBolt11AmountSuffix(25_000)).toBe('250n')
    expect(encodeBolt11AmountSuffix(100_000_000_000)).toBe('1')
    expect(encodeBolt11AmountSuffix(0)).toBe('0')
  })

  it('round-trips through decodeBolt11AmountSuffix', () => {
    for (const msat of [1, 1000, 21_000, 100_000, 25_000, 999_999]) {
      expect(decodeBolt11AmountSuffix(encodeBolt11AmountSuffix(msat))).toBe(
        msat
      )
    }
  })

  it('rejects a non-integer or negative amount', () => {
    expect(() => encodeBolt11AmountSuffix(1.5)).toThrow()
    expect(() => encodeBolt11AmountSuffix(-1)).toThrow()
  })

  it('returns null for anything that does not parse as a suffix', () => {
    expect(decodeBolt11AmountSuffix('')).toBeNull()
    expect(decodeBolt11AmountSuffix('abc')).toBeNull()
    expect(decodeBolt11AmountSuffix('10x')).toBeNull()
    expect(decodeBolt11AmountSuffix('-10n')).toBeNull()
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

describe('bolt11 description hash (LUD-06)', () => {
  // BOLT-11's own description_hash example
  const SPEC_PR =
    'lnbc20m1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqhp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqscc6gd6ql3jrc5yzme8v4ntcewwz5cnw92tz0pc8qcuufvq7khhr8wpald05e92xw006sq94mg8v2ndf4sefvf9sygkshp5zfem29trqq2yxxz7'
  const SPEC_TEXT =
    'One piece of chocolate cake, one icecream cone, one pickle, one slice of swiss cheese, one slice of salami, one lollypop, one piece of cherry pie, one sausage, one cupcake, and one slice of watermelon'
  // one with a plain description ('d') instead
  const SPEC_PR_D =
    'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp'

  it('reads the description hash, and null for an invoice with a plain description', () => {
    expect(decodeBolt11PaymentHash(SPEC_PR)).toBe(
      '0001020304050607080900010203040506070809000102030405060708090102'
    )
    expect(decodeBolt11DescriptionHash(SPEC_PR)).toBe(
      bytesToHex(sha256(new TextEncoder().encode(SPEC_TEXT)))
    )
    expect(decodeBolt11PaymentHash(SPEC_PR_D)).toBe(
      '0001020304050607080900010203040506070809000102030405060708090102'
    )
    expect(decodeBolt11DescriptionHash(SPEC_PR_D)).toBeNull()
    expect(decodeBolt11DescriptionHash('not an invoice')).toBeNull()
  })

  it('matches only the metadata the hash commits to', () => {
    expect(invoiceMatchesMetadata(SPEC_PR, SPEC_TEXT)).toBe(true)
    expect(invoiceMatchesMetadata(SPEC_PR, SPEC_TEXT + ' ')).toBe(false)
    expect(invoiceMatchesMetadata(SPEC_PR_D, 'anything')).toBe(true)
  })
})
