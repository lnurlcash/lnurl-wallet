import {
  mnemonicToSeedSync,
  generateMnemonic,
  validateMnemonic
} from '@scure/bip39'
import {wordlist} from '@scure/bip39/wordlists/english.js'
import {HDKey, HARDENED_OFFSET} from '@scure/bip32'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {lud05PathSuffix} from './lib/branchDerivation'

export {lud05PathSuffix}

// The wallet's identity is derived against this fixed domain rather than
// window.location.hostname, so the same seed phrase always yields the same
// linking key (and thus decrypts the same bearer tokens) no matter where
// this static build happens to be hosted - github.io, a mirror, file://.
export const WALLET_DOMAIN = 'lnurlwallet'

export const generateSeedPhrase = (): string => generateMnemonic(wordlist, 128)

export const isValidSeedPhrase = (phrase: string): boolean =>
  validateMnemonic(phrase.trim().toLowerCase(), wordlist)

// LUD-05: BIP32-based linking-key derivation, same scheme as lnurl_server -
// a seed restored there or here produces the same identity for a given domain
export const deriveLud05LinkingKey = (
  seedPhrase: string,
  domain: string
): Uint8Array => {
  const seed = mnemonicToSeedSync(seedPhrase.trim().toLowerCase())
  const master = HDKey.fromMasterSeed(seed)

  const hashingKeyNode = master.derive("m/138'/0")
  if (!hashingKeyNode.privateKey)
    throw new Error('Could not derive hashing key')
  const suffix = lud05PathSuffix(hashingKeyNode.privateKey, domain)

  // path suffix longs are raw BIP32 child indices: whether each level ends up
  // hardened depends solely on its own magnitude (>= 2^31), never forced
  let node = master.deriveChild(138 + HARDENED_OFFSET)
  for (const index of suffix) {
    node = node.deriveChild(index)
  }
  if (!node.privateKey) throw new Error('Could not derive linking key')
  return node.privateKey
}

// Legacy: this wallet's original bearer-encryption root, a full LUD-05
// linking key (secp256k1 keypair). Superseded by deriveStorageRootKey
// below - nothing here ever needed the linking key's actual LUD-05
// identity (no signature is ever presented to a service under it), only
// its bytes, hashed into an AES key, so the keypair derivation was pure
// overhead for that. Kept only so a wallet that hasn't run the one-time
// "upgrade encryption" migration (WalletContext's upgradeEncryption) can
// still unlock and read what it already encrypted under it.
export const deriveWalletLinkingKey = (seedPhrase: string): Uint8Array =>
  deriveLud05LinkingKey(seedPhrase, WALLET_DOMAIN)

// LUD-25 Seed-recoverable note secrets: the m/139' node - this wallet's own
// root for deterministic bearer-note secrets (mint-time comment protection,
// and every rotate/split/merge output), under its own purpose so it never
// shares key material with the m/138' LUD-05 branch above. Unlike
// linkingPrivKey (a single domain-bound leaf, never derived further),
// callers need to keep deriving fresh children from this node for as long
// as the wallet exists - one per SERVICE, then one per secret within it -
// so the node itself (private key + chain code) is what gets persisted, not
// just a bare scalar (see cashRootToHex/cashRootFromHex).
export const deriveLud25CashRootNode = (seedPhrase: string): HDKey => {
  const seed = mnemonicToSeedSync(seedPhrase.trim().toLowerCase())
  const master = HDKey.fromMasterSeed(seed)
  return master.deriveChild(139 + HARDENED_OFFSET)
}

// The current bearer-encryption root: straight from the BIP39 seed, no
// intermediate identity keypair (see deriveWalletLinkingKey above for why
// that existed and why it's no longer needed). Domain-separated by its own
// context string so this can never collide with the master seed being
// hashed for some other purpose elsewhere.
const STORAGE_ROOT_CONTEXT = 'lnurlwallet-storage-root-v1'

