import {describe, expect, it} from 'vitest'

import {GLOBAL_HELPERS} from './globalHelpers'
import type {AddonHelper} from './types'

// helpers are typed with a deliberately uncallable-by-normal-code
// (...args: never[]) signature - only evaluate() in expr.ts is meant to
// invoke them, via the same cast used here, after resolving args from
// plain expression data
const call = (fn: AddonHelper, ...args: unknown[]): unknown => fn(...(args as never[]))

describe('GLOBAL_HELPERS', () => {
  it('converts sats to msat and back', () => {
    expect(call(GLOBAL_HELPERS.satsToMsat!, 1000)).toBe(1000000)
    expect(call(GLOBAL_HELPERS.msatToSats!, 1000000)).toBe(1000)
  })

  it('floors a fractional msat->sats conversion rather than rounding up', () => {
    expect(call(GLOBAL_HELPERS.msatToSats!, 1999)).toBe(1)
  })

  it('does basic arithmetic', () => {
    expect(call(GLOBAL_HELPERS.add!, 1, 2, 3)).toBe(6)
    expect(call(GLOBAL_HELPERS.sub!, 10, 4)).toBe(6)
    expect(call(GLOBAL_HELPERS.mul!, 3, 4)).toBe(12)
    expect(call(GLOBAL_HELPERS.div!, 9, 3)).toBe(3)
    expect(call(GLOBAL_HELPERS.round!, 4.6)).toBe(5)
  })
})
