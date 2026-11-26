import {describe, expect, it} from 'vitest'
import {createFreshSignal} from './freshSignal'

describe('createFreshSignal', () => {
  it('reads back a write immediately, before any flush', () => {
    const [get, set] = createFreshSignal<string[]>([])
    // the read-modify-write sequence a plain Solid 2 signal loses
    set([...get(), 'a'])
    set([...get(), 'b'])
    expect(get()).toEqual(['a', 'b'])
  })

  it('applies updaters to the latest write, not the committed value', () => {
    const [get, set] = createFreshSignal(0)
    set(n => n + 1)
    set(n => n + 1)
    expect(get()).toBe(2)
  })

  // reactive notification can't be exercised here: under this config's
  // `environment: 'node'`, solid-js resolves to its server build, where
  // memos never recompute. The e2e suite covers it in a real browser
  it('returns what it was set to, so callers can chain on it', () => {
    const [, set] = createFreshSignal(1)
    expect(set(n => n * 3)).toBe(3)
  })
})