export const deriveStorageRootKey = (seedPhrase: string): Uint8Array => {
  const seed = mnemonicToSeedSync(seedPhrase.trim().toLowerCase())
  return sha256(new Uint8Array([...seed, ...utf8ToBytes(STORAGE_ROOT_CONTEXT)]))
}

// this wallet's own compact serialization of an HDKey node - privateKey (32
// bytes) || chainCode (32 bytes), not a real BIP32 extended key (no
// version/depth/parent-fingerprint bytes, no base58check framing): nothing
// here is ever meant to leave this wallet as a portable xprv, it only has to
// round-trip through this module's own storage. HDKey's constructor asks for
// nothing else to keep deriving children (see cashRootFromHex).
export const cashRootToHex = (node: HDKey): string => {
  if (!node.privateKey || !node.chainCode) {
    throw new Error('Could not derive cash root key')
  }
  return bytesToHex(node.privateKey) + bytesToHex(node.chainCode)
}

export const cashRootFromHex = (hex: string): HDKey => {
  const bytes = hexToBytes(hex)
  if (bytes.length !== 64) throw new Error('Malformed cash root key')
  return new HDKey({
    privateKey: bytes.slice(0, 32),
    chainCode: bytes.slice(32)
  })
}

// Encrypted-at-rest localStorage secret, same shape as lnurl_server's: the
// stored value is either plaintext or, if the holder opted in with a
// password, AES-GCM ciphertext keyed by a PBKDF2 stretch of that password -
// GCM's auth tag doubles as the "wrong password" check on decrypt.
const PBKDF2_ITERATIONS = 210_000

export type StoredSecret =
  | {enc: false; value: string}
  | {enc: true; salt: string; iv: string; ciphertext: string}

// strict shape check on a StoredSecret - a plaintext form must be exactly
// `hexLength` hex characters (32-byte linkingPrivKey by default; the LUD-25
// cash root node's privateKey||chainCode pair is twice that, see
// cashRootToHex), an encrypted form must carry hex salt/iv/ciphertext of the
// sizes encryptSecretParts produces (unconstrained by the plaintext's own
// length, so `hexLength` only matters for the plaintext branch). Guards the
// backup-restore path (storage.ts's applyBackup), where a crafted file would
// otherwise get an arbitrary secret installed verbatim.
export const isValidStoredSecret = (
  stored: unknown,
  hexLength = 64
): stored is StoredSecret => {
  if (typeof stored !== 'object' || stored === null) return false
  const s = stored as Record<string, unknown>
  if (s.enc === false) {
    return (
      typeof s.value === 'string' &&
      new RegExp(`^[0-9a-f]{${hexLength}}$`, 'i').test(s.value)
    )
  }
  if (s.enc === true) {
    return (
      typeof s.salt === 'string' &&
      /^[0-9a-f]{32}$/i.test(s.salt) &&
      typeof s.iv === 'string' &&
      /^[0-9a-f]{24}$/i.test(s.iv) &&
      typeof s.ciphertext === 'string' &&
      s.ciphertext.length > 0 &&
      s.ciphertext.length % 2 === 0 &&
      /^[0-9a-f]+$/i.test(s.ciphertext)
    )
  }
  return false
}

const readSecret = (
  storageKey: string,
  hexLength = 64
): StoredSecret | null => {
  const raw = localStorage.getItem(storageKey)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isValidStoredSecret(parsed, hexLength) ? parsed : null
  } catch {
    return null
  }
}

const deriveAesKeyFromPassword = (
  password: string,
  salt: Uint8Array
): Promise<CryptoKey> =>
  crypto.subtle
    .importKey('raw', utf8ToBytes(password), 'PBKDF2', false, ['deriveKey'])
    .then(baseKey =>
      crypto.subtle.deriveKey(
        // the copy pins the TS type to Uint8Array<ArrayBuffer> - hexToBytes
        // returns Uint8Array<ArrayBufferLike>, which BufferSource rejects
        {
          name: 'PBKDF2',
          salt: new Uint8Array(salt),
          iterations: PBKDF2_ITERATIONS,
          hash: 'SHA-256'
        },
        baseKey,
        {name: 'AES-GCM', length: 256},
        false,
        ['encrypt', 'decrypt']
      )
    )

