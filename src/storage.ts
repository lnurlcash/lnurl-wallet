import type {EncryptedRecordParts, StoredSecret} from './keys'
import {
  encryptRecord,
  decryptRecord,
  getSavedLinkingKeyStored,
  savedKeyExists,
  savedKeyIsEncrypted,
  restoreLinkingKeyStored,
  getSavedStorageRootKeyStored,
  savedStorageRootKeyExists,
  savedStorageRootKeyIsEncrypted,
  restoreStorageRootKeyStored,
  isValidStoredSecret,
  getSavedCashRootKeyStored,
  savedCashRootKeyIsEncrypted,
  restoreCashRootKeyStored
} from './keys'
import type {TrustedMint} from './trustedMints'
import {trustedMints, mergeTrustedMints} from './trustedMints'
import {
  readCashSecretIndices,
  mergeCashSecretIndices,
  readCashAddressSecretIndices,
  mergeCashAddressSecretIndices
} from './cashSecrets'
import {withStorageLock} from './storageLock'

// One bearer note held by this wallet - the decrypted, in-memory shape.
// `url` is the note's withdraw LNURL with the secret as its k1 param (so it
// IS the asset); the displayable bech32/lnurlw:// forms are re-encoded from
// it on demand.
export type Bearer = {
  id: string
  url: string
  callback: string // the mutating callback from the withdrawRequest JSON, '' until first verified
  amount: number // msat, last known (maxWithdrawable) - refreshed on demand
  verified: boolean // false while the issuing service hasn't confirmed the note yet
  // the issuing service's signing pubkey, cached once seen (withdrawRequest/
  // payRequest's optional mintPubkey) - lets a note's ?sig= be checked
  // offline against it without a network round trip
  mintPubkey?: string
  // a local-only lock, not a server-verified state: true once this wallet
  // has melted/handed over the note, or the holder marked it manually. It
  // just disables further mutating actions here so this copy can't be
  // reused by accident - it says nothing about whether the service has
  // actually burned it yet
  spent?: boolean
  // a free-text note the holder can attach for their own reference (e.g.
  // "rent", "gift for Alex") - purely local, never sent anywhere, no
  // protocol meaning at all
  label?: string
  // present if this note's secret lives on a paired LNURLvault device,
  // never in this browser's storage - the device's own note id (see
  // device.ts's DeviceNote.id). When set, `url` never carries a real k1
  // (see lnurlcash.ts's withoutK1) - it's a blank mirror, kept
  // only so this bearer displays like any other (amount/host/label/state)
  deviceId?: string
  // sha256(device-held k1), public metadata used to verify a receipt-backed
  // note signature without exporting the bearer secret
  deviceHash?: string
  createdAt: number
  updatedAt: number
}

export type EncryptedBearerRecord = {id: string} & EncryptedRecordParts

const BEARERS_STORAGE_KEY = 'lnurlcash_bearers'

export const newBearerId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

