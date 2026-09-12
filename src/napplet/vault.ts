import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {
  encryptSecretParts,
  decryptSecretParts,
  deriveBearerAesKey,
  encryptRecord,
  decryptRecord,
  isValidStoredSecret,
  isValidSeedPhrase,
  deriveStorageRootKey,
  deriveLud25CashRootNode,
  cashRootToHex,
  cashRootFromHex
} from '../keys'
import type {EncryptedRecordParts, StoredSecret} from '../keys'
import type {WalletHost} from './host'
import {parseDesign} from './design'
import type {NoteDesign} from './design'
import {cashSecretFromRoot} from '../cashSecrets'
import {parsePreferences} from './preferences'
import {validatePins, importPins} from './mints'
import type {MintPin} from './mints'
import type {HistoryEntry} from './wallet'
import {verifyMeltPreimage} from '../lnurlcash'

export type Note = {
  id: string
  url: string
  amount: number
  status: 'unverified' | 'ready' | 'pending' | 'spent' | 'shared'
  reason: string
  updatedAt: number
  invoice?: string
  invoiceType?: 'funding' | 'payment'
  designId?: string
  label?: string
  createdAt?: number
  verifyUrl?: string
  proof?: string
  hidden?: boolean
}
const KEY = 'lnurlcash-napplet:key:v1'
const PREFIX = 'lnurlcash-napplet:note:'
const DESIGN_PREFIX = 'lnurlcash-napplet:design:'
const META_PREFIX = 'lnurlcash-napplet:meta:'
export type CashState = {
  root: string
  indices: Record<string, number>
  restored: boolean
  scanned: string[]
}
type Backup = {
  type: 'lnurlcash-napplet-backup'
  version: 1
  key: StoredSecret
  notes: Record<string, EncryptedRecordParts>
  designs?: Record<string, EncryptedRecordParts>
  metadata?: Record<string, EncryptedRecordParts>
}

/** Encrypt each note independently; acknowledge durable writes before proceeding. */
export class Vault {
  private aes: CryptoKey | null = null
  constructor(private storage: WalletHost['storage']) {}

  /** Check setup without treating malformed existing data as an empty wallet. */
  async exists(): Promise<boolean> {
    return (await this.storage.getItem(KEY)) !== null
  }

  /** Create a password-protected wallet; never overwrite an existing key. */
  async create(
    password: string,
    phrase?: string,
    restored = false
  ): Promise<void> {
    if (password.length < 12) throw new Error('Use at least 12 characters.')
    if (await this.exists())
      throw new Error('A wallet already exists. Unlock it instead.')
    if (phrase !== undefined && !isValidSeedPhrase(phrase))
      throw new Error('Invalid BIP39 seed phrase.')
    const root = phrase
      ? deriveStorageRootKey(phrase)
      : crypto.getRandomValues(new Uint8Array(32))
    try {
      const encrypted = {
        enc: true,
        ...(await encryptSecretParts(bytesToHex(root), password))
      }
      this.aes = await deriveBearerAesKey(root)
      if (phrase)
        await this.setMeta<CashState>('cash', {
          root: cashRootToHex(deriveLud25CashRootNode(phrase)),
          indices: {},
          restored,
          scanned: []
        })
      await this.storage.setItem(KEY, JSON.stringify(encrypted))
    } catch (error) {
      this.aes = null
      throw error
    } finally {
      root.fill(0)
    }
  }

  /** Unlock only with the user's password; host identity is never a wallet key. */
  async unlock(password: string): Promise<void> {
    const stored = JSON.parse((await this.storage.getItem(KEY)) ?? 'null')
    if (!isValidStoredSecret(stored) || !stored.enc)
      throw new Error('Invalid wallet key record.')
    const root = hexToBytes(await decryptSecretParts(stored, password))
    try {
      this.aes = await deriveBearerAesKey(root)
    } finally {
      root.fill(0)
    }
  }

  /** Prove the seed against authenticated cash metadata before resetting its password. */
  async resetPassword(phrase: string, password: string): Promise<void> {
    if (!isValidSeedPhrase(phrase))
      throw new Error('Invalid BIP39 seed phrase.')
    if (password.length < 12) throw new Error('Use at least 12 characters.')
    const record = await this.storage.getItem(META_PREFIX + 'cash')
    if (!record)
      throw new Error('This older wallet requires its backup password.')
    const root = deriveStorageRootKey(phrase)
    try {
      const candidate = await deriveBearerAesKey(root)
      const cash = await decryptRecord<CashState>(candidate, JSON.parse(record))
      validateCashState(cash)
      if (cash.root !== cashRootToHex(deriveLud25CashRootNode(phrase)))
        throw new Error('The seed does not match this wallet.')
      await this.storage.setItem(
        KEY,
        JSON.stringify({
          enc: true,
          ...(await encryptSecretParts(bytesToHex(root), password))
        })
      )
      this.aes = candidate
    } finally {
      root.fill(0)
    }
  }

