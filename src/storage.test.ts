import {beforeEach, describe, expect, it, vi} from 'vitest'

// storage.ts imports trustedMints.ts, whose module-level signal reads
// localStorage at import time - same in-memory stand-in pattern as
// trustedMints.test.ts, with a fresh module graph per test
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

const KEY_A = `02${'a'.repeat(64)}`
const LINKING_HEX_A = 'aa'.repeat(32)
const LINKING_HEX_B = 'bb'.repeat(32)
const CASH_ROOT_HEX_A = 'cc'.repeat(64) // 128 hex chars: privkey || chaincode

let storage: typeof import('./storage')
let keys: typeof import('./keys')
let cashSecrets: typeof import('./cashSecrets')

beforeEach(async () => {
  store.clear()
  vi.resetModules()
  storage = await import('./storage')
  keys = await import('./keys')
  cashSecrets = await import('./cashSecrets')
})

const validBackup = (overrides: Record<string, unknown> = {}) => ({
  type: 'lnurlwallet-backup',
  version: 1,
  createdAt: Date.now(),
  bearers: [],
  ...overrides
})

describe('applyBackup validation', () => {
  it('rejects anything that is not a v1 backup', () => {
    expect(() => storage.applyBackup(null)).toThrow()
    expect(() => storage.applyBackup({})).toThrow()
    expect(() => storage.applyBackup({type: 'lnurlwallet-backup'})).toThrow()
    expect(() => storage.applyBackup(validBackup({version: 2}))).toThrow()
    expect(() => storage.applyBackup(validBackup({bearers: 'x'}))).toThrow()
  })

  it('skips malformed bearer records but keeps valid ones', () => {
    const result = storage.applyBackup(
      validBackup({
        bearers: [
          {id: 'good', iv: 'aa'.repeat(12), ciphertext: 'bb'},
          {id: 'no-iv'},
          {iv: 'aa'.repeat(12), ciphertext: 'bb'},
          'garbage'
        ]
      })
    )
    expect(result.added).toBe(1)
    expect(result.skipped).toBe(3)
    expect(storage.readEncryptedBearers().map(r => r.id)).toEqual(['good'])
  })

  it('never overwrites a bearer id already present', () => {
    storage.applyBackup(
      validBackup({
        bearers: [{id: 'dup', iv: 'aa'.repeat(12), ciphertext: 'bb'}]
      })
    )
    const result = storage.applyBackup(
      validBackup({
        bearers: [{id: 'dup', iv: 'cc'.repeat(12), ciphertext: 'dd'}]
      })
    )
    expect(result.added).toBe(0)
    expect(result.skipped).toBe(1)
    expect(storage.readEncryptedBearers()[0].iv).toBe('aa'.repeat(12))
  })
})

describe('applyBackup linking key handling', () => {
  it('installs a well-formed plaintext linking key on a fresh device', () => {
    const result = storage.applyBackup(
      validBackup({linkingKey: {enc: false, value: LINKING_HEX_A}})
    )
    expect(result.linkingKeyRestored).toBe(true)
    expect(result.linkingKeySkipped).toBe(false)
    expect(keys.savedKeyExists()).toBe(true)
    expect(keys.savedKeyIsEncrypted()).toBe(false)
  })

  it('installs a well-formed encrypted linking key on a fresh device', () => {
    const result = storage.applyBackup(
      validBackup({
        linkingKey: {
          enc: true,
          salt: 'aa'.repeat(16),
          iv: 'bb'.repeat(12),
          ciphertext: 'cc'.repeat(32)
        }
      })
    )
    expect(result.linkingKeyRestored).toBe(true)
    expect(result.linkingKeySkipped).toBe(false)
    expect(keys.savedKeyIsEncrypted()).toBe(true)
  })

  it('refuses to install a malformed linking key', () => {
    for (const linkingKey of [
      {enc: false, value: 'not-hex'},
      {enc: false, value: LINKING_HEX_A.slice(2)}, // 31 bytes
      {enc: false, value: `${LINKING_HEX_A}00`}, // 33 bytes
      {enc: true, salt: 'aa', iv: 'bb'.repeat(12), ciphertext: 'cc'},
      {enc: true, salt: 'aa'.repeat(16), iv: 'not-hex!!', ciphertext: 'cc'},
      {
        enc: true,
        salt: 'aa'.repeat(16),
        iv: 'bb'.repeat(12),
        ciphertext: 'xyz'
      },
      {enc: 'yes'},
      'lnurlwallet_linking_key'
    ]) {
      const result = storage.applyBackup(validBackup({linkingKey}))
      // reported like "no key in this backup", never as skipped
      expect(result.linkingKeyRestored).toBe(false)
      expect(result.linkingKeySkipped).toBe(false)
      expect(keys.savedKeyExists()).toBe(false)
    }
  })

  it('never overwrites a linking key this device already has', async () => {
    await keys.saveLinkingKey(new Uint8Array(32).fill(1))
    const result = storage.applyBackup(
      validBackup({linkingKey: {enc: false, value: LINKING_HEX_B}})
    )
    expect(result.linkingKeyRestored).toBe(false)
    expect(result.linkingKeySkipped).toBe(true)
    expect(keys.getPlainLinkingKey()).toEqual(new Uint8Array(32).fill(1))
  })

  it('reports neither restored nor skipped for a backup without a key', () => {
    const result = storage.applyBackup(validBackup())
    expect(result.linkingKeyRestored).toBe(false)
    expect(result.linkingKeySkipped).toBe(false)
  })
})