export type EncryptedSecretParts = {
  salt: string
  iv: string
  ciphertext: string
}

export const encryptSecretParts = async (
  value: string,
  password: string
): Promise<EncryptedSecretParts> => {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const aesKey = await deriveAesKeyFromPassword(password, salt)
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {name: 'AES-GCM', iv},
      aesKey,
      utf8ToBytes(value)
    )
  )
  return {
    salt: bytesToHex(salt),
    iv: bytesToHex(iv),
    ciphertext: bytesToHex(ciphertext)
  }
}

// rejects (WebCrypto's own auth-tag check) if the password is wrong
export const decryptSecretParts = async (
  parts: EncryptedSecretParts,
  password: string
): Promise<string> => {
  const salt = hexToBytes(parts.salt)
  const iv = hexToBytes(parts.iv)
  const aesKey = await deriveAesKeyFromPassword(password, salt)
  const plaintext = await crypto.subtle.decrypt(
    {name: 'AES-GCM', iv},
    aesKey,
    hexToBytes(parts.ciphertext)
  )
  return new TextDecoder().decode(plaintext)
}

// The linking key is the only secret this wallet persists - the seed phrase
// it was derived from is shown once at setup and never stored. Everything
// else at rest (the bearer tokens) is encrypted with a key derived from it,
// so protecting this one record with a password protects the whole wallet.
const LINKING_KEY_STORAGE_KEY = 'lnurlwallet_linking_key'

export const savedKeyExists = (): boolean =>
  readSecret(LINKING_KEY_STORAGE_KEY) !== null

export const savedKeyIsEncrypted = (): boolean =>
  readSecret(LINKING_KEY_STORAGE_KEY)?.enc === true

export const getSavedLinkingKeyStored = (): StoredSecret | null =>
  readSecret(LINKING_KEY_STORAGE_KEY)

export const getPlainLinkingKey = (): Uint8Array | null => {
  const stored = readSecret(LINKING_KEY_STORAGE_KEY)
  if (stored === null || stored.enc === true) return null
  return hexToBytes(stored.value)
}

export const saveLinkingKey = async (
  linkingPrivKey: Uint8Array,
  password?: string
): Promise<void> => {
  const hex = bytesToHex(linkingPrivKey)
  if (!password) {
    localStorage.setItem(
      LINKING_KEY_STORAGE_KEY,
      JSON.stringify({enc: false, value: hex})
    )
    return
  }
  const parts = await encryptSecretParts(hex, password)
  localStorage.setItem(
    LINKING_KEY_STORAGE_KEY,
    JSON.stringify({enc: true, ...parts})
  )
}

export const restoreLinkingKeyStored = (stored: StoredSecret): void => {
  localStorage.setItem(LINKING_KEY_STORAGE_KEY, JSON.stringify(stored))
}

export const decryptSavedLinkingKey = async (
  password: string
): Promise<Uint8Array> => {
  const stored = readSecret(LINKING_KEY_STORAGE_KEY)
  if (!stored || !stored.enc) throw new Error('No encrypted linking key saved.')
  return hexToBytes(await decryptSecretParts(stored, password))
}

export const clearSavedLinkingKey = (): void => {
  localStorage.removeItem(LINKING_KEY_STORAGE_KEY)
}

// The current bearer-encryption root (see deriveStorageRootKey), persisted
// the same way and under the same StoredSecret shape as the legacy linking
// key above - same 32 raw bytes either way, deriveBearerAesKey doesn't
// care which kind it's handed. A wallet holds at most one of these two
// slots populated at a time: a fresh setup only ever writes this one, an
// existing wallet writes it once (and clears the legacy slot) the moment
// it runs the "upgrade encryption" migration (WalletContext's
// upgradeEncryption) - see WalletContext's own dual-format handling for
// which slot a given unlock actually reads.
const STORAGE_ROOT_KEY_STORAGE_KEY = 'lnurlwallet_storage_root_key'

