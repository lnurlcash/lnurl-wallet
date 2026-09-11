import {beforeEach, describe, expect, it, vi} from 'vitest'
import {schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex} from '@noble/hashes/utils.js'
import {deriveNotePubkey} from './lib/recoverableNotes'

// same in-memory localStorage stand-in as storage.test.ts/trustedMints.test.ts -
// cashSecrets.ts persists per-SERVICE indices there, and a fresh module graph
// per test keeps them from bleeding across cases
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

const SEED =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

let cashSecrets: typeof import('./cashSecrets')
let keys: typeof import('./keys')

beforeEach(async () => {
  store.clear()
  vi.resetModules()
  cashSecrets = await import('./cashSecrets')
  keys = await import('./keys')
})

const loadRoot = () => {
  const node = keys.deriveLud25CashRootNode(SEED)
  cashSecrets.setCashRoot(node)
  return node
}

describe('generateNoteSecret fallback without a loaded root', () => {
  it('cashSecretAtIndex/nextCashSecret are null with no root set', () => {
    expect(cashSecrets.cashSecretAtIndex('mint.example', 0)).toBeNull()
    expect(cashSecrets.nextCashSecret('mint.example')).toBeNull()
  })

  it('goes back to null after setCashRoot(null)', () => {
    loadRoot()
    expect(cashSecrets.nextCashSecret('mint.example')).not.toBeNull()
    cashSecrets.setCashRoot(null)
    expect(cashSecrets.nextCashSecret('mint.example')).toBeNull()
  })

  it('refuses a payable mint secret when it cannot be recovered from the seed', () => {
    expect(() =>
      cashSecrets.requireRecoverableCashSecret('mint.example')
    ).toThrow(/seed-derived cash key/)
    expect(cashSecrets.nextCashSecretIndex('mint.example')).toBe(0)
  })
})

describe('deterministic secrets', () => {
  it('the same seed + domain + index always yields the same secret', () => {
    loadRoot()
    const a = cashSecrets.cashSecretAtIndex('mint.example', 0)
    cashSecrets.setCashRoot(null)
    loadRoot() // re-derive from the same seed, as a fresh install would
    const b = cashSecrets.cashSecretAtIndex('mint.example', 0)
    expect(a).not.toBeNull()
    expect(a).toBe(b)
  })

  it('differs per domain and per index', () => {
    loadRoot()
    const a0 = cashSecrets.cashSecretAtIndex('a.example', 0)
    const b0 = cashSecrets.cashSecretAtIndex('b.example', 0)
    const a1 = cashSecrets.cashSecretAtIndex('a.example', 1)
    expect(a0).not.toBe(b0)
    expect(a0).not.toBe(a1)
  })

  it('is a bare 32-byte hex value, the same shape a preimage already is', () => {
    loadRoot()
    expect(cashSecrets.cashSecretAtIndex('mint.example', 0)).toMatch(
      /^[0-9a-f]{64}$/
    )
  })

  it('cashSecretAtIndex is pure - repeated calls never advance the counter', () => {
    loadRoot()
    cashSecrets.cashSecretAtIndex('mint.example', 0)
    cashSecrets.cashSecretAtIndex('mint.example', 0)
    expect(cashSecrets.nextCashSecretIndex('mint.example')).toBe(0)
  })
})

describe('per-SERVICE index counters', () => {
  it('persists a recoverable mint secret before returning it', () => {
    loadRoot()
    const secret = cashSecrets.requireRecoverableCashSecret('mint.example')
    expect(secret).toBe(cashSecrets.cashSecretAtIndex('mint.example', 0))
    expect(cashSecrets.nextCashSecretIndex('mint.example')).toBe(1)
  })

  it('nextCashSecret claims and persists sequential indices per domain', () => {
    loadRoot()
    const first = cashSecrets.nextCashSecret('mint.example')
    const second = cashSecrets.nextCashSecret('mint.example')
    expect(first).not.toBe(second)
    expect(first).toBe(cashSecrets.cashSecretAtIndex('mint.example', 0))
    expect(second).toBe(cashSecrets.cashSecretAtIndex('mint.example', 1))
    expect(cashSecrets.nextCashSecretIndex('mint.example')).toBe(2)
  })

  it('tracks each domain independently', () => {
    loadRoot()
    cashSecrets.nextCashSecret('a.example')
    cashSecrets.nextCashSecret('a.example')
    cashSecrets.nextCashSecret('b.example')
    expect(cashSecrets.nextCashSecretIndex('a.example')).toBe(2)
    expect(cashSecrets.nextCashSecretIndex('b.example')).toBe(1)
  })

  it('survives a fresh module load (persisted, not just in-memory)', async () => {
    loadRoot()
    cashSecrets.nextCashSecret('mint.example')
    cashSecrets.nextCashSecret('mint.example')
    vi.resetModules()
    const reloaded: typeof import('./cashSecrets') =
      await import('./cashSecrets')
    expect(reloaded.nextCashSecretIndex('mint.example')).toBe(2)
  })

  it('clearCashSecretIndices resets every domain', () => {
    loadRoot()
    cashSecrets.nextCashSecret('mint.example')
    cashSecrets.clearCashSecretIndices()
    expect(cashSecrets.nextCashSecretIndex('mint.example')).toBe(0)
  })
})