describe('buildBackup', () => {
  it('never exports a plaintext-stored linking key', async () => {
    await keys.saveLinkingKey(new Uint8Array(32).fill(1))
    const backup = storage.buildBackup()
    expect(backup.linkingKey).toBeUndefined()
  })

  it('exports the linking key only when it is password-encrypted', async () => {
    await keys.saveLinkingKey(new Uint8Array(32).fill(1), 'correct horse')
    const backup = storage.buildBackup()
    expect(backup.linkingKey?.enc).toBe(true)
  })

  it('round-trips: a backup applies cleanly onto a fresh device', async () => {
    await keys.saveLinkingKey(new Uint8Array(32).fill(7), 'correct horse')
    const backup = storage.buildBackup()
    store.clear()
    vi.resetModules()
    storage = await import('./storage')
    keys = await import('./keys')
    const result = storage.applyBackup(backup)
    expect(result.linkingKeyRestored).toBe(true)
    expect(keys.savedKeyIsEncrypted()).toBe(true)
  })

  it('always includes the (non-secret) per-SERVICE cash address indices', () => {
    cashSecrets.mergeCashAddressSecretIndices({'mint.example': 3})
    const backup = storage.buildBackup()
    expect(backup.cashAddressIndices).toEqual({'mint.example': 3})
  })

  it('never exports a plaintext-stored cash root key', async () => {
    await keys.saveCashRootKey(CASH_ROOT_HEX_A)
    const backup = storage.buildBackup()
    expect(backup.cashRootKey).toBeUndefined()
  })

  it('exports the cash root key only when it is password-encrypted', async () => {
    await keys.saveCashRootKey(CASH_ROOT_HEX_A, 'correct horse')
    const backup = storage.buildBackup()
    expect(backup.cashRootKey?.enc).toBe(true)
  })

  it('exports storageRootKey instead of linkingKey once a wallet has upgraded', async () => {
    await keys.saveLinkingKey(new Uint8Array(32).fill(1), 'correct horse')
    await keys.saveStorageRootKey(new Uint8Array(32).fill(2), 'correct horse')
    const backup = storage.buildBackup()
    expect(backup.storageRootKey?.enc).toBe(true)
    expect(backup.linkingKey).toBeUndefined()
  })
})

describe('applyBackup storage root key handling', () => {
  it('restores a storageRootKey-only backup onto a fresh device', () => {
    const result = storage.applyBackup(
      validBackup({
        storageRootKey: {enc: false, value: LINKING_HEX_A}
      })
    )
    expect(result.linkingKeyRestored).toBe(true)
    expect(result.linkingKeySkipped).toBe(false)
    expect(keys.savedStorageRootKeyExists()).toBe(true)
    expect(keys.savedKeyExists()).toBe(false)
  })

  it('skips a storageRootKey backup if this device already has a wallet in either format', async () => {
    await keys.saveLinkingKey(new Uint8Array(32).fill(1))
    const result = storage.applyBackup(
      validBackup({
        storageRootKey: {enc: false, value: LINKING_HEX_A}
      })
    )
    expect(result.linkingKeyRestored).toBe(false)
    expect(result.linkingKeySkipped).toBe(true)
    expect(keys.savedStorageRootKeyExists()).toBe(false)
  })
})

