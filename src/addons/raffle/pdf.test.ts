import {describe, expect, it} from 'vitest'
import {buildTicketPdf} from './pdf'

// Smoke test only - pdf-lib's own rendering internals aren't re-verified
// here, just that buildTicketPdf actually completes (a PDF header comes
// out) with a real tier list attached to the cover page, and doesn't
// throw for an untitled/empty-label tier or a paper size switch.
describe('buildTicketPdf', () => {
  const tickets = [
    {
      index: 0,
      amountSat: 100000,
      label: 'Grand prize',
      url: `https://mint.example.com/w?k1=${'a'.repeat(64)}&amount=100000000`
    },
    {
      index: 1,
      amountSat: 500,
      label: '',
      url: `https://mint.example.com/w?k1=${'b'.repeat(64)}&amount=500000`
    }
  ]
  const tiers = [
    {id: 't1', count: 1, amountSat: 100000, label: 'Grand prize'},
    {id: 't2', count: 1, amountSat: 500, label: ''}
  ]

  it('renders a PDF with the prize tiers on the cover page', async () => {
    const bytes = await buildTicketPdf(
      'Test Raffle',
      tickets,
      true,
      'a4',
      tiers
    )
    expect(bytes.length).toBeGreaterThan(0)
    // pdf-lib always starts a saved document with the standard PDF header
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
  })

  it('still works with no tiers argument at all (default param)', async () => {
    const bytes = await buildTicketPdf('Test Raffle', tickets, false, 'letter')
    expect(bytes.length).toBeGreaterThan(0)
  })
})
