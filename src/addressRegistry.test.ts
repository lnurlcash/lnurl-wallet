import {beforeEach, describe, expect, it, vi} from 'vitest'

// same in-memory localStorage stand-in as trustedMints.test.ts - the
// module's signal initializes from localStorage at import time, so the
// stub has to be in place before each fresh import (vi.resetModules)
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

// 32 bytes of 0x01, bech32-encoded with hrp "npub" - a real, validly
// bech32-checksummed npub isValidNpub accepts, not a hand-typed fixture
const NPUB = 'npub1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs8j9gdm'

let mod: typeof import('./addressRegistry')

beforeEach(async () => {
  store.clear()
  vi.resetModules()
  mod = await import('./addressRegistry')
})

describe('addRegisteredAddress', () => {
  it('records a fresh claim with no npub', () => {
    mod.addRegisteredAddress('mint.example', 'alice')
    const entry = mod.registeredAddresses()[0]
    expect(entry?.server).toBe('https://mint.example')
    expect(entry?.username).toBe('alice')
    expect(entry?.npub).toBeUndefined()
  })

  it('records a fresh claim with a valid npub', () => {
    mod.addRegisteredAddress('mint.example', 'alice', NPUB)
    expect(mod.registeredAddresses()[0]?.npub).toBe(NPUB)
  })

  it('is a no-op re-adding the exact same server+username+npub', () => {
    mod.addRegisteredAddress('mint.example', 'alice', NPUB)
    const before = mod.registeredAddresses()
    mod.addRegisteredAddress('mint.example', 'alice', NPUB)
    expect(mod.registeredAddresses()).toBe(before)
  })

  it('updates the stored npub on a re-claim that changes it', () => {
    mod.addRegisteredAddress('mint.example', 'alice')
    expect(mod.registeredAddresses()[0]?.npub).toBeUndefined()
    mod.addRegisteredAddress('mint.example', 'alice', NPUB)
    expect(mod.registeredAddresses()).toHaveLength(1)
    expect(mod.registeredAddresses()[0]?.npub).toBe(NPUB)
  })

  it('clears a previously stored npub when re-claimed without one', () => {
    mod.addRegisteredAddress('mint.example', 'alice', NPUB)
    mod.addRegisteredAddress('mint.example', 'alice')
    expect(mod.registeredAddresses()[0]?.npub).toBeUndefined()
  })

  it('rejects an invalid username', () => {
    expect(() =>
      mod.addRegisteredAddress('mint.example', 'Not Valid!')
    ).toThrow()
  })
})

describe('setAddressAutoScan / markAddressScanned', () => {
  it('sets and clears the per-address auto-scan interval', () => {
    mod.addRegisteredAddress('mint.example', 'alice')
    mod.setAddressAutoScan('mint.example', 'alice', 30)
    expect(mod.registeredAddresses()[0]?.autoScanMinutes).toBe(30)
    mod.setAddressAutoScan('mint.example', 'alice', 0)
    expect(mod.registeredAddresses()[0]?.autoScanMinutes).toBeUndefined()
  })

  it('is a no-op on an address this device has no record of', () => {
    mod.setAddressAutoScan('mint.example', 'nobody', 30)
    expect(mod.registeredAddresses()).toHaveLength(0)
  })

  it('records the next resume index and a scan timestamp', () => {
    mod.addRegisteredAddress('mint.example', 'alice')
    const before = Date.now()
    mod.markAddressScanned('mint.example', 'alice', 7)
    const entry = mod.registeredAddresses()[0]
    expect(entry?.nextScanIndex).toBe(7)
    expect(entry?.lastAutoScanAt).toBeGreaterThanOrEqual(before)
  })

  it('accepts an explicit timestamp', () => {
    mod.addRegisteredAddress('mint.example', 'alice')
    mod.markAddressScanned('mint.example', 'alice', 2, 12345)
    expect(mod.registeredAddresses()[0]?.lastAutoScanAt).toBe(12345)
  })
})

describe('persistence', () => {
  it('survives a reload (fresh module import) including npub', async () => {
    mod.addRegisteredAddress('mint.example', 'alice', NPUB)
    vi.resetModules()
    const reloaded = await import('./addressRegistry')
    expect(reloaded.registeredAddresses()[0]?.npub).toBe(NPUB)
  })

  it('survives a reload including autoScanMinutes/nextScanIndex', async () => {
    mod.addRegisteredAddress('mint.example', 'alice')
    mod.setAddressAutoScan('mint.example', 'alice', 60)
    mod.markAddressScanned('mint.example', 'alice', 9, 5000)
    vi.resetModules()
    const reloaded = await import('./addressRegistry')
    const entry = reloaded.registeredAddresses()[0]
    expect(entry?.autoScanMinutes).toBe(60)
    expect(entry?.nextScanIndex).toBe(9)
    expect(entry?.lastAutoScanAt).toBe(5000)
  })

  it('drops a stored npub that fails validation, but keeps the address', async () => {
    mod.addRegisteredAddress('mint.example', 'alice')
    const raw = JSON.parse(store.get('lnurlcash_registered_addresses')!)
    raw[0].npub = 'not-a-real-npub'
    store.set('lnurlcash_registered_addresses', JSON.stringify(raw))
    vi.resetModules()
    const reloaded = await import('./addressRegistry')
    const entry = reloaded.registeredAddresses()[0]
    expect(entry?.username).toBe('alice')
    expect(entry?.npub).toBeUndefined()
  })
})