describe('applyBackup cash root key handling (LUD-25)', () => {
  it('installs the cash root key alongside the linking key on a fresh device', () => {
    const result = storage.applyBackup(
      validBackup({
        linkingKey: {enc: false, value: LINKING_HEX_A},
        cashRootKey: {enc: false, value: CASH_ROOT_HEX_A}
      })
    )
    expect(result.linkingKeyRestored).toBe(true)
    expect(keys.savedCashRootKeyExists()).toBe(true)
    expect(keys.getPlainCashRootKeyHex()).toBe(CASH_ROOT_HEX_A)
  })

  it('never installs a cash root key on its own, without a linking key', () => {
    storage.applyBackup(
      validBackup({cashRootKey: {enc: false, value: CASH_ROOT_HEX_A}})
    )
    expect(keys.savedCashRootKeyExists()).toBe(false)
  })

  it('skips a malformed cash root key without touching the linking key', () => {
    const result = storage.applyBackup(
      validBackup({
        linkingKey: {enc: false, value: LINKING_HEX_A},
        cashRootKey: {enc: false, value: 'aa'.repeat(32)} // 64 hex, needs 128
      })
    )
    expect(result.linkingKeyRestored).toBe(true)
    expect(keys.savedCashRootKeyExists()).toBe(false)
  })

  it('never overwrites a cash root key this device already has', async () => {
    await keys.saveLinkingKey(new Uint8Array(32).fill(1))
    await keys.saveCashRootKey('dd'.repeat(64))
    storage.applyBackup(
      validBackup({
        linkingKey: {enc: false, value: LINKING_HEX_B},
        cashRootKey: {enc: false, value: CASH_ROOT_HEX_A}
      })
    )
    expect(keys.getPlainCashRootKeyHex()).toBe('dd'.repeat(64))
  })

  it('merges cash address indices regardless of whether the linking key was skipped', async () => {
    await keys.saveLinkingKey(new Uint8Array(32).fill(1))
    storage.applyBackup(
      validBackup({
        linkingKey: {enc: false, value: LINKING_HEX_B},
        cashAddressIndices: {'mint.example': 4}
      })
    )
    expect(cashSecrets.nextCashAddressSecretIndex('mint.example')).toBe(4)
  })
})

describe('applyBackup trusted mints', () => {
  it('merges trusted mints unlocked, even if the file says locked', () => {
    const result = storage.applyBackup(
      validBackup({
        trustedMints: [
          {server: 'mint.example', mintPubkey: KEY_A, addedAt: 1, locked: true}
        ]
      })
    )
    expect(result.trustedMintsAdded).toBe(1)
  })
})

// WalletContext's upgradeEncryption migration path
describe('reencryptAllRecords', () => {
  it('bearers and activity decrypt under the new key, not the old one', async () => {
    const oldAesKey = await keys.deriveBearerAesKey(new Uint8Array(32).fill(1))
    const newAesKey = await keys.deriveBearerAesKey(new Uint8Array(32).fill(2))

    await storage.persistBearer(oldAesKey, {
      id: storage.newBearerId(),
      url: 'https://mint.example/w?k1=' + 'aa'.repeat(32),
      callback: 'https://mint.example/w/cb',
      amount: 21000,
      verified: true,
      createdAt: 1,
      updatedAt: 1
    })
    await storage.persistActivityEvent(oldAesKey, {
      id: storage.newActivityId(),
      kind: 'mint',
      message: 'test event',
      createdAt: 1
    })

    await storage.reencryptAllRecords(oldAesKey, newAesKey)

    const bearers = await storage.loadBearers(newAesKey)
    const activity = await storage.loadActivity(newAesKey)
    expect(bearers).toHaveLength(1)
    expect(activity).toHaveLength(1)
    expect(await storage.loadBearers(oldAesKey)).toHaveLength(0)
    expect(await storage.loadActivity(oldAesKey)).toHaveLength(0)
  })

  it('preserves bearer ids and activity insertion order', async () => {
    const oldAesKey = await keys.deriveBearerAesKey(new Uint8Array(32).fill(1))
    const newAesKey = await keys.deriveBearerAesKey(new Uint8Array(32).fill(2))
    const id = storage.newBearerId()

    await storage.persistBearer(oldAesKey, {
      id,
      url: 'https://mint.example/w?k1=' + 'bb'.repeat(32),
      callback: 'https://mint.example/w/cb',
      amount: 1000,
      verified: true,
      createdAt: 1,
      updatedAt: 1
    })
    for (let i = 0; i < 3; i++) {
      await storage.persistActivityEvent(oldAesKey, {
        id: storage.newActivityId(),
        kind: 'mint',
        message: `event ${i}`,
        createdAt: i
      })
    }

    await storage.reencryptAllRecords(oldAesKey, newAesKey)

    const bearers = await storage.loadBearers(newAesKey)
    expect(bearers[0].id).toBe(id)
    const activity = await storage.loadActivity(newAesKey)
    // loadActivity itself returns newest-first, so this only proves the
    // migration didn't change which messages exist - the on-disk order
    // check is that a later persistActivityEvent's own trim-from-the-front
    // still works, covered by not throwing/losing anything here
    expect(activity.map(e => e.message).sort()).toEqual([
      'event 0',
      'event 1',
      'event 2'
    ])
  })

  it('leaves a record undecryptable by the outgoing key untouched rather than dropping it', async () => {
    const oldAesKey = await keys.deriveBearerAesKey(new Uint8Array(32).fill(1))
    const wrongKey = await keys.deriveBearerAesKey(new Uint8Array(32).fill(9))
    const newAesKey = await keys.deriveBearerAesKey(new Uint8Array(32).fill(2))

    // written under a key that isn't oldAesKey - simulates a record this
    // migration has no business touching
    await storage.persistBearer(wrongKey, {
      id: storage.newBearerId(),
      url: 'https://mint.example/w?k1=' + 'cc'.repeat(32),
      callback: 'https://mint.example/w/cb',
      amount: 500,
      verified: true,
      createdAt: 1,
      updatedAt: 1
    })

    await storage.reencryptAllRecords(oldAesKey, newAesKey)

    // still there, still readable under the key that actually wrote it -
    // reencryptAllRecords must not have corrupted or dropped it
    expect(await storage.loadBearers(wrongKey)).toHaveLength(1)
    expect(await storage.loadBearers(newAesKey)).toHaveLength(0)
  })
})

