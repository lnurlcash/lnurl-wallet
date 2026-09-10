import {describe, expect, it} from 'vitest'
import {
  parseMintFee,
  applyMintFee,
  withinMintFeeBand,
  grossUpForMintFee,
  canUseMintComment,
  requireMintComment,
  MIN_COMMENT_LENGTH_FOR_SECRET,
  type PayRequestCommentInfo
} from './fees'

describe('LUD-25 mint fees', () => {
  it('parses the flat and ppm components from a metadata entry', () => {
    const metadata = JSON.stringify([
      ['text/plain', 'a mint'],
      ['text/plain', 'Mint fees: 1000,2000']
    ])
    expect(parseMintFee(metadata)).toEqual({baseFeeMsat: 1000, feePpm: 2000})
  })

  it('is null for metadata with no fee entry, or invalid JSON', () => {
    expect(parseMintFee(JSON.stringify([['text/plain', 'a mint']]))).toBeNull()
    expect(parseMintFee('not json')).toBeNull()
    expect(parseMintFee('{}')).toBeNull()
  })

  it('treats an explicit 0,0 fee the same as no fee entry at all', () => {
    const metadata = JSON.stringify([['text/plain', 'Mint fees: 0,0']])
    expect(parseMintFee(metadata)).toBeNull()
  })

  it('still parses a fee with only one of the two components set', () => {
    expect(
      parseMintFee(JSON.stringify([['text/plain', 'Mint fees: 1000,0']]))
    ).toEqual({baseFeeMsat: 1000, feePpm: 0})
    expect(
      parseMintFee(JSON.stringify([['text/plain', 'Mint fees: 0,2000']]))
    ).toEqual({baseFeeMsat: 0, feePpm: 2000})
  })

  it('applies a flat fee plus a percentage of the gross amount', () => {
    const fee = {baseFeeMsat: 1000, feePpm: 2000} // 1 sat + 0.2%
    expect(applyMintFee(100_000, fee)).toBe(100_000 - 1000 - 200)
    expect(applyMintFee(0, fee)).toBe(0) // never goes negative
  })

  it('grosses up so the net amount survives the fee exactly', () => {
    const fees = [
      {baseFeeMsat: 1000, feePpm: 2000},
      {baseFeeMsat: 0, feePpm: 500_000}, // 50%, no flat component
      {baseFeeMsat: 5000, feePpm: 0}, // flat-only, no percentage
      {baseFeeMsat: 0, feePpm: 0} // no fee at all - gross-up is a no-op
    ]
    for (const fee of fees) {
      for (const net of [1, 1000, 21_000, 1_000_000]) {
        const gross = grossUpForMintFee(net, fee)
        expect(applyMintFee(gross, fee)).toBe(net)
        // and it's the *smallest* such gross - anything above it is the
        // payer handing the mint a larger fee for no extra value
        expect(applyMintFee(gross - 1, fee)).toBeLessThan(net)
      }
    }
    // the no-fee case specifically shouldn't inflate the amount at all
    expect(grossUpForMintFee(21_000, {baseFeeMsat: 0, feePpm: 0})).toBe(21_000)
  })

  it('rejects a >= 100% fee outright instead of hanging the gross-up walk', () => {
    // applyMintFee floors at 0 for these, so grossUpForMintFee's walk would
    // never reach a positive target - a hostile mint could freeze the page
    expect(
      parseMintFee(JSON.stringify([['text/plain', 'Mint fees: 0,1000000']]))
    ).toBeNull()
    expect(
      parseMintFee(JSON.stringify([['text/plain', 'Mint fees: 0,10000000']]))
    ).toBeNull()
    // just under the boundary still parses and grosses up fine
    const fee = {baseFeeMsat: 0, feePpm: 999_999}
    expect(
      parseMintFee(JSON.stringify([['text/plain', 'Mint fees: 0,999999']]))
    ).toEqual(fee)
    expect(applyMintFee(grossUpForMintFee(1000, fee), fee)).toBe(1000)
  })
})