describe('mergeCashSecretIndices (backup restore)', () => {
  it('raises a domain counter to the incoming value', () => {
    cashSecrets.mergeCashSecretIndices({'mint.example': 5})
    expect(cashSecrets.nextCashSecretIndex('mint.example')).toBe(5)
  })

  it('never lowers an existing counter', () => {
    loadRoot()
    cashSecrets.nextCashSecret('mint.example') // -> index 1
    cashSecrets.mergeCashSecretIndices({'mint.example': 0})
    expect(cashSecrets.nextCashSecretIndex('mint.example')).toBe(1)
  })

  it('ignores malformed entries without throwing', () => {
    expect(() =>
      cashSecrets.mergeCashSecretIndices({
        'mint.example': -1,
        'other.example': 1.5,
        'huge.example': 10_000_000,
        [123 as unknown as string]: 'not a number',
        __proto__: {polluted: true}
      } as unknown)
    ).not.toThrow()
    expect(cashSecrets.nextCashSecretIndex('mint.example')).toBe(0)
    expect(cashSecrets.nextCashSecretIndex('other.example')).toBe(0)
    expect(cashSecrets.nextCashSecretIndex('huge.example')).toBe(0)
    // the prototype-pollution attempt above must not have actually reached
    // Object.prototype - an unrelated fresh domain must read as 0, not
    // {polluted: true}
    expect((({} as Record<string, unknown>).polluted as unknown) ?? null).toBe(
      null
    )
  })

  it('no-ops on non-object input', () => {
    expect(() => cashSecrets.mergeCashSecretIndices(null)).not.toThrow()
    expect(() => cashSecrets.mergeCashSecretIndices(undefined)).not.toThrow()
    expect(() => cashSecrets.mergeCashSecretIndices('nope')).not.toThrow()
  })
})

describe('LUD-25 Part 2: address branches (cashAddressBranch/cashAddressSecretAtIndex)', () => {
  it('are null with no root set, same as the legacy secret path', () => {
    expect(cashSecrets.cashAddressBranch('mint.example')).toBeNull()
    expect(cashSecrets.cashAddressSecretAtIndex('mint.example', 0)).toBeNull()
  })

  it('exports a 32-byte pubkey + 32-byte chain code', () => {
    loadRoot()
    const branch = cashSecrets.cashAddressBranch('mint.example')
    expect(branch?.pubkeyXOnly).toHaveLength(32)
    expect(branch?.chainCode).toHaveLength(32)
  })

  it('is deterministic from the same seed, and differs per domain', () => {
    loadRoot()
    const a = cashSecrets.cashAddressBranch('a.example')
    cashSecrets.setCashRoot(null)
    loadRoot()
    const aAgain = cashSecrets.cashAddressBranch('a.example')
    const b = cashSecrets.cashAddressBranch('b.example')
    expect(bytesToHex(a!.pubkeyXOnly)).toBe(bytesToHex(aAgain!.pubkeyXOnly))
    expect(bytesToHex(a!.chainCode)).toBe(bytesToHex(aAgain!.chainCode))
    expect(bytesToHex(a!.pubkeyXOnly)).not.toBe(bytesToHex(b!.pubkeyXOnly))
  })

  it("lives on its own m/139'/1' branch, independent from the legacy m/139'/0/... secrets", () => {
    loadRoot()
    const legacySecret = cashSecrets.cashSecretAtIndex('mint.example', 0)!
    const addressSecret = cashSecrets.cashAddressSecretAtIndex(
      'mint.example',
      0
    )!
    expect(bytesToHex(addressSecret)).not.toBe(legacySecret)
  })

  it("a derived note secret's own public key matches the watch-only derivation from the exported branch (cx1 round-trip)", () => {
    loadRoot()
    const branch = cashSecrets.cashAddressBranch('mint.example')!
    for (const index of [0, 1, 42]) {
      const secretKey = cashSecrets.cashAddressSecretAtIndex(
        'mint.example',
        index
      )!
      const pubkeyFromSecret = schnorr.getPublicKey(secretKey)
      const pubkeyWatchOnly = deriveNotePubkey(
        branch.pubkeyXOnly,
        branch.chainCode,
        index
      )
      expect(bytesToHex(pubkeyFromSecret)).toBe(bytesToHex(pubkeyWatchOnly))
    }
  })

  it('cashAddressSecretAtIndex is pure - repeated calls at the same index are stable', () => {
    loadRoot()
    const a = cashSecrets.cashAddressSecretAtIndex('mint.example', 3)!
    const b = cashSecrets.cashAddressSecretAtIndex('mint.example', 3)!
    expect(bytesToHex(a)).toBe(bytesToHex(b))
  })
})

describe('readCashSecretIndices (backup build)', () => {
  it('reflects the current counters', () => {
    loadRoot()
    cashSecrets.nextCashSecret('mint.example')
    expect(cashSecrets.readCashSecretIndices()).toEqual({'mint.example': 1})
  })

  it('is empty on a fresh wallet', () => {
    expect(cashSecrets.readCashSecretIndices()).toEqual({})
  })
})
