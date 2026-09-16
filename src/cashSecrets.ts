import {HDKey} from '@scure/bip32'
import {deriveDomainBranchNode} from './lib/branchDerivation'
import {deriveNoteSecretKey, encodeCk1, type Cx1} from './lib/recoverableNotes'
import {signNoteOwnership} from './lib/signature'

// LUD-25 Part 2 seed-recoverable note secrets: deterministic secrets for the
// cp1/ck1 notes this wallet mints/rotates/splits/merges, derived from the
// seed instead of drawn at random, so a lost/reinstalled wallet can
// reconstruct them from nothing but the seed phrase plus a small, non-secret
// per-SERVICE index. https://github.com/lnurl/luds/blob/lnurlcash/25.md
//
//   cashHashingKey = derive(cashRoot, 0)                         // LUD-05's step 1, own purpose
//   domainMaterial = hmacSha256(cashHashingKey, full SERVICE domain)  // LUD-05's steps 2-3, unchanged
//   (d1, d2, d3, d4) = first 16 bytes of domainMaterial as 4 uint32   // exactly as LUD-05
//   p, chaincode   = derive(cashRoot, d1/d2/d3/d4)                // this SERVICE's branch root
//
// This is the literal path 25.md's own "Seed & derivation" section defines -
// no extra purpose hop beyond `cashRoot` (see src/lib/branchDerivation.ts).
// `cashRoot` here is already the wallet's own m/139' node (see keys.ts's
// deriveLud25CashRootNode) - the spec's `masterKey` with the fixed `m/139'`
// prefix already applied, since that's as much of the true BIP32 master as
// this wallet ever keeps around (see cashRoot below).
//
// 25.md's Part 1 (plain hash-preimage bearer notes) defines no derivation of
// its own at all - a WALLET may generate that secret however it likes. This
// wallet generates it with plain randomness (see lnurlcash.ts's
// generateNoteSecret/generateMintSecret), not a seed-derived branch, so
// there is nothing here for Part 1 to compete with Part 2 over.

// the decrypted cash root node, held in memory only for as long as the
// wallet is unlocked - set by WalletContext (activate/lock/forgetWallet),
// read by generateMintPubkeySecret below. A module-level plain variable, not
// a Solid signal: nothing here needs to trigger a re-render, and
// lnurlcash.ts (which reads it) is plain protocol code, not a component -
// same reason offlineMode.ts and trustedMints.ts keep their own state at
// module level rather than behind React/Solid context.
let cashRoot: HDKey | null = null

export const setCashRoot = (node: HDKey | null): void => {
  cashRoot = node
}

export const hasCashRoot = (): boolean => cashRoot !== null

// per-SERVICE "next index to use" counter for a wallet-initiated Part 2
// output (see nextCashAddressSecret below) - not secret (an index reveals
// nothing without the cash root key itself), so plain localStorage, same as
// trustedMints.ts. `Object.create(null)` sidesteps prototype-pollution
// entirely rather than filtering key names one at a time: a malformed or
// crafted backup (see mergeCashAddressSecretIndices) can populate this
// object with arbitrary string keys without ever touching Object.prototype.
const ADDRESS_STORAGE_KEY = 'lnurlcash_cash_address_indices'
type Indices = Record<string, number>

const readIndices = (key: string): Indices => {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return Object.create(null)
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null)
      return Object.create(null)
    const indices: Indices = Object.create(null)
    for (const [domain, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
        indices[domain] = value
      }
    }
    return indices
  } catch {
    return Object.create(null)
  }
}

const writeIndices = (key: string, indices: Indices): void => {
  localStorage.setItem(key, JSON.stringify(indices))
}

export const readCashAddressSecretIndices = (): Indices =>
  readIndices(ADDRESS_STORAGE_KEY)

export const clearCashAddressSecretIndices = (): void => {
  localStorage.removeItem(ADDRESS_STORAGE_KEY)
}

