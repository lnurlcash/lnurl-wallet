import {describe, expect, it} from 'vitest'

import {
  tierPreset,
  ticketCount,
  totalAmountSat,
  planTickets,
  newTier
} from './lottery'

describe('raffle lottery helpers', () => {
  it('builds a preset tier list', () => {
    const tiers = tierPreset('even-split')
    expect(ticketCount(tiers)).toBe(50)
    expect(totalAmountSat(tiers)).toBe(50000)
  })

  it('rejects an unknown preset id', () => {
    // @ts-expect-error - deliberately invalid id, mirrors what a malformed
    // manifest arg would produce at runtime
    expect(() => tierPreset('not-a-preset')).toThrow()
  })

  it('creates a fresh tier with a unique id', () => {
    const a = newTier()
    const b = newTier()
    expect(a.id).not.toBe(b.id)
    expect(a.count).toBe(1)
  })

  it('plans one ticket per tier count, tagged with the run id and tier', () => {
    const tiers = [
      {id: 't1', count: 1, amountSat: 100, label: 'Grand prize'},
      {id: 't2', count: 3, amountSat: 10}
    ].map(t => ({...newTier(), ...t}))
    const plan = planTickets(tiers, 'run-1')
    expect(plan).toHaveLength(4)
    expect(plan.map(t => t.amountMsat).sort((a, b) => a - b)).toEqual([
      10000, 10000, 10000, 100000
    ])
    for (const ticket of plan) {
      expect(ticket.tags[0]).toBe('raffle:run-1')
    }
    const grand = plan.find(t => t.amountMsat === 100000)!
    expect(grand.tags[1]).toBe('tier:Grand prize')
    const small = plan.find(t => t.amountMsat === 10000)!
    expect(small.tags[1]).toBe('tier:10')
  })

  it('assigns each ticket a distinct index covering the full plan', () => {
    const tiers = [{...newTier(), count: 5, amountSat: 100}]
    const plan = planTickets(tiers, 'run-2')
    expect(plan.map(t => t.index).sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4
    ])
  })
})