export const readEncryptedBearers = (): EncryptedBearerRecord[] => {
  const raw = localStorage.getItem(BEARERS_STORAGE_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const writeEncryptedBearers = (records: EncryptedBearerRecord[]): void => {
  localStorage.setItem(BEARERS_STORAGE_KEY, JSON.stringify(records))
}

// decrypts everything currently stored - a record that fails to decrypt
// (e.g. written by a different seed's key) is skipped, not destroyed: it
// stays in localStorage untouched and simply doesn't show up
export const loadBearers = async (aesKey: CryptoKey): Promise<Bearer[]> => {
  const bearers: Bearer[] = []
  for (const record of readEncryptedBearers()) {
    try {
      const bearer = await decryptRecord<Omit<Bearer, 'id'>>(aesKey, record)
      bearers.push({...bearer, id: record.id})
    } catch {
      // undecryptable with this key - leave it in place
    }
  }
  return bearers.sort((a, b) => b.createdAt - a.createdAt)
}

export const persistBearer = async (
  aesKey: CryptoKey,
  bearer: Bearer
): Promise<void> => {
  const {id, ...plain} = bearer
  const parts = await encryptRecord(aesKey, plain)
  await withStorageLock(BEARERS_STORAGE_KEY, () => {
    const records = readEncryptedBearers().filter(r => r.id !== id)
    records.push({id, ...parts})
    writeEncryptedBearers(records)
  })
}

export const deleteBearerRecord = async (id: string): Promise<void> => {
  await withStorageLock(BEARERS_STORAGE_KEY, () => {
    writeEncryptedBearers(readEncryptedBearers().filter(r => r.id !== id))
  })
}

// wipes every bearer record from this device outright - unlike forgetting
// just the linking key, this is not recoverable by restoring the same seed:
// the ciphertexts themselves are gone, so only a previously downloaded
// backup file can bring them back
export const clearAllBearers = (): void => {
  localStorage.removeItem(BEARERS_STORAGE_KEY)
}

// A single line of the wallet's activity log - one per important action
// (mint, split, combine, melt, transfer, receive, marking spent/unspent,
// clearing a spent note). `message` is already the full human-readable
// sentence (same convention as the toast notify() calls these are logged
// alongside) rather than structured fields the UI reassembles, so the log
// stays simple to read and to extend with new kinds later.
export type ActivityKind =
  | 'mint'
  | 'split'
  | 'combine'
  | 'melt'
  | 'transfer'
  | 'receive'
  | 'refresh'
  | 'recovered'
  | 'spent'
  | 'unspent'
  | 'deleted'

export type ActivityEvent = {
  id: string
  kind: ActivityKind
  message: string
  createdAt: number
  // the acted-on note's own label at the time (see Bearer.label) - purely
  // for display, so a log entry can be tied back to "which note" by the
  // holder's own nickname for it instead of just server + amount. Absent
  // when no single note was the obvious subject, or it had no label set
  label?: string
}

export type EncryptedActivityRecord = {id: string} & EncryptedRecordParts

const ACTIVITY_STORAGE_KEY = 'lnurlcash_activity'
// bounds how far back the log ever reaches - a wallet used for years
// shouldn't grow localStorage without limit over entries nobody's read
// that far back; the oldest simply roll off once this many are kept
const MAX_ACTIVITY_ENTRIES = 500

export const newActivityId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

export const readEncryptedActivity = (): EncryptedActivityRecord[] => {
  const raw = localStorage.getItem(ACTIVITY_STORAGE_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const writeEncryptedActivity = (records: EncryptedActivityRecord[]): void => {
  localStorage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify(records))
}

// same tolerance as loadBearers - an entry that fails to decrypt with this
// key (written by a different seed) is skipped, not destroyed
export const loadActivity = async (
  aesKey: CryptoKey
): Promise<ActivityEvent[]> => {
  const events: ActivityEvent[] = []
  for (const record of readEncryptedActivity()) {
    try {
      const event = await decryptRecord<Omit<ActivityEvent, 'id'>>(
        aesKey,
        record
      )
      events.push({...event, id: record.id})
    } catch {
      // undecryptable with this key - leave it in place
    }
  }
  return events.sort((a, b) => b.createdAt - a.createdAt)
}

// append-only (the log never edits or removes a single entry, only clears
// outright - see clearAllActivity) - records are stored oldest-first so
// trimming to the cap is just dropping off the front
export const persistActivityEvent = async (
  aesKey: CryptoKey,
  event: ActivityEvent
): Promise<void> => {
  const {id, ...plain} = event
  const parts = await encryptRecord(aesKey, plain)
  await withStorageLock(ACTIVITY_STORAGE_KEY, () => {
    const records = readEncryptedActivity()
    records.push({id, ...parts})
    writeEncryptedActivity(records.slice(-MAX_ACTIVITY_ENTRIES))
  })
}

export const clearAllActivity = (): void => {
  localStorage.removeItem(ACTIVITY_STORAGE_KEY)
}

// WalletContext's upgradeEncryption: rewrites every stored bearer and
// activity record under a new AES key, in place. Not persistBearer/
// persistActivityEvent in a loop: the latter is append-only (it would
// duplicate every existing entry rather than replace it - see its own
// comment above), and both would lose the original on-disk order - activity
// in particular relies on staying oldest-first for its own trim-from-the-
// front logic. Iterating readEncrypted*() directly instead preserves both
// ids and exact ordering. A record that won't decrypt under the outgoing
// key either (shouldn't happen - see upgradeEncryption's own seed-match
// check - but never say never) is left exactly as it was, same
// "don't destroy what you can't read" rule loadBearers/loadActivity apply.
export const reencryptAllRecords = async (
  oldAesKey: CryptoKey,
  newAesKey: CryptoKey
): Promise<void> => {
  await withStorageLock(BEARERS_STORAGE_KEY, async () => {
    const records = await Promise.all(
      readEncryptedBearers().map(async record => {
        try {
          const {id, ...parts} = record
          const plain = await decryptRecord<Omit<Bearer, 'id'>>(
            oldAesKey,
            parts
          )
          return {id, ...(await encryptRecord(newAesKey, plain))}
        } catch {
          return record
        }
      })
    )
    writeEncryptedBearers(records)
  })
  await withStorageLock(ACTIVITY_STORAGE_KEY, async () => {
    const records = await Promise.all(
      readEncryptedActivity().map(async record => {
        try {
          const {id, ...parts} = record
          const plain = await decryptRecord<Omit<ActivityEvent, 'id'>>(
            oldAesKey,
            parts
          )
          return {id, ...(await encryptRecord(newAesKey, plain))}
        } catch {
          return record
        }
      })
    )
    writeEncryptedActivity(records)
  })
}

// Backup file: everything exactly as it sits in localStorage - bearer
// ciphertexts always, the linking-key and LUD-25 cash-root-key records only
// when each is itself password-encrypted (a plaintext one never leaves the
// device in a backup; the seed phrase is the recovery path for it instead -
// both keys are always saved under the same password, see WalletContext's
// setup, so there's never a case where one qualifies and the other
// doesn't). Trusted mints are plain (not secret - a mintPubkey is public),
// included as-is. `cashIndices` (LUD-25, see cashSecrets.ts) are the
// per-SERVICE "next index" counters behind every seed-derived note secret
// this wallet has generated - also plain (an index alone is worthless
// without the cash root key), and, unlike a bearer's own secret, small
// enough that backing up every note this wallet will ever hold never grows
// this beyond one integer per mint ever used.
export type BackupFile = {
  type: 'lnurlwallet-backup'
  version: 1
  createdAt: number
  // exactly one of these two is ever set on a given file - whichever this
  // device currently has active (see keys.ts's dual-format storage). Both
  // are read the same way on restore (isValidStoredSecret doesn't care
  // which kind of 32 raw bytes it's guarding), so an old backup with only
  // linkingKey still restores fine on a wallet that's since upgraded, and
  // vice versa.
  linkingKey?: StoredSecret
  storageRootKey?: StoredSecret
  cashRootKey?: StoredSecret
  cashIndices?: Record<string, number>
  // LUD-25 Part 2's own counter (see cashSecrets.ts's
  // nextCashAddressSecret) - a separate namespace from cashIndices above,
  // absent entirely on a backup taken before this feature existed (merge
  // already no-ops gracefully on undefined, same as any other optional
  // field here)
  cashAddressIndices?: Record<string, number>
  bearers: EncryptedBearerRecord[]
  trustedMints?: TrustedMint[]
}

export const buildBackup = (): BackupFile => {
  const backup: BackupFile = {
    type: 'lnurlwallet-backup',
    version: 1,
    createdAt: Date.now(),
    bearers: readEncryptedBearers(),
    trustedMints: trustedMints(),
    cashIndices: readCashSecretIndices(),
    cashAddressIndices: readCashAddressSecretIndices()
  }
  if (savedStorageRootKeyIsEncrypted()) {
    backup.storageRootKey = getSavedStorageRootKeyStored()!
  } else if (savedKeyIsEncrypted()) {
    backup.linkingKey = getSavedLinkingKeyStored()!
  }
  if (savedCashRootKeyIsEncrypted()) {
    backup.cashRootKey = getSavedCashRootKeyStored()!
  }
  return backup
}

// shared by Backup.tsx's own download and Settings.tsx's "Forget this
// wallet" (which offers the same download right before its irreversible
// action) - triggers the actual file save, no toast of its own so each
// caller's own wording ("Backup downloaded.", etc.) stays theirs to pick.
// DOM APIs only touched inside the function body, not at module load, so
// this stays safe to import from storage.test.ts's plain-Node environment
export const downloadBackupFile = (): void => {
  const backup = buildBackup()
  const blob = new Blob([JSON.stringify(backup, null, 2)], {
    type: 'application/json'
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `lnurlwallet-backup-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

export type RestoreResult = {
  added: number
  skipped: number
  linkingKeyRestored: boolean
  // true when the backup carried a linking key but this device already had
  // one, so it was deliberately NOT installed (see below) - distinct from
  // "no key in this backup at all". The bearer records above still merged
  // in regardless, but they were encrypted under the backup's own seed, not
  // whatever wallet is active on this device - unless that's the exact same
  // seed, they won't decrypt here, and the caller (Backup.tsx) should say so
  // rather than let that read as a silent no-op.
  linkingKeySkipped: boolean
  trustedMintsAdded: number
}

// restore-time bounds - a crafted or corrupt file must not be able to fill
// localStorage with junk records that never decrypt (quota exhaustion turns
// every later write into a failure, which can strand a just-rotated note),
// nor hang the tab in JSON.parse. A real backup holds a handful of notes,
// each well under a kilobyte encrypted, so these are generous
export const MAX_BACKUP_FILE_BYTES = 10 * 1024 * 1024
const MAX_BACKUP_RECORDS = 10_000
const MAX_BACKUP_FIELD_LENGTH = 64 * 1024

// merges a backup into localStorage: bearer records are added by id (already
// present ids are left as-is), the backup's linking key is only installed
// when this device has none yet - never overwriting an existing wallet.
// That guard is deliberate (a stale/wrong backup must never clobber a
// wallet already holding funds), but it means restore order matters: a
// device that already has ANY wallet - even one just freshly created,
// unrelated to this backup - silently keeps its own key, and this backup's
// bearers merge into storage without ever becoming visible, since they
// don't decrypt under a different key. See linkingKeySkipped above.
export const applyBackup = (data: unknown): RestoreResult => {
  const backup = data as BackupFile
  if (
    backup?.type !== 'lnurlwallet-backup' ||
    backup.version !== 1 ||
    !Array.isArray(backup.bearers)
  ) {
    throw new Error('Not a valid LNURLwallet backup file.')
  }
  const existing = readEncryptedBearers()
  const existingIds = new Set(existing.map(r => r.id))
  if (backup.bearers.length > MAX_BACKUP_RECORDS) {
    throw new Error(
      `Backup holds ${backup.bearers.length} records - more than the ${MAX_BACKUP_RECORDS} a real wallet could produce.`
    )
  }
  let added = 0
  let skipped = 0
  for (const record of backup.bearers) {
    if (
      typeof record?.id !== 'string' ||
      typeof record?.iv !== 'string' ||
      typeof record?.ciphertext !== 'string' ||
      record.id.length > MAX_BACKUP_FIELD_LENGTH ||
      record.iv.length > MAX_BACKUP_FIELD_LENGTH ||
      record.ciphertext.length > MAX_BACKUP_FIELD_LENGTH
    ) {
      skipped++
      continue
    }
    if (existingIds.has(record.id)) {
      skipped++
      continue
    }
    existing.push({id: record.id, iv: record.iv, ciphertext: record.ciphertext})
    existingIds.add(record.id)
    added++
  }
  try {
    writeEncryptedBearers(existing)
  } catch {
    throw new Error(
      'Local storage is full - the backup could not be written. Free up space (or forget unused wallets) and try again.'
    )
  }

  let linkingKeyRestored = false
  let linkingKeySkipped = false
  // whichever of the two the file carries (see BackupFile's own comment) -
  // an invalid key record reads as "no key in this backup", never as skipped
  const incomingKey = isValidStoredSecret(backup.storageRootKey)
    ? {stored: backup.storageRootKey, restore: restoreStorageRootKeyStored}
    : isValidStoredSecret(backup.linkingKey)
      ? {stored: backup.linkingKey, restore: restoreLinkingKeyStored}
      : null
  if (incomingKey) {
    if (savedStorageRootKeyExists() || savedKeyExists()) {
      linkingKeySkipped = true
    } else {
      incomingKey.restore(incomingKey.stored)
      linkingKeyRestored = true
      // LUD-25: the cash root key always travels with whichever root key
      // above (same password, same lifecycle - see WalletContext's setup
      // and upgradeEncryption), so it installs under the exact same gate,
      // silently - nothing here needs its own restored/skipped flags, it's
      // just along for the ride
      if (backup.cashRootKey && isValidStoredSecret(backup.cashRootKey, 128)) {
        restoreCashRootKeyStored(backup.cashRootKey)
      }
    }
  }

  const trustedMintsAdded = Array.isArray(backup.trustedMints)
    ? mergeTrustedMints(backup.trustedMints)
    : 0

  // per-SERVICE indices (LUD-25) merge in regardless of the linking-key
  // outcome above - they're non-secret bookkeeping, safe to raise even for
  // a device keeping its own existing wallet (see mergeCashSecretIndices)
  mergeCashSecretIndices(backup.cashIndices)
  mergeCashAddressSecretIndices(backup.cashAddressIndices)

  return {
    added,
    skipped,
    linkingKeyRestored,
    linkingKeySkipped,
    trustedMintsAdded
  }
}