// the domain-bound subtree cashAddressBranch/cashAddressSecretAtIndex below
// hang their per-index children off - null whenever no cash root is loaded
// (locked, or a wallet that hasn't re-entered its seed since this feature
// shipped)
const addressDomainNode = (domain: string): HDKey | null =>
  cashRoot ? deriveDomainBranchNode(cashRoot, domain) : null

// the watch-only branch this domain's cx1 export names - null whenever no
// cash root is loaded, same as addressDomainNode above. `pubkeyXOnly` drops
// the HDKey publicKey's leading 02/03 compressed-form byte: a plain x-
// coordinate is exactly BIP-340's x-only encoding regardless of which y the
// underlying point actually has (see deriveNoteSecretKey's own parity
// handling in src/lib/recoverableNotes.ts, which takes the raw, unmodified
// private key and corrects for this internally - nothing here needs to).
export const cashAddressBranch = (domain: string): Cx1 | null => {
  const node = addressDomainNode(domain)
  const publicKey = node?.publicKey
  const chainCode = node?.chainCode
  if (!publicKey || !chainCode) return null
  return {pubkeyXOnly: publicKey.slice(1), chainCode}
}

// this note's own bearer secret on the address branch - an actual
// secp256k1 scalar (see deriveNoteSecretKey). Pure - no counter side effect,
// so a recovery scan can probe index by index (LUD-25's gap-limit
// convention, see recovery.ts) without any bookkeeping of its own: unlike a
// wallet-initiated secret (nextCashAddressSecret below), a note here arrives
// unsolicited - the mint picks the index, not this wallet - so there is
// nothing to "claim" ahead of time, only ever a range to check.
export const cashAddressSecretAtIndex = (
  domain: string,
  index: number
): Uint8Array | null => {
  const node = addressDomainNode(domain)
  if (!node?.privateKey || !node.chainCode) return null
  return deriveNoteSecretKey(node.privateKey, node.chainCode, index)
}

// LUD-25 Part 2's own "next index" convention - a wallet-INITIATED
// mint/transfer's own pubkey-bound output, returned as its actual bearer
// secret (a ck1 ownership signature - see signNoteOwnership) rather than a
// raw preimage. This is otherwise unrelated to (and never shares an index
// with) a registered address's mint-auto-derived notes on the same branch -
// the mint's own claim_next_index already skips past any index this wallet
// has already used, on either side, so there is nothing to coordinate here.
export const nextCashAddressSecretIndex = (domain: string): number =>
  readIndices(ADDRESS_STORAGE_KEY)[domain] ?? 0

export const nextCashAddressSecret = (domain: string): string | null => {
  const i = nextCashAddressSecretIndex(domain)
  const secretKey = cashAddressSecretAtIndex(domain, i)
  if (secretKey === null) return null
  const indices = readIndices(ADDRESS_STORAGE_KEY)
  indices[domain] = i + 1
  writeIndices(ADDRESS_STORAGE_KEY, indices)
  const {pubkeyXOnly, signature} = signNoteOwnership(secretKey)
  return encodeCk1(pubkeyXOnly, signature)
}

// Mint and cross-mint transfer quotes become payable promises to create a
// specific output. Their secret must survive a reload before an invoice is
// shown, so this may not use generateNoteSecret's in-memory random
// fallback. The derived index is persisted by nextCashAddressSecret before
// this returns and can be scanned again from the wallet seed during
// recovery (recovery.ts).
export const requireRecoverableCashAddressSecret = (domain: string): string => {
  const secret = nextCashAddressSecret(domain)
  if (secret === null) {
    throw new Error(
      'This wallet cannot safely create a mint invoice until its seed-derived cash key is unlocked. Restore or re-enter the wallet seed first.'
    )
  }
  return secret
}

