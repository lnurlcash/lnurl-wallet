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

describe('LUD-25 Part 2: address branches (cashAddressBranch/cashAddressSecretAtIndex)', () => {
  it('are null with no root set', () => {
    expect(cashSecrets.cashAddressBranch('mint.example')).toBeNull()
    expect(cashSecrets.cashAddressSecretAtIndex('mint.example', 0)).toBeNull()
    expect(cashSecrets.nextCashAddressSecret('mint.example')).toBeNull()
    expect(() =>
      cashSecrets.requireRecoverableCashAddressSecret('mint.example')
    ).toThrow(/seed-derived cash key/)
  })

  it('goes back to null after setCashRoot(null)', () => {
    loadRoot()
    expect(cashSecrets.nextCashAddressSecret('mint.example')).not.toBeNull()
    cashSecrets.setCashRoot(null)
    expect(cashSecrets.nextCashAddressSecret('mint.example')).toBeNull()
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

describe('LUD-25 Part 2: wallet-initiated secrets (nextCashAddressSecret)', () => {
  it('persists a recoverable secret before returning it, as a ck1 string', () => {
    loadRoot()
    const secret =
      cashSecrets.requireRecoverableCashAddressSecret('mint.example')
    expect(secret).toMatch(/^ck1/)
    expect(cashSecrets.nextCashAddressSecretIndex('mint.example')).toBe(1)
  })

  it('claims and persists sequential indices per domain', () => {
    loadRoot()
    const first = cashSecrets.nextCashAddressSecret('mint.example')
    const second = cashSecrets.nextCashAddressSecret('mint.example')
    expect(first).not.toBe(second)
    expect(cashSecrets.nextCashAddressSecretIndex('mint.example')).toBe(2)
  })

  it('tracks each domain independently', () => {
    loadRoot()
    cashSecrets.nextCashAddressSecret('a.example')
    cashSecrets.nextCashAddressSecret('a.example')
    cashSecrets.nextCashAddressSecret('b.example')
    expect(cashSecrets.nextCashAddressSecretIndex('a.example')).toBe(2)
    expect(cashSecrets.nextCashAddressSecretIndex('b.example')).toBe(1)
  })

  it('survives a fresh module load (persisted, not just in-memory)', async () => {
    loadRoot()
    cashSecrets.nextCashAddressSecret('mint.example')
    cashSecrets.nextCashAddressSecret('mint.example')
    vi.resetModules()
    const reloaded: typeof import('./cashSecrets') =
      await import('./cashSecrets')
    expect(reloaded.nextCashAddressSecretIndex('mint.example')).toBe(2)
  })

  it('clearCashAddressSecretIndices resets every domain', () => {
    loadRoot()
    cashSecrets.nextCashAddressSecret('mint.example')
    cashSecrets.clearCashAddressSecretIndices()
    expect(cashSecrets.nextCashAddressSecretIndex('mint.example')).toBe(0)
  })

  it('readCashAddressSecretIndices reflects the current counters', () => {
    loadRoot()
    cashSecrets.nextCashAddressSecret('mint.example')
    expect(cashSecrets.readCashAddressSecretIndices()).toEqual({
      'mint.example': 1
    })
  })

  it('is empty on a fresh wallet', () => {
    expect(cashSecrets.readCashAddressSecretIndices()).toEqual({})
  })
})

describe('mergeCashAddressSecretIndices (backup restore)', () => {
  it('raises a domain counter to the incoming value', () => {
    cashSecrets.mergeCashAddressSecretIndices({'mint.example': 5})
    expect(cashSecrets.nextCashAddressSecretIndex('mint.example')).toBe(5)
  })

  it('never lowers an existing counter', () => {
    loadRoot()
    cashSecrets.nextCashAddressSecret('mint.example') // -> index 1
    cashSecrets.mergeCashAddressSecretIndices({'mint.example': 0})
    expect(cashSecrets.nextCashAddressSecretIndex('mint.example')).toBe(1)
  })

  it('ignores malformed entries without throwing', () => {
    expect(() =>
      cashSecrets.mergeCashAddressSecretIndices({
        'mint.example': -1,
        'other.example': 1.5,
        'huge.example': 10_000_000,
        [123 as unknown as string]: 'not a number',
        __proto__: {polluted: true}
      } as unknown)
    ).not.toThrow()
    expect(cashSecrets.nextCashAddressSecretIndex('mint.example')).toBe(0)
    expect(cashSecrets.nextCashAddressSecretIndex('other.example')).toBe(0)
    expect(cashSecrets.nextCashAddressSecretIndex('huge.example')).toBe(0)
    // the prototype-pollution attempt above must not have actually reached
    // Object.prototype - an unrelated fresh domain must read as 0, not
    // {polluted: true}
    expect((({} as Record<string, unknown>).polluted as unknown) ?? null).toBe(
      null
    )
  })

  it('no-ops on non-object input', () => {
    expect(() => cashSecrets.mergeCashAddressSecretIndices(null)).not.toThrow()
    expect(() =>
      cashSecrets.mergeCashAddressSecretIndices(undefined)
    ).not.toThrow()
    expect(() =>
      cashSecrets.mergeCashAddressSecretIndices('nope')
    ).not.toThrow()
  })
})

// Part 1's own reload-survival (see lnurlcash.ts's generateMintSecret) -
// deliberately plain localStorage, not seed-derived (25.md's Part 1 defines
// no derivation at all - see this module's own header comment)
describe('pending mint secrets (Part 1 reload-survival)', () => {
  it('is empty for a domain nothing was ever recorded for', () => {
    expect(cashSecrets.pendingMintSecretsFor('mint.example')).toEqual([])
  })

  it('records survive independently of any cash root', () => {
    cashSecrets.recordPendingMintSecret('mint.example', 'aa'.repeat(32))
    expect(cashSecrets.pendingMintSecretsFor('mint.example')).toEqual([
      'aa'.repeat(32)
    ])
  })

  it('accumulates multiple still-open secrets for the same domain', () => {
    cashSecrets.recordPendingMintSecret('mint.example', 'aa'.repeat(32))
    cashSecrets.recordPendingMintSecret('mint.example', 'bb'.repeat(32))
    expect(cashSecrets.pendingMintSecretsFor('mint.example')).toEqual([
      'aa'.repeat(32),
      'bb'.repeat(32)
    ])
  })

  it('does not record the same secret twice', () => {
    cashSecrets.recordPendingMintSecret('mint.example', 'aa'.repeat(32))
    cashSecrets.recordPendingMintSecret('mint.example', 'aa'.repeat(32))
    expect(cashSecrets.pendingMintSecretsFor('mint.example')).toEqual([
      'aa'.repeat(32)
    ])
  })

  it('tracks each domain independently', () => {
    cashSecrets.recordPendingMintSecret('a.example', 'aa'.repeat(32))
    cashSecrets.recordPendingMintSecret('b.example', 'bb'.repeat(32))
    expect(cashSecrets.pendingMintSecretsFor('a.example')).toEqual([
      'aa'.repeat(32)
    ])
    expect(cashSecrets.pendingMintSecretsFor('b.example')).toEqual([
      'bb'.repeat(32)
    ])
  })

  it('survives a fresh module load (persisted, not just in-memory)', async () => {
    cashSecrets.recordPendingMintSecret('mint.example', 'aa'.repeat(32))
    vi.resetModules()
    const reloaded: typeof import('./cashSecrets') =
      await import('./cashSecrets')
    expect(reloaded.pendingMintSecretsFor('mint.example')).toEqual([
      'aa'.repeat(32)
    ])
  })

  it('clearPendingMintSecret removes only the named secret', () => {
    cashSecrets.recordPendingMintSecret('mint.example', 'aa'.repeat(32))
    cashSecrets.recordPendingMintSecret('mint.example', 'bb'.repeat(32))
    cashSecrets.clearPendingMintSecret('mint.example', 'aa'.repeat(32))
    expect(cashSecrets.pendingMintSecretsFor('mint.example')).toEqual([
      'bb'.repeat(32)
    ])
  })

  it('clearPendingMintSecret is a no-op for a secret never recorded', () => {
    expect(() =>
      cashSecrets.clearPendingMintSecret('mint.example', 'aa'.repeat(32))
    ).not.toThrow()
    expect(cashSecrets.pendingMintSecretsFor('mint.example')).toEqual([])
  })

  it('clearPendingMintSecrets wipes every domain', () => {
    cashSecrets.recordPendingMintSecret('a.example', 'aa'.repeat(32))
    cashSecrets.recordPendingMintSecret('b.example', 'bb'.repeat(32))
    cashSecrets.clearPendingMintSecrets()
    expect(cashSecrets.pendingMintSecretsFor('a.example')).toEqual([])
    expect(cashSecrets.pendingMintSecretsFor('b.example')).toEqual([])
  })
})
