import {beforeEach, describe, expect, it, vi} from 'vitest'

// storeableLinks.ts reads localStorage once at import time (its module-
// level signals initialize from it), so an in-memory stand-in has to be in
// place before the module is imported - and each test re-imports fresh via
// vi.resetModules so no state leaks between cases (same convention as
// trustedMints.test.ts)
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

let mod: typeof import('./storeableLinks')

beforeEach(async () => {
  store.clear()
  vi.resetModules()
  mod = await import('./storeableLinks')
})

describe('addStoreableMint / addStoreableMeltAddress', () => {
  it('adds a new address', () => {
    mod.addStoreableMint('mint.example')
    expect(mod.storeableMints().map(l => l.address)).toEqual(['mint.example'])
  })

  it('trims whitespace and ignores an empty address', () => {
    mod.addStoreableMint('  mint.example  ')
    expect(mod.storeableMints()[0]?.address).toBe('mint.example')
    mod.addStoreableMint('   ')
    expect(mod.storeableMints()).toHaveLength(1)
  })

  it('keeps the two registries separate', () => {
    mod.addStoreableMint('mint.example')
    mod.addStoreableMeltAddress('alice@mint.example')
    expect(mod.storeableMints().map(l => l.address)).toEqual(['mint.example'])
    expect(mod.storeableMeltAddresses().map(l => l.address)).toEqual([
      'alice@mint.example'
    ])
  })
})

describe('internalTransfer flag (LUD-25 Part 2 Internal transfer)', () => {
  it('records whether a melt address confirmed text/xpub support', () => {
    mod.addStoreableMeltAddress('alice@mint.example', true)
    expect(mod.storeableMeltAddresses()[0]?.internalTransfer).toBe(true)
  })

  it('is undefined ("never confirmed either way"), not false, when omitted', () => {
    mod.addStoreableMeltAddress('bob@mint.example')
    expect(mod.storeableMeltAddresses()[0]?.internalTransfer).toBeUndefined()
  })

  it('refreshes the flag on an address already saved, rather than no-op', () => {
    mod.addStoreableMeltAddress('carol@mint.example', false)
    expect(mod.storeableMeltAddresses()[0]?.internalTransfer).toBe(false)
    mod.addStoreableMeltAddress('carol@mint.example', true)
    expect(mod.storeableMeltAddresses()[0]?.internalTransfer).toBe(true)
    expect(mod.storeableMeltAddresses()).toHaveLength(1) // never duplicated
  })

  it('re-adding without a known value leaves a previously-confirmed flag untouched', () => {
    mod.addStoreableMeltAddress('dana@mint.example', true)
    mod.addStoreableMeltAddress('dana@mint.example')
    expect(mod.storeableMeltAddresses()[0]?.internalTransfer).toBe(true)
  })

  it('never sets the flag on the mint registry', () => {
    mod.addStoreableMint('mint.example')
    expect(mod.storeableMints()[0]?.internalTransfer).toBeUndefined()
  })

  it('survives a reload (persisted to localStorage)', async () => {
    mod.addStoreableMeltAddress('erin@mint.example', true)
    vi.resetModules()
    mod = await import('./storeableLinks')
    expect(mod.storeableMeltAddresses()[0]?.internalTransfer).toBe(true)
  })

  it('strips a malformed stored internalTransfer value rather than rejecting the whole entry', async () => {
    store.set(
      'lnurlcash_storeable_melt_addresses',
      JSON.stringify([
        {
          address: 'frank@mint.example',
          addedAt: 1,
          internalTransfer: 'not-a-boolean'
        }
      ])
    )
    vi.resetModules()
    mod = await import('./storeableLinks')
    const entry = mod.storeableMeltAddresses()[0]
    expect(entry?.address).toBe('frank@mint.example')
    expect(entry?.internalTransfer).toBeUndefined()
  })
})

describe('removeStoreableMint / removeStoreableMeltAddress', () => {
  it('removes a matching address', () => {
    mod.addStoreableMeltAddress('alice@mint.example')
    mod.removeStoreableMeltAddress('alice@mint.example')
    expect(mod.storeableMeltAddresses()).toHaveLength(0)
  })

  it('is a no-op for an address not on file', () => {
    mod.addStoreableMeltAddress('alice@mint.example')
    mod.removeStoreableMeltAddress('nobody@mint.example')
    expect(mod.storeableMeltAddresses()).toHaveLength(1)
  })
})

describe('clearStoreableLinks', () => {
  it('wipes both registries', () => {
    mod.addStoreableMint('mint.example')
    mod.addStoreableMeltAddress('alice@mint.example')
    mod.clearStoreableLinks()
    expect(mod.storeableMints()).toHaveLength(0)
    expect(mod.storeableMeltAddresses()).toHaveLength(0)
  })
})

describe('malformed stored data', () => {
  it('ignores a corrupt (non-array) stored value', async () => {
    store.set('lnurlcash_storeable_melt_addresses', '{"not":"an array"}')
    vi.resetModules()
    mod = await import('./storeableLinks')
    expect(mod.storeableMeltAddresses()).toHaveLength(0)
  })

  it('drops entries missing a required field', async () => {
    store.set(
      'lnurlcash_storeable_melt_addresses',
      JSON.stringify([
        {address: 'ok@mint.example', addedAt: 1},
        {address: 'missing-addedAt@mint.example'},
        {addedAt: 2}
      ])
    )
    vi.resetModules()
    mod = await import('./storeableLinks')
    expect(mod.storeableMeltAddresses().map(l => l.address)).toEqual([
      'ok@mint.example'
    ])
  })
})