export const savedStorageRootKeyExists = (): boolean =>
  readSecret(STORAGE_ROOT_KEY_STORAGE_KEY) !== null

export const savedStorageRootKeyIsEncrypted = (): boolean =>
  readSecret(STORAGE_ROOT_KEY_STORAGE_KEY)?.enc === true

export const getSavedStorageRootKeyStored = (): StoredSecret | null =>
  readSecret(STORAGE_ROOT_KEY_STORAGE_KEY)

export const getPlainStorageRootKey = (): Uint8Array | null => {
  const stored = readSecret(STORAGE_ROOT_KEY_STORAGE_KEY)
  if (stored === null || stored.enc === true) return null
  return hexToBytes(stored.value)
}

export const saveStorageRootKey = async (
  storageRootKey: Uint8Array,
  password?: string
): Promise<void> => {
  const hex = bytesToHex(storageRootKey)
  if (!password) {
    localStorage.setItem(
      STORAGE_ROOT_KEY_STORAGE_KEY,
      JSON.stringify({enc: false, value: hex})
    )
    return
  }
  const parts = await encryptSecretParts(hex, password)
  localStorage.setItem(
    STORAGE_ROOT_KEY_STORAGE_KEY,
    JSON.stringify({enc: true, ...parts})
  )
}

export const restoreStorageRootKeyStored = (stored: StoredSecret): void => {
  localStorage.setItem(STORAGE_ROOT_KEY_STORAGE_KEY, JSON.stringify(stored))
}

export const decryptSavedStorageRootKey = async (
  password: string
): Promise<Uint8Array> => {
  const stored = readSecret(STORAGE_ROOT_KEY_STORAGE_KEY)
  if (!stored || !stored.enc) {
    throw new Error('No encrypted storage key saved.')
  }
  return hexToBytes(await decryptSecretParts(stored, password))
}

export const clearSavedStorageRootKey = (): void => {
  localStorage.removeItem(STORAGE_ROOT_KEY_STORAGE_KEY)
}

// LUD-25 cash root node (see deriveLud25CashRootNode), stored the same way
// and under the same password as the linking key above - it's always
// derived and saved alongside it (WalletContext's setup), so there's no
// separate password to ask for. Absent on a wallet set up before this
// feature existed until its seed phrase is entered again (Setup.tsx's
// "Restore from seed" already calls the same setup() path); every note
// secret this wallet generates falls back to plain randomness until then
// (see lnurlcash.ts's generateNoteSecret).
const CASH_ROOT_KEY_STORAGE_KEY = 'lnurlwallet_cash_root_key'
const CASH_ROOT_KEY_HEX_LENGTH = 128 // privateKey (32B) || chainCode (32B)

export const savedCashRootKeyExists = (): boolean =>
  readSecret(CASH_ROOT_KEY_STORAGE_KEY, CASH_ROOT_KEY_HEX_LENGTH) !== null

export const savedCashRootKeyIsEncrypted = (): boolean =>
  readSecret(CASH_ROOT_KEY_STORAGE_KEY, CASH_ROOT_KEY_HEX_LENGTH)?.enc === true

export const getSavedCashRootKeyStored = (): StoredSecret | null =>
  readSecret(CASH_ROOT_KEY_STORAGE_KEY, CASH_ROOT_KEY_HEX_LENGTH)

export const getPlainCashRootKeyHex = (): string | null => {
  const stored = readSecret(CASH_ROOT_KEY_STORAGE_KEY, CASH_ROOT_KEY_HEX_LENGTH)
  if (stored === null || stored.enc === true) return null
  return stored.value
}