  /** Drop the in-memory encryption key. */
  lock(): void {
    this.aes = null
  }

  /** Read encrypted settings, history or recovery state through shell storage. */
  async meta<T>(name: string): Promise<T | null> {
    const key = this.requireKey()
    const raw = await this.storage.getItem(META_PREFIX + name)
    return raw === null ? null : decryptRecord<T>(key, JSON.parse(raw))
  }

  /** Persist metadata before allowing its associated action to proceed. */
  async setMeta<T extends object>(name: string, value: T): Promise<void> {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(name))
      throw new Error('Invalid metadata key.')
    await this.storage.setItem(
      META_PREFIX + name,
      JSON.stringify(await encryptRecord(this.requireKey(), value))
    )
  }

  /** Reserve a seed-derived index durably before revealing an output commitment. */
  async nextSecret(domain: string): Promise<string> {
    const cash = await this.meta<CashState>('cash')
    if (!cash) return bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
    if (cash.restored && !cash.scanned.includes(domain))
      throw new Error(
        'Scan this mint from Recovery before creating new notes with the restored seed.'
      )
    const index = Object.hasOwn(cash.indices, domain) ? cash.indices[domain] : 0
    const secret = cashSecretFromRoot(cashRootFromHex(cash.root), domain, index)
    await this.setMeta('cash', {
      ...cash,
      indices: {...cash.indices, [domain]: index + 1}
    })
    return secret
  }

  /** Read every encrypted note, failing visibly on corrupt or foreign records. */
  async notes(): Promise<Note[]> {
    const aes = this.requireKey()
    const result: Note[] = []
    for (const key of (await this.storage.keys()).filter(k =>
      k.startsWith(PREFIX)
    )) {
      const raw = await this.storage.getItem(key)
      if (raw === null)
        throw new Error('A note disappeared from shell storage.')
      const note = await decryptRecord<Note>(aes, JSON.parse(raw))
      if (!validNote(note) || key !== PREFIX + note.id)
        throw new Error('Invalid encrypted note.')
      result.push(note)
    }
    return result.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Persist ciphertext before returning; source notes remain as history. */
  async save(note: Note): Promise<void> {
    if (!validNote(note)) throw new Error('Invalid note.')
    const record = await encryptRecord(this.requireKey(), note)
    await this.storage.setItem(PREFIX + note.id, JSON.stringify(record))
  }

  /** Keep shared artwork once, encrypted alongside the bearer records. */
  async saveDesign(id: string, design: NoteDesign): Promise<void> {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('Invalid design ID.')
    const record = await encryptRecord(this.requireKey(), parseDesign(design))
    await this.storage.setItem(DESIGN_PREFIX + id, JSON.stringify(record))
  }

  /** Read the user's saved note designs. */
  async designs(): Promise<Record<string, NoteDesign>> {
    const result: Record<string, NoteDesign> = Object.create(null)
    for (const key of (await this.storage.keys()).filter(k =>
      k.startsWith(DESIGN_PREFIX)
    )) {
      const raw = await this.storage.getItem(key)
      result[key.slice(DESIGN_PREFIX.length)] = parseDesign(
        await decryptRecord(this.requireKey(), JSON.parse(raw!))
      )
    }
    return result
  }

  /** Export ciphertext and the password-wrapped key, including pending outputs. */
  async backup(): Promise<string> {
    const key = JSON.parse((await this.storage.getItem(KEY)) ?? 'null')
    if (!isValidStoredSecret(key) || !key.enc)
      throw new Error('Invalid wallet key.')
    const notes: Backup['notes'] = {}
    const designs: NonNullable<Backup['designs']> = {}
    const metadata: NonNullable<Backup['metadata']> = {}
    for (const name of (await this.storage.keys()).filter(k =>
      k.startsWith(PREFIX)
    )) {
      notes[name.slice(PREFIX.length)] = JSON.parse(
        (await this.storage.getItem(name))!
      )
    }
    for (const name of (await this.storage.keys()).filter(k =>
      k.startsWith(DESIGN_PREFIX)
    )) {
      designs[name.slice(DESIGN_PREFIX.length)] = JSON.parse(
        (await this.storage.getItem(name))!
      )
    }
    for (const name of (await this.storage.keys()).filter(k =>
      k.startsWith(META_PREFIX)
    )) {
      metadata[name.slice(META_PREFIX.length)] = JSON.parse(
        (await this.storage.getItem(name))!
      )
    }
    return JSON.stringify(
      {
        type: 'lnurlcash-napplet-backup',
        version: 1,
        key,
        notes,
        designs,
        metadata
      },
      null,
      2
    )
  }

  /** Import into an unlocked wallet, re-encrypting and deduplicating bearer secrets. */
  async restore(text: string, password: string): Promise<number> {
    if (text.length > 10 * 1024 * 1024) throw new Error('Backup exceeds 10 MB.')
    const backup = JSON.parse(text) as Backup
    if (
      backup.type !== 'lnurlcash-napplet-backup' ||
      backup.version !== 1 ||
      !isValidStoredSecret(backup.key) ||
      !backup.key.enc ||
      !backup.notes ||
      typeof backup.notes !== 'object' ||
      Array.isArray(backup.notes) ||
      Object.keys(backup.notes).length > 1000
    )
      throw new Error('Invalid napplet backup.')
    const root = hexToBytes(await decryptSecretParts(backup.key, password))
    let aes: CryptoKey
    try {
      aes = await deriveBearerAesKey(root)
    } finally {
      root.fill(0)
    }
    // Authenticate and validate the whole file before the first write.
    const incoming = await Promise.all(
      Object.values(backup.notes).map(parts => decryptRecord<Note>(aes, parts))
    )
    if (!incoming.every(validNote)) throw new Error('Invalid note in backup.')
    if (
      backup.designs &&
      (typeof backup.designs !== 'object' ||
        Array.isArray(backup.designs) ||
        Object.keys(backup.designs).length > 100)
    )
      throw new Error('Invalid backup designs.')
    const designs = await Promise.all(
      Object.entries(backup.designs ?? {}).map(
        async ([id, parts]) =>
          [id, parseDesign(await decryptRecord(aes, parts))] as const
      )
    )
    const metadata = backup.metadata ?? {}
    if (
      typeof metadata !== 'object' ||
      Array.isArray(metadata) ||
      Object.keys(metadata).length > 1000
    )
      throw new Error('Invalid backup metadata.')
    const recoveredMeta = await Promise.all(
      Object.entries(metadata).map(async ([name, record]) => {
        if (!/^[a-zA-Z0-9-]{1,80}$/.test(name))
          throw new Error('Invalid backup metadata name.')
        const value = await decryptRecord<object>(aes, record)
        if (!value || typeof value !== 'object')
          throw new Error('Invalid backup metadata value.')
        if (name === 'cash') validateCashState(value)
        if (name === 'cash-imports') {
          if (!Array.isArray(value))
            throw new Error('Invalid imported cash roots.')
          value.forEach(validateCashState)
        }
        if (name === 'mints') validatePins(value)
        if (name === 'preferences') parsePreferences(value)
        if (
          name === 'history' &&
          (!Array.isArray(value) ||
            value.some(
              entry =>
                !entry ||
                typeof entry.id !== 'string' ||
                !Number.isSafeInteger(entry.time) ||
                typeof entry.action !== 'string' ||
                typeof entry.message !== 'string'
            ))
        )
          throw new Error('Invalid history in backup.')
        return [name, value] as const
      })
    )
    const designIds = new Map<string, string>()
    for (const [id, design] of designs) {
      const newId = crypto.randomUUID()
      await this.saveDesign(newId, design)
      designIds.set(id, newId)
    }
    const existing = await this.notes()
    const known = new Set(existing.map(note => noteIdentity(note)))
    let added = 0
    for (const note of incoming) {
      const identity = noteIdentity(note)
      if (known.has(identity)) continue
      // Old ready copies must be checked online again, never silently trusted.
      await this.save({
        ...note,
        id: crypto.randomUUID(),
        designId: designIds.get(note.designId ?? 'default'),
        status: ['spent', 'shared', 'pending'].includes(note.status)
          ? note.status
          : 'unverified',
        reason: 'Restored backup; check online before using.',
        updatedAt: Date.now()
      })
      known.add(identity)
      added++
    }
    for (const [name, value] of recoveredMeta) {
      if (name === 'cash') await this.importCash(value as CashState)
      else if (name === 'cash-imports')
        for (const cash of value as CashState[]) await this.importCash(cash)
      else if (name === 'mints') await importPins(this, value as MintPin[])
      else if (name === 'history') {
        const current = (await this.meta<HistoryEntry[]>('history')) ?? []
        const ids = new Set(current.map(entry => entry.id))
        await this.setMeta(
          'history',
          [
            ...current,
            ...(value as HistoryEntry[]).filter(entry => !ids.has(entry.id))
          ].sort((a, b) => a.time - b.time)
        )
      } else if (name === 'preferences' && !(await this.meta('preferences')))
        await this.setMeta(name, parsePreferences(value))
      else if (
        name === 'mint-addresses' &&
        Array.isArray(value) &&
        value.every(address => typeof address === 'string')
      ) {
        await this.setMeta(name, [
          ...new Set([...((await this.meta<string[]>(name)) ?? []), ...value])
        ])
      } else await this.setMeta(`import-${crypto.randomUUID()}`, {name, value})
    }
    return added
  }

  /** Keep counters monotonic and retain foreign cash roots for later recovery. */
  async importCash(incoming: CashState): Promise<void> {
    validateCashState(incoming)
    const current = await this.meta<CashState>('cash')
    if (!current) {
      await this.setMeta('cash', {...incoming, restored: true, scanned: []})
      return
    }
    if (current.root !== incoming.root) {
      const imports = (await this.meta<CashState[]>('cash-imports')) ?? []
      if (!imports.some(value => value.root === incoming.root))
        await this.setMeta('cash-imports', [...imports, incoming])
      return
    }
    const indices = {...current.indices}
    for (const [domain, next] of Object.entries(incoming.indices)) {
      indices[domain] = Math.max(
        Object.hasOwn(indices, domain) ? indices[domain] : 0,
        next
      )
    }
    await this.setMeta('cash', {...current, indices})
  }

  private requireKey(): CryptoKey {
    if (!this.aes) throw new Error('Unlock the wallet first.')
    return this.aes
  }
}

