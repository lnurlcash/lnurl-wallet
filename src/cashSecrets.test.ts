import {beforeEach, describe, expect, it, vi} from 'vitest'
import {schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex} from '@noble/hashes/utils.js'
import {
  deriveNotePubkey,
  legacyDeriveNoteSecretKey,
  LEGACY_NOTE_PURPOSE_WALLET,
  LEGACY_NOTE_PURPOSE_LIGHTNING_ADDRESS
} from './lib/recoverableNotes'
import {
  deriveDomainBranchNode,
  deriveServiceRoot,
  deriveNoteKey
} from './lib/branchDerivation'

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

describe('LUD-26: wallet and change notes below S', () => {
  it('are null with no root set', () => {
    expect(cashSecrets.cashAddressSecretAtIndex('mint.example', 0)).toBeNull()
    expect(cashSecrets.changeSecretAtIndex('mint.example', 0)).toBeNull()
    expect(cashSecrets.addressShareCx1('mint.example', 0)).toBeNull()
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

  it("derives wallet notes at S/0'/0/i and change notes at S/0'/1/i", () => {
    const root = loadRoot()
    const S = deriveServiceRoot(root, 'mint.example')
    for (const index of [0, 1, 7]) {
      expect(
        bytesToHex(cashSecrets.cashAddressSecretAtIndex('mint.example', index)!)
      ).toBe(
        bytesToHex(
          deriveNoteKey(S, {chain: 'wallet', account: 0, index}).secretKey
        )
      )
      expect(
        bytesToHex(cashSecrets.changeSecretAtIndex('mint.example', index)!)
      ).toBe(
        bytesToHex(
          deriveNoteKey(S, {chain: 'change', account: 0, index}).secretKey
        )
      )
    }
  })

  it('names the mint by its hostname: port and scheme do not matter', () => {
    loadRoot()
    const at = (domain: string) =>
      bytesToHex(cashSecrets.cashAddressSecretAtIndex(domain, 0)!)
    expect(at('mint.example:8443')).toBe(at('mint.example'))
    expect(at('https://mint.example')).toBe(at('mint.example'))
    expect(at('other.example')).not.toBe(at('mint.example'))
  })

  it('is pure - repeated calls at the same index are stable', () => {
    loadRoot()
    expect(
      bytesToHex(cashSecrets.cashAddressSecretAtIndex('mint.example', 3)!)
    ).toBe(bytesToHex(cashSecrets.cashAddressSecretAtIndex('mint.example', 3)!))
  })
})

describe('LUD-25: wallet-initiated secrets (nextCashAddressSecret)', () => {
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

// A bearer note's own reload-survival (see lnurlcash.ts's generateMintSecret) -
// deliberately plain localStorage, not seed-derived (25.md defines no
// derivation for bearer notes - see this module's own header comment)
describe('pending mint secrets (bearer note reload-survival)', () => {
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

// a rotate/split/merge's own plain output (lnurlcash.ts's generateNoteSecret),
// journaled before its hash is disclosed - see pendingOutputs.ts
describe('pending output secrets', () => {
  it('records with a timestamp and ignores duplicates', () => {
    cashSecrets.recordPendingOutputSecret('mint.example', 'aa'.repeat(32), 5)
    cashSecrets.recordPendingOutputSecret('mint.example', 'aa'.repeat(32), 9)
    expect(cashSecrets.pendingOutputSecrets()).toEqual({
      'mint.example': [{secret: 'aa'.repeat(32), createdAt: 5}]
    })
  })

  it('clearPendingOutputSecret finds the secret under any domain', () => {
    cashSecrets.recordPendingOutputSecret('a.example', 'aa'.repeat(32))
    cashSecrets.recordPendingOutputSecret('b.example', 'bb'.repeat(32))
    cashSecrets.clearPendingOutputSecret('bb'.repeat(32))
    expect(Object.keys(cashSecrets.pendingOutputSecrets())).toEqual([
      'a.example'
    ])
  })

  it('survives a fresh module load', async () => {
    cashSecrets.recordPendingOutputSecret('mint.example', 'aa'.repeat(32))
    vi.resetModules()
    const reloaded: typeof import('./cashSecrets') =
      await import('./cashSecrets')
    expect(
      reloaded.pendingOutputSecrets()['mint.example'].map(e => e.secret)
    ).toEqual(['aa'.repeat(32)])
  })

  it('clearPendingOutputSecrets wipes the journal', () => {
    cashSecrets.recordPendingOutputSecret('mint.example', 'aa'.repeat(32))
    cashSecrets.clearPendingOutputSecrets()
    expect(cashSecrets.pendingOutputSecrets()).toEqual({})
  })
})

describe('Lightning Address shares', () => {
  it("gives every share its own cx1, whose notes the share's holder derives", () => {
    loadRoot()
    const cx1 = cashSecrets.addressShareCx1('mint.example', 1)!
    const other = cashSecrets.addressShareCx1('mint.example', 2)!
    expect(bytesToHex(cx1.pubkey)).not.toBe(bytesToHex(other.pubkey))
    for (const index of [0, 5]) {
      const secretKey = cashSecrets.shareSecretAtIndex(
        'mint.example',
        1,
        index
      )!
      expect(bytesToHex(schnorr.getPublicKey(secretKey))).toBe(
        bytesToHex(deriveNotePubkey(cx1, index))
      )
    }
  })

  it("signs a share's proofs with the share node's own key", () => {
    loadRoot()
    const cx1 = cashSecrets.addressShareCx1('mint.example', 0)!
    const key = cashSecrets.addressShareKey('mint.example', 0)!
    expect(bytesToHex(schnorr.getPublicKey(key))).toBe(
      bytesToHex(cx1.pubkey.slice(1))
    )
  })
})

describe('superseded derivation (sweep only)', () => {
  it('reproduces the old tweak notes off the host as stored', () => {
    const root = loadRoot()
    const branch = deriveDomainBranchNode(root, 'mint.example:8443')
    expect(
      bytesToHex(
        cashSecrets.legacySecretAtIndex(
          'mint.example:8443',
          LEGACY_NOTE_PURPOSE_WALLET,
          4
        )!
      )
    ).toBe(
      bytesToHex(
        legacyDeriveNoteSecretKey(
          branch.privateKey!,
          branch.chainCode!,
          LEGACY_NOTE_PURPOSE_WALLET,
          4
        )
      )
    )
  })

  it("proves an old registration with its slot node's own key (x(P) of the old cx1), and finds its notes under purpose 2", () => {
    const root = loadRoot()
    const branch = deriveDomainBranchNode(root, 'mint.example')
    const slotNode = branch.deriveChild(0x80000000 + 2)
    expect(
      bytesToHex(cashSecrets.legacyAddressProofKey('mint.example', 2)!)
    ).toBe(bytesToHex(slotNode.privateKey!))
    expect(bytesToHex(cashSecrets.legacyAddressProofKey('mint.example')!)).toBe(
      bytesToHex(branch.privateKey!)
    )
    expect(
      bytesToHex(cashSecrets.legacyAddressSecretAtIndex('mint.example', 3, 2)!)
    ).toBe(
      bytesToHex(
        legacyDeriveNoteSecretKey(
          slotNode.privateKey!,
          slotNode.chainCode!,
          LEGACY_NOTE_PURPOSE_LIGHTNING_ADDRESS,
          3
        )
      )
    )
  })

  it('starts the new counters at 0 whatever the old ones said', () => {
    store.set(
      'lnurlcash_cash_address_indices',
      JSON.stringify({'mint.example': 40})
    )
    expect(cashSecrets.nextCashAddressSecretIndex('mint.example')).toBe(0)
    cashSecrets.clearCashAddressSecretIndices()
    expect(store.has('lnurlcash_cash_address_indices')).toBe(false)
  })
})
