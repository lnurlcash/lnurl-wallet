import {hexToBytes} from '@noble/hashes/utils.js'
import {Vault, validNote, validateCashState} from './vault'
import type {CashState, Note} from './vault'
import {
  deriveBearerAesKey,
  decryptSecretParts,
  encryptSecretParts,
  isValidStoredSecret,
  encryptRecord,
  decryptRecord,
  isValidSeedPhrase,
  deriveStorageRootKey,
  deriveWalletLinkingKey
} from '../keys'
import type {StoredSecret} from '../keys'
import type {BackupFile, Bearer} from '../storage'
import {noteEndpointOf, noteK1} from '../lnurlcash'
import {importPins, validatePins} from './mints'
import type {MintPin} from './mints'

const unwrap = async (
  stored: StoredSecret,
  password: string
): Promise<string> =>
  stored.enc === false ? stored.value : decryptSecretParts(stored, password)

/** Export notes in the original webwallet format; secrets remain encrypted. */
export const exportWebBackup = async (
  vault: Vault,
  password: string
): Promise<string> => {
  const own = JSON.parse(await vault.backup())
  const root = hexToBytes(await unwrap(own.key, password))
  const key = await deriveBearerAesKey(root)
  root.fill(0)
  const bearers: BackupFile['bearers'] = []
  for (const note of await vault.notes()) {
    const bearer: Omit<Bearer, 'id'> = {
      url: note.url,
      callback: '',
      amount: note.amount,
      verified: false,
      spent: ['spent', 'shared', 'pending'].includes(note.status),
      label: note.label,
      createdAt: note.createdAt ?? note.updatedAt,
      updatedAt: note.updatedAt
    }
    bearers.push({id: note.id, ...(await encryptRecord(key, bearer))})
  }
  const cash = await vault.meta<CashState>('cash')
  const backup: BackupFile = {
    type: 'lnurlwallet-backup',
    version: 1,
    createdAt: Date.now(),
    storageRootKey: own.key,
    bearers,
    cashIndices: cash?.indices,
    trustedMints: ((await vault.meta<MintPin[]>('mints')) ?? []).map(pin => ({
      server: pin.origin,
      mintPubkey: pin.key,
      addedAt: Date.now(),
      locked: true,
      unconfirmed: !pin.confirmed
    })),
    cashRootKey: cash
      ? {enc: true, ...(await encryptSecretParts(cash.root, password))}
      : undefined
  }
  return JSON.stringify(backup, null, 2)
}

/** Decrypt and validate a webwallet backup completely, then merge into the current vault. */
export const importWebBackup = async (
  vault: Vault,
  text: string,
  password: string,
  seed = ''
): Promise<{added: number; deviceMirrors: number}> => {
  if (text.length > 10 * 1024 * 1024) throw new Error('Backup exceeds 10 MB.')
  const data = JSON.parse(text) as BackupFile
  if (
    data?.type !== 'lnurlwallet-backup' ||
    data.version !== 1 ||
    !Array.isArray(data.bearers) ||
    data.bearers.length > 10000
  )
    throw new Error('Invalid webwallet backup.')
  const saved = data.storageRootKey ?? data.linkingKey
  let root: Uint8Array
  if (saved) {
    if (!isValidStoredSecret(saved))
      throw new Error('Invalid backup encryption key.')
    root = hexToBytes(await unwrap(saved, password))
  } else {
    if (!isValidSeedPhrase(seed))
      throw new Error('This backup needs its original BIP39 seed.')
    root = deriveStorageRootKey(seed)
  }
  let key = await deriveBearerAesKey(root)
  root.fill(0)
  const decode = () =>
    Promise.all(
      data.bearers.map(async record => ({
        ...(await decryptRecord<Bearer>(key, record)),
        id: record.id
      }))
    )
  let bearers: Bearer[]
  try {
    bearers = await decode()
  } catch (error) {
    if (saved || !isValidSeedPhrase(seed)) throw error
    const legacy = deriveWalletLinkingKey(seed)
    key = await deriveBearerAesKey(legacy)
    legacy.fill(0)
    bearers = await decode()
  }
  let deviceMirrors = 0
  const notes: Note[] = []
  for (const bearer of bearers) {
    if (bearer.deviceId) {
      deviceMirrors++
      continue
    }
    const note: Note = {
      id: crypto.randomUUID(),
      url: bearer.url,
      amount: bearer.amount,
      status: bearer.spent ? 'shared' : 'unverified',
      label: bearer.label,
      createdAt: bearer.createdAt,
      updatedAt: Date.now(),
      reason: 'Imported from webwallet; check online and rotate before use.'
    }
    if (!validNote(note)) throw new Error('Invalid note in webwallet backup.')
    notes.push(note)
  }
  let cash: CashState | undefined
  const importedPins = validatePins(
    (data.trustedMints ?? []).map(pin => ({
      origin: pin.server,
      key: pin.mintPubkey
    }))
  )
  if (data.cashRootKey) {
    if (!isValidStoredSecret(data.cashRootKey, 128))
      throw new Error('Invalid backup cash key.')
    cash = {
      root: await unwrap(data.cashRootKey, password),
      indices: data.cashIndices ?? {},
      restored: true,
      scanned: []
    }
    validateCashState(cash)
  }
  const identity = (note: Note) =>
    `${noteEndpointOf(note.url)}:${noteK1(note.url)}`
  const known = new Set((await vault.notes()).map(identity))
  let added = 0
  for (const note of notes) {
    if (known.has(identity(note))) continue
    await vault.save(note)
    known.add(identity(note))
    added++
  }
  if (cash) await vault.importCash(cash)
  if (importedPins.length) await importPins(vault, importedPins)
  return {added, deviceMirrors}
}
