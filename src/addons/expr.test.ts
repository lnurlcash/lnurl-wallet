import {describe, expect, it} from 'vitest'

import {evaluate, getPath} from './expr'
import type {Expr} from './types'

describe('getPath', () => {
  it('resolves a dotted path', () => {
    expect(getPath({a: {b: {c: 1}}}, 'a.b.c')).toBe(1)
  })

  it('returns undefined for a missing path instead of throwing', () => {
    expect(getPath({a: 1}, 'a.b.c')).toBeUndefined()
    expect(getPath(null, 'a')).toBeUndefined()
  })

  it('refuses to reach into the prototype chain', () => {
    expect(getPath({}, '__proto__.polluted')).toBeUndefined()
    expect(getPath({}, 'constructor.name')).toBeUndefined()
  })
})

describe('evaluate', () => {
  const ctx = {vars: {a: 3, b: 5, tiers: [1, 2, 3]}, helpers: {}}

  it('returns a literal as-is', () => {
    expect(evaluate('hi', ctx)).toBe('hi')
    expect(evaluate(42, ctx)).toBe(42)
    expect(evaluate(null, ctx)).toBeNull()
  })

  it('reads a var', () => {
    expect(evaluate({var: 'a'}, ctx)).toBe(3)
    expect(evaluate({var: 'tiers.length'}, ctx)).toBe(3)
  })

  it('concatenates with cat', () => {
    expect(evaluate({cat: [{var: 'a'}, ' of ', {var: 'b'}]}, ctx)).toBe('3 of 5')
  })

  it('short-circuits and', () => {
    expect(evaluate({and: [true, {gt: [{var: 'b'}, {var: 'a'}]}]}, ctx)).toBe(true)
    expect(evaluate({and: [false, {gt: [1, 0]}]}, ctx)).toBe(false)
  })

  it('compares with gt/lte', () => {
    expect(evaluate({gt: [{var: 'b'}, {var: 'a'}]}, ctx)).toBe(true)
    expect(evaluate({lte: [{var: 'a'}, {var: 'b'}]}, ctx)).toBe(true)
    expect(evaluate({lte: [{var: 'b'}, {var: 'a'}]}, ctx)).toBe(false)
  })

  it('dispatches a helper by name', () => {
    const helperCtx = {
      vars: {},
      helpers: {double: (n: number) => n * 2}
    }
    expect(evaluate({helper: 'double', args: [21]}, helperCtx)).toBe(42)
  })

  it('throws on an unknown helper rather than silently returning undefined', () => {
    expect(() => evaluate({helper: 'nope', args: []}, ctx)).toThrow(
      /unknown helper/i
    )
  })

  it('evaluates a plain array as a literal container, recursively', () => {
    expect(evaluate([{var: 'a'}, {var: 'b'}, 'x'], ctx)).toEqual([3, 5, 'x'])
  })

  it('evaluates a plain object (no operator key) as a literal container', () => {
    // not a formal member of the Expr union (would break discriminated
    // narrowing on the operator shapes - see types.ts's own note) but a
    // real, intentional runtime case, hence the cast
    const literal = {amountMsat: {var: 'a'}, tags: ['fixed', {var: 'b'}]} as unknown as Expr
    expect(evaluate(literal, ctx)).toEqual({amountMsat: 3, tags: ['fixed', 5]})
  })
})
