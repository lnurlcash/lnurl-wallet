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

describe('forgotten addresses', () => {
  it('forgetting removes the record and remembers the name', () => {
    mod.addRegisteredAddress('mint.example', 'alice')
    mod.forgetRegisteredAddress('mint.example', 'alice')
    expect(mod.registeredAddresses()).toEqual([])
    expect(mod.forgottenAddresses()).toEqual([
      {server: 'https://mint.example', username: 'alice'}
    ])
  })

  it('re-adding a forgotten name clears it from the forgotten list', () => {
    mod.forgetRegisteredAddress('mint.example', 'alice')
    mod.addRegisteredAddress('mint.example', 'alice')
    expect(mod.forgottenAddresses()).toEqual([])
    expect(mod.registeredAddresses()[0]?.username).toBe('alice')
  })

  it('dismissing drops it, and it survives a reload otherwise', async () => {
    mod.forgetRegisteredAddress('mint.example', 'alice')
    mod.forgetRegisteredAddress('mint.example', 'bob')
    mod.dismissForgottenAddress('mint.example', 'bob')
    vi.resetModules()
    const reloaded: typeof import('./addressRegistry') =
      await import('./addressRegistry')
    expect(reloaded.forgottenAddresses()).toEqual([
      {server: 'https://mint.example', username: 'alice'}
    ])
  })
})

describe('address shares', () => {
  const SERVER = 'https://mint.example.test'

  it('hands out share 0 first, then one past every share used', () => {
    expect(mod.nextAddressShare(SERVER)).toBe(0)
    mod.addRegisteredAddress(SERVER, 'alice', undefined, 0)
    mod.addRegisteredAddress(SERVER, 'bob', undefined, 1)
    expect(mod.nextAddressShare(SERVER)).toBe(2)
    expect(mod.nextAddressShare('https://other.example.test')).toBe(0)
  })

  it('ignores pre-LUD-26 registrations when picking a share', () => {
    mod.addRegisteredAddress(SERVER, 'legacy', undefined, undefined, 3)
    expect(mod.registeredAddresses()[0]).toMatchObject({slot: 3})
    expect(mod.nextAddressShare(SERVER)).toBe(0)
  })

  it('never reuses a share, even once its address is gone', () => {
    mod.addRegisteredAddress(SERVER, 'alice', undefined, 0)
    mod.forgetRegisteredAddress(SERVER, 'alice')
    expect(mod.forgottenAddresses()[0]?.share).toBe(0)
    mod.dismissForgottenAddress(SERVER, 'alice')
    expect(mod.nextAddressShare(SERVER)).toBe(1)
    mod.skipAddressShare(SERVER, 4)
    expect(mod.nextAddressShare(SERVER)).toBe(5)
  })

  it('moves a registration to a new share, keeping the old key to sweep', () => {
    mod.addRegisteredAddress(SERVER, 'alice', undefined, undefined, 2)
    mod.markAddressScanned(SERVER, 'alice', 7)
    mod.moveRegisteredAddress(SERVER, 'alice', 0)
    const [moved] = mod.registeredAddresses()
    expect(moved).toMatchObject({
      share: 0,
      retired: [{kind: 'legacy', slot: 2}]
    })
    expect(moved?.slot).toBeUndefined()
    expect(moved?.nextScanIndex).toBeUndefined()
    expect(mod.addressKeyOf(moved!)).toEqual({kind: 'share', share: 0})
  })

  it('persists the share and retired keys across a reload', async () => {
    mod.addRegisteredAddress(SERVER, 'alice', undefined, 4)
    mod.moveRegisteredAddress(SERVER, 'alice', 5)
    vi.resetModules()
    const reloaded = await import('./addressRegistry')
    expect(reloaded.registeredAddresses()[0]).toMatchObject({
      share: 5,
      retired: [{kind: 'share', share: 4}]
    })
    expect(reloaded.nextAddressShare(SERVER)).toBe(6)
  })
})

describe('setAddressFeeInvoice', () => {
  const PR =
    'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp'

  it('remembers the fee invoice across a reload, and clears it', async () => {
    mod.addRegisteredAddress('mint.example', 'alice', undefined, 0)
    mod.setAddressFeeInvoice('mint.example', 'alice', PR)
    vi.resetModules()
    mod = await import('./addressRegistry')
    expect(mod.registeredAddresses()[0]?.feeInvoice).toBe(PR)
    mod.setAddressFeeInvoice('mint.example', 'alice', undefined)
    vi.resetModules()
    mod = await import('./addressRegistry')
    expect(mod.registeredAddresses()[0]?.feeInvoice).toBeUndefined()
  })

  it('drops a stored fee invoice that is not a bolt11', async () => {
    store.set(
      'lnurlcash_registered_addresses',
      JSON.stringify([
        {
          server: 'https://mint.example',
          username: 'alice',
          registeredAt: 1,
          share: 0,
          feeInvoice: 'not an invoice'
        }
      ])
    )
    vi.resetModules()
    mod = await import('./addressRegistry')
    expect(mod.registeredAddresses()[0]?.feeInvoice).toBeUndefined()
  })
})

describe('moving an address off its old key', () => {
  const legacy = () =>
    store.set(
      'lnurlcash_registered_addresses',
      JSON.stringify([
        {
          server: 'https://mint.example',
          username: 'alice',
          registeredAt: 1,
          nextScanIndex: 7
        }
      ])
    )

  it('is not undone by a write from a tab that still holds the old record', async () => {
    legacy()
    vi.resetModules()
    mod = await import('./addressRegistry')
    // another tab moves it to share 0 - only storage changes here
    vi.resetModules()
    const otherTab = await import('./addressRegistry')
    otherTab.moveRegisteredAddress('mint.example', 'alice', 0)
    // this tab, still holding the legacy record in memory, writes next
    mod.setAddressAutoScan('mint.example', 'alice', 15)
    vi.resetModules()
    mod = await import('./addressRegistry')
    const entry = mod.registeredAddresses()[0]!
    expect(entry.share).toBe(0)
    expect(entry.nextScanIndex).toBeUndefined()
    expect(entry.autoScanMinutes).toBe(15)
  })

  it("drops a scan's index for a key the address was moved off meanwhile", async () => {
    legacy()
    vi.resetModules()
    mod = await import('./addressRegistry')
    mod.moveRegisteredAddress('mint.example', 'alice', 0)
    mod.markAddressScanned('mint.example', 'alice', 7, 1, {kind: 'legacy'})
    expect(mod.registeredAddresses()[0]?.nextScanIndex).toBeUndefined()
    mod.markAddressScanned('mint.example', 'alice', 3, 1, {
      kind: 'share',
      share: 0
    })
    expect(mod.registeredAddresses()[0]?.nextScanIndex).toBe(3)
  })
})

describe('candidateAddressKeys', () => {
  it('tries the recorded key first, then old slots and shares, once each', () => {
    const keys = mod.candidateAddressKeys('mint.example', {
      kind: 'share',
      share: 3
    })
    expect(keys[0]).toEqual({kind: 'share', share: 3})
    expect(keys[1]).toEqual({kind: 'legacy'})
    expect(keys).toContainEqual({kind: 'legacy', slot: 2})
    expect(keys).toContainEqual({kind: 'share', share: 0})
    expect(keys.filter(k => k.kind === 'share' && k.share === 3)).toHaveLength(
      1
    )
  })
})
