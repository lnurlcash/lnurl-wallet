import {HDKey, HARDENED_OFFSET} from '@scure/bip32'
import {bytesToHex} from '@noble/hashes/utils.js'
import {lud05PathSuffix} from './keys'
import {deriveNoteSecretKey, type Cx1} from './lib/recoverableNotes'

// LUD-25 Seed-recoverable note secrets: deterministic secrets for the notes
// this wallet mints/rotates/splits/merges, derived from the seed instead of
// drawn at random, so a lost/reinstalled wallet can reconstruct them from
// nothing but the seed phrase plus a small, non-secret per-SERVICE index
// (see nextCashSecret below) - no per-note secret ever needs backing up on
// its own. https://github.com/lnurl/luds/blob/lnurlcash/25.md
//
//   cashHashingKey = derive(cashRoot, 0)                         // LUD-05's step 1, own purpose
//   domainMaterial = hmacSha256(cashHashingKey, full SERVICE domain)  // LUD-05's steps 2-3, unchanged
//   (d1, d2, d3, d4) = first 16 bytes of domainMaterial as 4 uint32   // exactly as LUD-05
//   secret_i       = derive(cashRoot, d1/d2/d3/d4/i')             // i-th secret for this SERVICE
//
// `cashRoot` here is already the wallet's own m/139' node (see keys.ts's
// deriveLud25CashRootNode) - the spec's `masterKey` with the fixed `m/139'`
// prefix already applied, since that's as much of the true BIP32 master as
// this wallet ever keeps around (see cashRoot below).

// the decrypted cash root node, held in memory only for as long as the
// wallet is unlocked - set by WalletContext (activate/lock/forgetWallet),
// read by generateNoteSecret below. A module-level plain variable, not a
// Solid signal: nothing here needs to trigger a re-render, and lnurlcash.ts
// (which reads it) is plain protocol code, not a component - same reason
// offlineMode.ts and trustedMints.ts keep their own state at module level
// rather than behind React/Solid context.
let cashRoot: HDKey | null = null

export const setCashRoot = (node: HDKey | null): void => {
  cashRoot = node
}

export const hasCashRoot = (): boolean => cashRoot !== null

// per-SERVICE "next index to use" counters - not secret (an index reveals
// nothing without the cash root key itself), so plain localStorage, same
// as trustedMints.ts. `Object.create(null)` sidesteps prototype-pollution
// entirely rather than filtering key names one at a time: a malformed or
// crafted backup (see mergeCashSecretIndices) can populate this object with
// arbitrary string keys without ever touching Object.prototype.
const STORAGE_KEY = 'lnurlcash_cash_indices'
type Indices = Record<string, number>

const readIndices = (): Indices => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
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

const writeIndices = (indices: Indices): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(indices))
}

export const readCashSecretIndices = (): Indices => readIndices()

export const clearCashSecretIndices = (): void => {
  localStorage.removeItem(STORAGE_KEY)
}

// the domain-bound subtree both cashSecretAtIndex and a future from-seed
// recovery scan hang their per-index children off - null whenever no cash
// root is loaded (locked, or a wallet that hasn't re-entered its seed since
// this feature shipped)
const domainNode = (domain: string): HDKey | null => {
  if (!cashRoot) return null
  const hashingNode = cashRoot.deriveChild(0)
  if (!hashingNode.privateKey) return null
  const suffix = lud05PathSuffix(hashingNode.privateKey, domain)
  let node = cashRoot
  for (const index of suffix) node = node.deriveChild(index)
  return node
}

// pure - no counter side effect, so this doubles as the primitive a future
// "recover with nothing but the seed" scan would probe index by index
// (LUD-25's gap-limit convention) without disturbing this device's own
// next-index bookkeeping below
export const cashSecretAtIndex = (
  domain: string,
  index: number
): string | null => {
  const node = domainNode(domain)?.deriveChild(index + HARDENED_OFFSET)
  return node?.privateKey ? bytesToHex(node.privateKey) : null
}

// LUD-25 Part 2: a second, sibling purpose under the same m/139' root -
// m/139'/1' - dedicated to watch-only address branches (a domain's cx1
// export), so it never shares key material with m/139'/0 (cashHashingKey
// above). Nothing about the existing m/139'/0/d1/d2/d3/d4/i' hardened-
// secret derivation changes - this is purely additive, and every existing
// note/backup derived under it keeps working byte-for-byte forever.
const addressDomainNode = (domain: string): HDKey | null => {
  if (!cashRoot) return null
  const addressRoot = cashRoot.deriveChild(1 + HARDENED_OFFSET) // m/139'/1'
  const hashingNode = addressRoot.deriveChild(0) // m/139'/1'/0
  if (!hashingNode.privateKey) return null
  const suffix = lud05PathSuffix(hashingNode.privateKey, domain)
  let node = addressRoot
  for (const index of suffix) node = node.deriveChild(index)
  return node // m/139'/1'/d1/d2/d3/d4
}

// the watch-only branch this domain's cx1 export names - null whenever no
// cash root is loaded, same as domainNode above. `pubkeyXOnly` drops the
// HDKey publicKey's leading 02/03 compressed-form byte: a plain x-
// coordinate is exactly BIP-340's x-only encoding regardless of which y
// the underlying point actually has (see deriveNoteSecretKey's own parity
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
// secp256k1 scalar (see deriveNoteSecretKey), never a hex preimage the way
// cashSecretAtIndex's legacy notes are. Pure - no counter side effect, so
// a recovery scan can probe index by index (LUD-25's gap-limit convention)
// without any bookkeeping of its own: unlike a wallet-initiated secret
// (nextCashSecret below), a note here arrives unsolicited - the mint picks
// the index, not this wallet - so there is nothing to "claim" ahead of
// time, only ever a range to check.
export const cashAddressSecretAtIndex = (
  domain: string,
  index: number
): Uint8Array | null => {
  const node = addressDomainNode(domain)
  if (!node?.privateKey || !node.chainCode) return null
  return deriveNoteSecretKey(node.privateKey, node.chainCode, index)
}

export const nextCashSecretIndex = (domain: string): number =>
  readIndices()[domain] ?? 0

// claims the next index for `domain`, persists the advance, and returns the
// secret at it - null whenever no cash root is loaded, in which case the
// index is never consumed (nothing was generated to consume it for)
export const nextCashSecret = (domain: string): string | null => {
  const i = nextCashSecretIndex(domain)
  const secret = cashSecretAtIndex(domain, i)
  if (secret === null) return null
  const indices = readIndices()
  indices[domain] = i + 1
  writeIndices(indices)
  return secret
}

// Mint and cross-mint transfer quotes become payable promises to create a
// specific output. Their secret must survive a reload before an invoice is
// shown, so those paths may not use generateNoteSecret's in-memory random
// fallback. The derived index is persisted by nextCashSecret before this
// returns and can be scanned again from the wallet seed during recovery.
export const requireRecoverableCashSecret = (domain: string): string => {
  const secret = nextCashSecret(domain)
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
export const mergeCashSecretIndices = (incoming: unknown): void => {
  if (typeof incoming !== 'object' || incoming === null) return
  const current = readIndices()
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
  if (changed) writeIndices(current)
}
