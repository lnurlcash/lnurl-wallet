import {describe, expect, it} from 'vitest'
import {decodeCw1} from '../../lib/recoverableNotes'
import {
  LOCKTIME_THRESHOLD,
  NUMS_INTERNAL_KEY_HEX,
  TIMELOCK_SEQUENCE,
  buildRedeemCw1,
  dateProblem,
  dateToLocktime,
  outputKeyOfSecret,
  planTimelock,
  secretOfLink,
  unlockTimeOfSecret
} from './timelock'
import {tweakPubkey, verifyScriptPath} from '../taproot/taproot'

const NOW = 1_800_000_000
const at = (seconds: number): string =>
  // datetime-local wants local wall time; build it from a local Date
  new Date(seconds * 1000)
    .toLocaleString('sv-SE', {hour12: false})
    .replace(' ', 'T')
    .slice(0, 16)

describe('timerlocker date handling', () => {
  it('rejects empty, past and too-soon dates', () => {
    expect(dateProblem('', NOW)).not.toBe('')
    expect(dateProblem('garbage', NOW)).not.toBe('')
    expect(dateProblem(at(NOW - 86400), NOW)).not.toBe('')
    expect(dateProblem(at(NOW + 5), NOW)).not.toBe('')
  })
  it('accepts a date well in the future', () => {
    expect(dateProblem(at(NOW + 86400), NOW)).toBe('')
    expect(dateToLocktime(at(NOW + 86400))).toBeGreaterThan(NOW)
  })
  it('never treats a block height as a time', () => {
    expect(dateProblem('1970-01-02T00:00', 0)).not.toBe('')
    expect(LOCKTIME_THRESHOLD).toBe(500_000_000)
  })
})

describe('planTimelock', () => {
  const when = at(NOW + 7 * 86400)
  const plan = planTimelock(when, NOW)

  it('derives the same key and time back from the secret', () => {
    expect(plan.secret).toMatch(/^[0-9a-f]{72}$/)
    expect(outputKeyOfSecret(plan.secret)).toBe(plan.outputKeyHex)
    expect(unlockTimeOfSecret(plan.secret)).toBe(plan.locktime)
  })
  it('uses a fresh key every time', () => {
    const other = planTimelock(when, NOW)
    expect(other.secret).not.toBe(plan.secret)
    expect(other.outputKeyHex).not.toBe(plan.outputKeyHex)
  })
  it('refuses to plan an invalid date', () => {
    expect(() => planTimelock('', NOW)).toThrow()
    expect(() => planTimelock(at(NOW - 1000), NOW)).toThrow()
  })
  it('rejects malformed or out-of-range secrets', () => {
    expect(outputKeyOfSecret('nonsense')).toBeNull()
    expect(outputKeyOfSecret('00'.repeat(36))).toBeNull()
    // a block-height locktime (< 500M) must never be accepted
    expect(outputKeyOfSecret(plan.secret.slice(0, 64) + '00000064')).toBeNull()
  })
})

describe('buildRedeemCw1', () => {
  const plan = planTimelock(at(NOW + 86400), NOW)
  const cw1 = decodeCw1(buildRedeemCw1(plan.secret, 20_000_000))!

  it('claims exactly the unlock time and a non-final sequence', () => {
    expect(cw1.locktime).toBe(plan.locktime)
    expect(cw1.sequence).toBe(TIMELOCK_SEQUENCE)
  })
  it('carries one 64-byte Schnorr signature', () => {
    expect(cw1.witness).toHaveLength(1)
    expect(cw1.witness[0]!.length).toBe(64)
  })
  it('commits to the locked output key under the NUMS internal key', () => {
    expect(
      tweakPubkey(NUMS_INTERNAL_KEY_HEX, [cw1.script]).tweakedPubkeyHex
    ).toBe(plan.outputKeyHex)
    expect(
      verifyScriptPath(plan.outputKeyHex, {
        script: cw1.script,
        controlBlock: cw1.controlBlock
      })
    ).toBe(true)
  })
  it('signs the amount, so a different amount gives a different signature', () => {
    const other = decodeCw1(buildRedeemCw1(plan.secret, 20_000_001))!
    expect(other.witness[0]).not.toEqual(cw1.witness[0])
  })
  it('throws on a malformed secret', () => {
    expect(() => buildRedeemCw1('nope', 1000)).toThrow()
  })
})

describe('secretOfLink', () => {
  it('reads the tl param and tolerates garbage', () => {
    expect(secretOfLink('https://m.test/w?sig=x&tl=abc')).toBe('abc')
    expect(secretOfLink('https://m.test/w')).toBe('')
    expect(secretOfLink('not a url')).toBe('')
  })
})