describe('LUD-12 comment protection (LUD-25 preimage-race mitigation)', () => {
  const payInfo = (commentAllowed?: number): PayRequestCommentInfo => ({
    commentAllowed
  })

  it('requires commentAllowed to fit a hex-encoded 32-byte hash', () => {
    expect(MIN_COMMENT_LENGTH_FOR_SECRET).toBe(64)
    expect(canUseMintComment(payInfo(64))).toBe(true)
    expect(canUseMintComment(payInfo(128))).toBe(true)
    expect(canUseMintComment(payInfo(63))).toBe(false)
    expect(canUseMintComment(payInfo(0))).toBe(false)
    expect(canUseMintComment(payInfo(undefined))).toBe(false)
  })

  it('ignores a malformed commentAllowed rather than trusting it', () => {
    expect(canUseMintComment({...payInfo(), commentAllowed: '64' as any})).toBe(
      false
    )
  })

  it('refuses current mint creation without the mandatory comment capacity', () => {
    expect(() => requireMintComment(payInfo(64))).not.toThrow()
    expect(() => requireMintComment(payInfo(63))).toThrow(/commentAllowed: 64/)
    expect(() => requireMintComment(payInfo(undefined))).toThrow(
      /commentAllowed: 64/
    )
  })
})

describe('LUD-25 mint fee arithmetic at the edges', () => {
  // the fee is SERVICE's to choose, so both of these are reachable on
  // purpose by a mint that wants them to be
  it('grosses up minimally even at a fee just under 100%', () => {
    const fee = {baseFeeMsat: 3, feePpm: 999_999}
    const gross = grossUpForMintFee(1, fee)
    expect(gross).toBe(3_000_001)
    expect(applyMintFee(gross, fee)).toBe(1)
    expect(applyMintFee(gross - 1, fee)).toBe(0)
  })

  it('accepts exact-msat and whole-sat-rounded receipt fees', () => {
    const fee = {baseFeeMsat: 5000, feePpm: 1000}
    expect(withinMintFeeBand(56000, 50944, fee)).toBe(true)
    expect(withinMintFeeBand(56000, 50000, fee)).toBe(true)
    expect(withinMintFeeBand(56000, 49999, fee)).toBe(false)
    expect(withinMintFeeBand(56000, 50945, fee)).toBe(false)
  })

  it('is minimal across a sweep of hostile fees, not just near ones', () => {
    for (const feePpm of [1, 999, 500_000, 990_000, 999_000, 999_999]) {
      for (const baseFeeMsat of [0, 1, 3, 1000]) {
        const fee = {baseFeeMsat, feePpm}
        for (const net of [1, 2, 999, 21_000, 1_000_000]) {
          const gross = grossUpForMintFee(net, fee)
          expect(applyMintFee(gross, fee)).toBeGreaterThanOrEqual(net)
          expect(applyMintFee(gross - 1, fee)).toBeLessThan(net)
        }
      }
    }
  })

  it('takes no fee off a zero amount, and grosses zero up to zero', () => {
    const fee = {baseFeeMsat: 1000, feePpm: 2000}
    expect(applyMintFee(0, fee)).toBe(0)
    expect(grossUpForMintFee(0, fee)).toBe(0)
  })

  it('keeps the proportional cut exact past 2^53', () => {
    // gross * ppm leaves the safe-integer range around 100 BTC at a
    // realistic ppm, and a rounded product floors to the wrong msat.
    // BigInt is the oracle - it does the same arithmetic without losing
    // anything
    const exact = (gross: bigint, base: bigint, ppm: bigint): bigint => {
      const net = gross - base - (gross * ppm) / 1_000_000n
      return net < 0n ? 0n : net
    }
    const amounts = [
      9_990_000_000_000, // ~99.9 BTC
      12_345_678_901_234,
      100_000_000_000_000, // 1000 BTC
      2_100_000_000_000_000 // the whole supply, in msat
    ]
    for (const gross of amounts) {
      for (const feePpm of [1, 999, 100_000, 999_999]) {
        const fee = {baseFeeMsat: 0, feePpm}
        expect(applyMintFee(gross, fee)).toBe(
          Number(exact(BigInt(gross), 0n, BigInt(feePpm)))
        )
      }
    }
  })

  it('grosses up minimally at those amounts too', () => {
    const fee = {baseFeeMsat: 1000, feePpm: 100_000}
    for (const net of [9_990_000_000_000, 100_000_000_000_000]) {
      const gross = grossUpForMintFee(net, fee)
      expect(applyMintFee(gross, fee)).toBe(net)
      expect(applyMintFee(gross - 1, fee)).toBeLessThan(net)
    }
  })
})