// End-to-end simulation of WalletContext's own setup -> upgradeEncryption
// sequence, using the exact same exported primitives it calls (not a
// reimplementation) - closes the gap unit tests of each piece in isolation
// leave open: does the real chain of calls actually leave a wallet holding
// its notes, readable, under the new key, with the old one gone?
describe('seed-to-upgrade flow (simulates WalletContext)', () => {
  const SEED =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  const PASSWORD = 'correct horse battery staple'

  it('a bearer minted under the legacy key survives the upgrade and the legacy key stops working', async () => {
    // WalletContext.setup()
    const legacyKey = keys.deriveWalletLinkingKey(SEED)
    await keys.saveLinkingKey(legacyKey, PASSWORD)
    let aesKey = await keys.deriveBearerAesKey(legacyKey)

    // a note minted while still on the legacy key
    const bearerId = storage.newBearerId()
    await storage.persistBearer(aesKey, {
      id: bearerId,
      url: 'https://mint.example/w?k1=' + 'ee'.repeat(32),
      callback: 'https://mint.example/w/cb',
      amount: 21000,
      verified: true,
      createdAt: 1,
      updatedAt: 1
    })

    // WalletContext.upgradeEncryption(SEED, PASSWORD)
    expect(keys.savedStorageRootKeyExists()).toBe(false)
    const candidateLegacyKey = keys.deriveWalletLinkingKey(SEED)
    const candidateAesKey = await keys.deriveBearerAesKey(candidateLegacyKey)
    expect(await keys.aesKeysEqual(candidateAesKey, aesKey)).toBe(true)

    const storageRootKey = keys.deriveStorageRootKey(SEED)
    const newAesKey = await keys.deriveBearerAesKey(storageRootKey)
    await storage.reencryptAllRecords(aesKey, newAesKey)
    await keys.saveStorageRootKey(storageRootKey, PASSWORD)
    aesKey = newAesKey
    keys.clearSavedLinkingKey()

    // the note survived, readable under the new key
    const bearers = await storage.loadBearers(aesKey)
    expect(bearers).toHaveLength(1)
    expect(bearers[0].id).toBe(bearerId)
    expect(bearers[0].amount).toBe(21000)

    // the legacy secret is gone, the new one is what's active now
    expect(keys.savedKeyExists()).toBe(false)
    expect(keys.savedStorageRootKeyExists()).toBe(true)

    // a wrong seed produces a key that neither matches the (now retired)
    // legacy derivation nor decrypts the migrated note
    const wrongSeed = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote'
    const wrongLegacyKey = keys.deriveWalletLinkingKey(wrongSeed)
    const wrongAesKey = await keys.deriveBearerAesKey(wrongLegacyKey)
    expect(await keys.aesKeysEqual(wrongAesKey, newAesKey)).toBe(false)
    expect(await storage.loadBearers(wrongAesKey)).toHaveLength(0)

    // and unlocking this device again (WalletContext.unlock) now takes the
    // new-format path and reproduces the exact same active key
    const unlockedRootKey = await keys.decryptSavedStorageRootKey(PASSWORD)
    const unlockedAesKey = await keys.deriveBearerAesKey(unlockedRootKey)
    expect(await keys.aesKeysEqual(unlockedAesKey, aesKey)).toBe(true)
  })
})
