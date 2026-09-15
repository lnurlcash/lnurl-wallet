import {describe, expect, it} from 'vitest'
import {giftCardAddon} from './manifest'
import type {AddonHelper} from '../types'

// see globalHelpers.test.ts's own `call` - AddonHelper is deliberately
// typed uncallable-by-normal-code ((...args: never[])), only evaluate()
// in expr.ts is meant to invoke it, via this same cast
const call = (fn: AddonHelper, ...args: unknown[]): unknown =>
  fn(...(args as never[]))

const {helpers} = giftCardAddon

describe('templateLabel', () => {
  it('resolves a known template to its human label', () => {
    expect(call(helpers.templateLabel!, 'classic')).toBe(
      'Classic (amber & black)'
    )
  })

  it('falls back to the raw value for an unknown/missing template', () => {
    expect(call(helpers.templateLabel!, 'not-a-template')).toBe(
      'not-a-template'
    )
    expect(call(helpers.templateLabel!, undefined)).toBe('')
  })
})

describe('giftCardTickets', () => {
  it('converts sats to a single msat ticket, tagged', () => {
    expect(call(helpers.giftCardTickets!, 21000)).toEqual([
      {amountMsat: 21_000_000, tags: ['gift-card']}
    ])
  })

  it('rounds a fractional sat amount', () => {
    expect(call(helpers.giftCardTickets!, '100.4')).toEqual([
      {amountMsat: 100_400, tags: ['gift-card']}
    ])
  })
})

describe('buildGiftCardPdfFromResult', () => {
  it('throws with no split result yet', async () => {
    await expect(
      call(helpers.buildGiftCardPdfFromResult!, 'hi', [], 'classic')
    ).rejects.toThrow(/No gift card note/)
  })

  it('builds a PDF from note.split-shaped results', async () => {
    const results = [
      {
        id: 'x',
        url: `https://mint.example.com/w?k1=${'a'.repeat(64)}&amount=5000000`,
        label: '',
        index: 0,
        amountSat: 5000
      }
    ]
    const bytes = (await call(
      helpers.buildGiftCardPdfFromResult!,
      'Congrats!',
      results,
      'ocean'
    )) as Uint8Array
    expect(bytes.length).toBeGreaterThan(0)
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
  })
})
