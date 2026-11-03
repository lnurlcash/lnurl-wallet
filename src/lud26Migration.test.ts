import {beforeEach, describe, expect, it, vi} from 'vitest'
import {schnorr} from '@noble/curves/secp256k1.js'
import {encodeCk1, signNoteOwnership} from './lnurlcash'
import type {Bearer} from './storage'

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
const HOST = 'mint.example'
const SERVER = `https://${HOST}`

let migration: typeof import('./lud26Migration')
let cashSecrets: typeof import('./cashSecrets')
let registry: typeof import('./addressRegistry')

beforeEach(async () => {
  store.clear()
  vi.resetModules()
  migration = await import('./lud26Migration')
  cashSecrets = await import('./cashSecrets')
  registry = await import('./addressRegistry')
  const keys = await import('./keys')
  cashSecrets.setCashRoot(keys.deriveLud25CashRootNode(SEED))
})

let nextId = 0
const noteOf = (secretKey: Uint8Array, extra: Partial<Bearer> = {}): Bearer => {
  const {pubkeyXOnly, signature} = signNoteOwnership(secretKey, HOST)
  return {
    id: `n${nextId++}`,
    url: `${SERVER}/w?k1=${encodeCk1(pubkeyXOnly, signature)}&amount=21000`,
    callback: `${SERVER}/w/cb`,
    amount: 21000,
    verified: true,
    createdAt: 0,
    updatedAt: 0,
    ...extra
  }
}

describe('notesToMigrate', () => {
  it('leaves notes on the wallet, change and share chains alone', () => {
    registry.addRegisteredAddress(SERVER, 'alice', undefined, 1)
    const notes = [
      noteOf(cashSecrets.cashAddressSecretAtIndex(HOST, 3)!),
      noteOf(cashSecrets.changeSecretAtIndex(HOST, 0)!),
      noteOf(cashSecrets.shareSecretAtIndex(HOST, 1, 2)!)
    ]
    expect(migration.notesToMigrate(notes)).toEqual([])
  })

  it('flags a note from before LUD-26, and one received from someone else', () => {
    const legacy = noteOf(cashSecrets.legacySecretAtIndex(HOST, 0, 0)!)
    const received = noteOf(schnorr.utils.randomSecretKey())
    expect(migration.notesToMigrate([legacy, received])).toEqual([
      legacy,
      received
    ])
  })

  it('covers the wallet chain past its counter only by the margin', () => {
    const far = noteOf(cashSecrets.cashAddressSecretAtIndex(HOST, 25)!)
    expect(migration.notesToMigrate([far])).toEqual([far])
    cashSecrets.mergeCashAddressSecretIndices({[HOST]: 10})
    expect(migration.notesToMigrate([far])).toEqual([])
  })

  it('ignores spent, device-held and plain bearer notes', () => {
    const legacy = cashSecrets.legacySecretAtIndex(HOST, 0, 0)!
    const bearer: Bearer = {
      ...noteOf(legacy),
      url: `${SERVER}/w?k1=${'ab'.repeat(32)}&amount=21000`
    }
    expect(
      migration.notesToMigrate([
        noteOf(legacy, {spent: true}),
        noteOf(legacy, {deviceId: 'dev'}),
        bearer
      ])
    ).toEqual([])
  })

  it('flags nothing while the wallet is locked', () => {
    const received = noteOf(schnorr.utils.randomSecretKey())
    cashSecrets.setCashRoot(null)
    expect(migration.notesToMigrate([received])).toEqual([])
  })
})

describe('addressesToMigrate', () => {
  it('lists only registrations without a LUD-26 share', () => {
    registry.addRegisteredAddress(SERVER, 'old', undefined, undefined, 2)
    registry.addRegisteredAddress(SERVER, 'new', undefined, 0)
    expect(migration.addressesToMigrate().map(a => a.username)).toEqual(['old'])
    registry.moveRegisteredAddress(SERVER, 'old', 1)
    expect(migration.addressesToMigrate()).toEqual([])
  })
})
