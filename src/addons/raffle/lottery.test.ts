import {describe, expect, it} from 'vitest'

import {
  tierPreset,
  ticketCount,
  totalAmountSat,
  planTickets,
  newTier,
  pricePerTicketSat
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

describe('pricePerTicketSat', () => {
  // 10 tickets, 1000 sat pool -> 100 sat/ticket net; no margin, no fee ->
  // charging exactly the net price is enough
  const tenTicketsAt100 = [{...newTier(), count: 10, amountSat: 100}]

  it('with no margin and no fee, price per ticket is just the even split', () => {
    expect(pricePerTicketSat(tenTicketsAt100, 0, 0, 0)).toBe(100)
  })

  it('adds the margin as a straight markup when there is no fee', () => {
    expect(pricePerTicketSat(tenTicketsAt100, 10, 0, 0)).toBe(110)
  })

  it('grosses up (not just adds) a flat fee so the organizer still nets the margin', () => {
    // net = 110, base fee = 5 -> gross - 5 = 110 -> gross = 115 (rate 0%,
    // so a flat fee really is just addition)
    expect(pricePerTicketSat(tenTicketsAt100, 10, 5, 0)).toBe(115)
  })

  it('grosses up a percentage fee correctly (net = gross - gross*rate)', () => {
    // net = 100, rate = 20% -> gross*(0.8) = 100 -> gross = 125
    expect(pricePerTicketSat(tenTicketsAt100, 0, 0, 20)).toBe(125)
  })

  it('combines a flat fee and a percentage fee in one gross-up', () => {
    // net = 100, base = 10, rate = 10% -> gross*0.9 = 110 -> gross = 122.22 -> ceil 123
    expect(pricePerTicketSat(tenTicketsAt100, 0, 10, 10)).toBe(123)
  })

  it('is null when there are no tickets to price', () => {
    expect(pricePerTicketSat([], 10, 0, 0)).toBeNull()
  })

  it('is null for a nonsensical fee percent at or above 100%', () => {
    expect(pricePerTicketSat(tenTicketsAt100, 0, 0, 100)).toBeNull()
    expect(pricePerTicketSat(tenTicketsAt100, 0, 0, 150)).toBeNull()
  })

  it('never returns a negative price from negative inputs', () => {
    const price = pricePerTicketSat(tenTicketsAt100, -50, -10, -5)
    expect(price).not.toBeNull()
    expect(price!).toBeGreaterThan(0)
  })
})