export const saveCashRootKey = async (
  cashRootHex: string,
  password?: string
): Promise<void> => {
  if (!password) {
    localStorage.setItem(
      CASH_ROOT_KEY_STORAGE_KEY,
      JSON.stringify({enc: false, value: cashRootHex})
    )
    return
  }
  const parts = await encryptSecretParts(cashRootHex, password)
  localStorage.setItem(
    CASH_ROOT_KEY_STORAGE_KEY,
    JSON.stringify({enc: true, ...parts})
  )
}

export const restoreCashRootKeyStored = (stored: StoredSecret): void => {
  localStorage.setItem(CASH_ROOT_KEY_STORAGE_KEY, JSON.stringify(stored))
}

export const decryptSavedCashRootKeyHex = async (
  password: string
): Promise<string> => {
  const stored = readSecret(CASH_ROOT_KEY_STORAGE_KEY, CASH_ROOT_KEY_HEX_LENGTH)
  if (!stored || !stored.enc) {
    throw new Error('No encrypted cash root key saved.')
  }
  return decryptSecretParts(stored, password)
}

export const clearSavedCashRootKey = (): void => {
  localStorage.removeItem(CASH_ROOT_KEY_STORAGE_KEY)
}

// The bearer-encryption key is derived (not random): sha256 over the root
// key (legacy linking key, or the current storage root key - see
// deriveWalletLinkingKey/deriveStorageRootKey above, both just 32 raw
// bytes as far as this is concerned) plus a fixed context string.
// Deterministic derivation is what makes backup/restore work with nothing
// but the seed phrase - restore the seed on a fresh device and every
// previously exported ciphertext decrypts again.
const BEARER_KEY_CONTEXT = 'lnurlcash-bearer-encryption-v1'

export const deriveBearerAesKey = (rootKey: Uint8Array): Promise<CryptoKey> => {
  const material = sha256(
    new Uint8Array([...rootKey, ...utf8ToBytes(BEARER_KEY_CONTEXT)])
  )
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, [
    'encrypt',
    'decrypt'
  ])
}

// Compares two non-extractable AES-GCM keys for equality without ever
// exporting either: the same key, same fixed IV and same fixed plaintext
// always produces byte-identical ciphertext, so a match here is as
// conclusive as comparing the raw key material directly would be. Used
// only as a same-session probe (WalletContext's upgradeEncryption, to
// prove a re-entered seed phrase actually belongs to the active wallet
// before touching anything) - the fixed IV is fine precisely because no
// output here is ever kept or reused as real ciphertext.
const KEY_PROBE_IV = new Uint8Array(12)
const KEY_PROBE_PLAINTEXT = utf8ToBytes('lnurlwallet-key-probe')

export const aesKeysEqual = async (
  a: CryptoKey,
  b: CryptoKey
): Promise<boolean> => {
  const [ca, cb] = await Promise.all([
    crypto.subtle.encrypt(
      {name: 'AES-GCM', iv: KEY_PROBE_IV},
      a,
      KEY_PROBE_PLAINTEXT
    ),
    crypto.subtle.encrypt(
      {name: 'AES-GCM', iv: KEY_PROBE_IV},
      b,
      KEY_PROBE_PLAINTEXT
    )
  ])
  return bytesToHex(new Uint8Array(ca)) === bytesToHex(new Uint8Array(cb))
}

export type EncryptedRecordParts = {iv: string; ciphertext: string}

export const encryptRecord = async (
  aesKey: CryptoKey,
  value: object
): Promise<EncryptedRecordParts> => {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {name: 'AES-GCM', iv},
      aesKey,
      utf8ToBytes(JSON.stringify(value))
    )
  )
  return {iv: bytesToHex(iv), ciphertext: bytesToHex(ciphertext)}
}

export const decryptRecord = async <T>(
  aesKey: CryptoKey,
  parts: EncryptedRecordParts
): Promise<T> => {
  const plaintext = await crypto.subtle.decrypt(
    {name: 'AES-GCM', iv: hexToBytes(parts.iv)},
    aesKey,
    hexToBytes(parts.ciphertext)
  )
  return JSON.parse(new TextDecoder().decode(plaintext)) as T
}