const noteIdentity = (note: Note): string => {
  const url = new URL(note.url)
  return `${url.origin}${url.pathname}:${url.searchParams.get('k1')}`
}

export const validNote = (value: Note): boolean => {
  if (
    !value ||
    typeof value.id !== 'string' ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(value.id) ||
    typeof value.url !== 'string' ||
    value.url.length > 16000 ||
    !Number.isSafeInteger(value.amount) ||
    value.amount < 0 ||
    !Number.isSafeInteger(value.updatedAt) ||
    typeof value.reason !== 'string' ||
    (value.hidden !== undefined && typeof value.hidden !== 'boolean') ||
    (value.invoiceType !== undefined &&
      !['funding', 'payment'].includes(value.invoiceType)) ||
    (value.proof !== undefined &&
      (typeof value.proof !== 'string' ||
        !value.invoice ||
        !verifyMeltPreimage(value.invoice, value.proof))) ||
    (value.label !== undefined &&
      (typeof value.label !== 'string' || value.label.length > 200)) ||
    (value.verifyUrl !== undefined &&
      (typeof value.verifyUrl !== 'string' ||
        value.verifyUrl.length > 16000)) ||
    (value.designId !== undefined &&
      !/^[a-zA-Z0-9-]{1,80}$/.test(value.designId)) ||
    !['unverified', 'ready', 'pending', 'spent', 'shared'].includes(
      value.status
    ) ||
    (value.invoice !== undefined &&
      (typeof value.invoice !== 'string' || value.invoice.length > 16000))
  )
    return false
  try {
    const url = new URL(value.url)
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !!url.searchParams.get('k1')
    )
  } catch {
    return false
  }
}

/** Validate imported derivation state before it can affect future note generation. */
export function validateCashState(value: unknown): asserts value is CashState {
  const cash = value as CashState
  if (
    !cash ||
    typeof cash.root !== 'string' ||
    !/^[a-f0-9]{128}$/i.test(cash.root) ||
    !cash.indices ||
    typeof cash.indices !== 'object' ||
    Array.isArray(cash.indices) ||
    typeof cash.restored !== 'boolean' ||
    !Array.isArray(cash.scanned) ||
    !cash.scanned.every(
      domain => typeof domain === 'string' && domain.length <= 500
    ) ||
    Object.entries(cash.indices).some(
      ([domain, index]) =>
        domain.length > 500 ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= 0x80000000
    )
  )
    throw new Error('Invalid cash recovery state.')
  cashRootFromHex(cash.root)
}
