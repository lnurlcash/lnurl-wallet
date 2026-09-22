import {describe, expect, it} from 'vitest'
import {decodeCw1} from '../../lib/recoverableNotes'
import {
  LOCKTIME_THRESHOLD,
  NUMS_INTERNAL_KEY_HEX,
  TIMELOCK_SEQUENCE,
  dateProblem,
  dateToLocktime,
  planTimelock
} from './timelock'
import {tweakPubkey, verifyScriptPath} from '../taproot/taproot'

const NOW = 1_800_000_000
const AMOUNT_MSAT = 20_000_000
const at = (seconds: number): string =>
  // datetime-local wants local wall time; build it from a local Date
  new Date(seconds * 1000)
    .toLocaleString('sv-SE', {hour12: false})
    .replace(' ', 'T')
    .slice(0, 16)

describe('timelocker date handling', () => {
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
  const plan = planTimelock(when, AMOUNT_MSAT, NOW)

  it('produces a ready-to-spend cw1 for exactly this amount and date', () => {
    const cw1 = decodeCw1(plan.cw1)!
    expect(cw1.locktime).toBe(plan.locktime)
    expect(cw1.sequence).toBe(TIMELOCK_SEQUENCE)
    expect(cw1.witness).toHaveLength(1)
    expect(cw1.witness[0]!.length).toBe(64) // one Schnorr signature, nothing else
  })
  it('commits the cw1 to exactly the locked output key, under the NUMS internal key', () => {
    const cw1 = decodeCw1(plan.cw1)!
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
  it('draws a fresh throwaway key every time - never returns it', () => {
    const other = planTimelock(when, AMOUNT_MSAT, NOW)
    expect(other.cw1).not.toBe(plan.cw1)
    expect(other.outputKeyHex).not.toBe(plan.outputKeyHex)
    expect(Object.keys(plan).sort()).toEqual([
      'cw1',
      'locktime',
      'outputKeyHex'
    ])
  })
  it('signs the amount, so a different amount gives a different signature', () => {
    const other = decodeCw1(planTimelock(when, AMOUNT_MSAT + 1, NOW).cw1)!
    const mine = decodeCw1(plan.cw1)!
    expect(other.witness[0]).not.toEqual(mine.witness[0])
  })
  it('refuses to plan an invalid date or a missing amount', () => {
    expect(() => planTimelock('', AMOUNT_MSAT, NOW)).toThrow()
    expect(() => planTimelock(at(NOW - 1000), AMOUNT_MSAT, NOW)).toThrow()
    expect(() => planTimelock(when, 0, NOW)).toThrow()
    expect(() => planTimelock(when, undefined, NOW)).toThrow()
  })
})
