import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {Addon} from './types'

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
  key: () => null,
  get length() {
    return store.size
  }
})

let mod: typeof import('./navPosition')

beforeEach(async () => {
  store.clear()
  vi.resetModules()
  mod = await import('./navPosition')
})

const addonWithNav = (id: string, position: 'left' | 'right'): Addon =>
  ({
    manifest: {
      id,
      name: id,
      version: '1',
      icon: 'globe',
      permissions: [],
      state: {},
      ui: {type: 'View', children: []},
      nav: {position, icon: 'globe', label: id}
    },
    helpers: {}
  }) as Addon

const addonWithoutNav = (id: string): Addon =>
  ({
    manifest: {
      id,
      name: id,
      version: '1',
      icon: 'globe',
      permissions: [],
      state: {},
      ui: {type: 'View', children: []}
    },
    helpers: {}
  }) as Addon

describe('effectiveNavPosition', () => {
  it("falls back to the manifest's own declared position with no override", () => {
    expect(mod.effectiveNavPosition(addonWithNav('a', 'right'))).toBe('right')
  })

  it('is undefined for an addon with no nav entry at all', () => {
    expect(mod.effectiveNavPosition(addonWithoutNav('a'))).toBeUndefined()
  })

  it('an override flips it to the other side', () => {
    const addon = addonWithNav('a', 'right')
    mod.setAddonNavPosition('a', 'left')
    expect(mod.effectiveNavPosition(addon)).toBe('left')
  })

  it('clearing an override (null) reverts to the manifest default', () => {
    const addon = addonWithNav('a', 'right')
    mod.setAddonNavPosition('a', 'left')
    mod.setAddonNavPosition('a', null)
    expect(mod.effectiveNavPosition(addon)).toBe('right')
  })

  it('a stray override for an addon with no nav entry never resurrects a link', () => {
    mod.setAddonNavPosition('ghost', 'left')
    expect(mod.effectiveNavPosition(addonWithoutNav('ghost'))).toBeUndefined()
  })
})

describe('persistence', () => {
  it('survives a reload', async () => {
    mod.setAddonNavPosition('a', 'left')
    vi.resetModules()
    const reloaded = await import('./navPosition')
    expect(reloaded.effectiveNavPosition(addonWithNav('a', 'right'))).toBe(
      'left'
    )
  })

  it('ignores a malformed stored value', async () => {
    store.set('lnurlcash_addon_nav_position', JSON.stringify({a: 'sideways'}))
    vi.resetModules()
    const reloaded = await import('./navPosition')
    expect(reloaded.effectiveNavPosition(addonWithNav('a', 'right'))).toBe(
      'right'
    )
  })
})