// merges a backup's per-SERVICE counters in - never decreases one (that
// would risk re-deriving and reusing an index this device, or the backup's
// own device, already generated a secret at), and simply ignores anything
// malformed rather than throwing: a corrupt or crafted backup must not be
// able to jam this wallet's future note generation, only at worst leave a
// domain's counter lower than it could be (harmless - the next generated
// secret just costs one extra derivation, never a collision)
const mergeIndicesInto = (key: string, incoming: unknown): void => {
  if (typeof incoming !== 'object' || incoming === null) return
  const current = readIndices(key)
  let changed = false
  for (const [domain, value] of Object.entries(incoming)) {
    if (
      typeof domain !== 'string' ||
      domain.length === 0 ||
      domain.length > 500 ||
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > 1_000_000
    ) {
      continue
    }
    if ((current[domain] ?? 0) < value) {
      current[domain] = value
      changed = true
    }
  }
  if (changed) writeIndices(key, current)
}

export const mergeCashAddressSecretIndices = (incoming: unknown): void =>
  mergeIndicesInto(ADDRESS_STORAGE_KEY, incoming)

// Part 1's own reload-survival - deliberately NOT seed-derived (25.md's
// Part 1 defines no derivation at all, see this file's header comment).
// generateMintSecret (lnurlcash.ts) generates a plain random secret for a
// mint/transfer quote and records it here before the invoice leaves the
// wallet, so a reload between "invoice shown" and "payment settled" doesn't
// strand the note SERVICE will credit under sha256(secret) - the UI can
// still recover it from this flat, per-domain, append-only list even though
// component state (and any deterministic re-derivation) is gone. This is a
// same-device, same-localStorage guarantee only: unlike Part 2's cx1
// branch, nothing here survives a lost device or a fresh reinstall - that
// trade is exactly what dropping Part 1's non-spec seed-derivation buys
// back (see 25.md's own Part 1, which never promised recoverability
// either).
const PENDING_MINT_SECRETS_KEY = 'lnurlcash_pending_mint_secrets'
type PendingMintSecrets = Record<string, string[]>

const readPendingMintSecrets = (): PendingMintSecrets => {
  try {
    const raw = localStorage.getItem(PENDING_MINT_SECRETS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const result: PendingMintSecrets = {}
    for (const [domain, secrets] of Object.entries(parsed)) {
      if (
        typeof domain === 'string' &&
        Array.isArray(secrets) &&
        secrets.every(s => typeof s === 'string')
      ) {
        result[domain] = secrets
      }
    }
    return result
  } catch {
    return {}
  }
}

const writePendingMintSecrets = (secrets: PendingMintSecrets): void => {
  localStorage.setItem(PENDING_MINT_SECRETS_KEY, JSON.stringify(secrets))
}

export const recordPendingMintSecret = (
  domain: string,
  secret: string
): void => {
  const all = readPendingMintSecrets()
  const list = all[domain] ?? []
  if (list.includes(secret)) return
  writePendingMintSecrets({...all, [domain]: [...list, secret]})
}

// called once a pending secret is no longer in flight - claimed into the
// wallet as a note, or the quote it belonged to was abandoned/replaced -
// so this list only ever grows with genuinely still-open quotes
export const clearPendingMintSecret = (
  domain: string,
  secret: string
): void => {
  const all = readPendingMintSecrets()
  const list = all[domain]
  if (!list) return
  const next = list.filter(s => s !== secret)
  const rest = {...all}
  if (next.length > 0) rest[domain] = next
  else delete rest[domain]
  writePendingMintSecrets(rest)
}

export const pendingMintSecretsFor = (domain: string): string[] =>
  readPendingMintSecrets()[domain] ?? []

// WalletContext's forgetWallet - wipes this device-local bookkeeping along
// with everything else the wallet leaves behind, same as
// clearCashAddressSecretIndices above
export const clearPendingMintSecrets = (): void => {
  localStorage.removeItem(PENDING_MINT_SECRETS_KEY)
}
