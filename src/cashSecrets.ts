import {HDKey, HARDENED_OFFSET} from '@scure/bip32'
import {
  deriveDomainBranchNode,
  deriveServiceRoot,
  serviceDomainOf,
  deriveNoteKey,
  deriveShareNode,
  shareCx1
} from './lib/branchDerivation'
import {
  encodeCk1,
  legacyDeriveNoteSecretKey,
  LEGACY_NOTE_PURPOSE_LIGHTNING_ADDRESS,
  type Cx1
} from './lib/recoverableNotes'
import {bytesToHex} from '@noble/hashes/utils.js'
import {signNoteOwnership} from './lib/signature'

// LUD-26 seed-recoverable note secrets: deterministic secrets for the
// cp1/ck1 notes this wallet mints/rotates/splits/merges, derived from the
// seed instead of drawn at random, so a lost/reinstalled wallet can
// reconstruct them from nothing but the seed phrase plus a small, non-secret
// per-SERVICE index. https://github.com/lnurl/luds/blob/lnurlcash/26.md
//
//   S = m/139'/d1/d2/d3/d4        this SERVICE's root, d1..d4 as LUD-05 over
//                                 its domain (hostname, no port)
//   S/a'/0/i                      wallet notes: mint/rotate/merge results
//   S/a'/1/i                      change notes: a split's change only
//   S/a'/2/n'                     share n, exported as a cx1 for one
//                                 Lightning Address; its notes S/a'/2/n'/i
//                                 are derived by the SERVICE from the cx1
//
// This wallet uses account 0 only. The wallet and change chains are
// independent counters, so a stray retry never merges value into a note
// someone else holds the spend for; a share's index is picked by the
// SERVICE, never counted here.
//
// Superseded schemes (before LUD-26: a per-note tagged-hash tweak off the
// domain branch, with purposes 0/1/2) are kept read-only, for sweeping what
// an older version of this wallet left there - see the legacy* functions
// below and recovery.ts. `cashRoot` is the wallet's own m/139' node (see
// keys.ts's deriveLud25CashRootNode).
//
// LUD-26 defines no derivation for bearer notes (a plain hash preimage) - a
// WALLET may generate that secret however it likes. This wallet generates it
// with plain randomness (see lnurlcash.ts's
// generateNoteSecret/generateMintSecret), not a seed-derived branch, so
// bearer notes never compete with key-path notes for an index.

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
  nodeCache.clear()
}

// the per-mint nodes below, derived once per cash root: a recovery scan
// asks for every index of a mint in turn, and each walk from the cash root
// costs an HMAC and several hardened derivations
const nodeCache = new Map<string, HDKey>()

const cached = (key: string, derive: () => HDKey): HDKey => {
  let node = nodeCache.get(key)
  if (!node) {
    node = derive()
    nodeCache.set(key, node)
  }
  return node
}

export const hasCashRoot = (): boolean => cashRoot !== null

// per-SERVICE "next index to use" counters for the wallet and change
// chains - not secret (an index reveals nothing without the cash root key
// itself), so plain localStorage, same as trustedMints.ts.
// `Object.create(null)` sidesteps prototype-pollution entirely rather than
// filtering key names one at a time: a malformed or crafted backup (see
// mergeCashAddressSecretIndices) can populate this object with arbitrary
// string keys without ever touching Object.prototype. LUD-26 started these
// over at 0 under new keys: the old counters ran on the superseded scheme,
// and carrying them over would leave a gap a gap-limited recovery scan
// never crosses.
const ADDRESS_STORAGE_KEY = 'lnurlcash_lud26_wallet_indices'
const CHANGE_STORAGE_KEY = 'lnurlcash_lud26_change_indices'
const LEGACY_STORAGE_KEYS = [
  'lnurlcash_cash_address_indices',
  'lnurlcash_cash_change_indices'
]
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
  for (const key of LEGACY_STORAGE_KEYS) localStorage.removeItem(key)
}

// S for `domain` (any URL or host of the mint) - null whenever no cash root
// is loaded (locked, or a wallet that hasn't re-entered its seed since this
// feature shipped)
const serviceRoot = (domain: string): HDKey | null => {
  const root = cashRoot
  return root
    ? cached(`S ${serviceDomainOf(domain)}`, () =>
        deriveServiceRoot(root, domain)
      )
    : null
}

const ACCOUNT = 0

// the wallet note at index i - an actual secp256k1 scalar whose x-only
// public key is the note's Q (a BIP-340 signer negates it for an odd y
// itself). Pure - no counter side effect of its own, so a recovery scan can
// probe index by index (LUD-26's gap-limit convention, see recovery.ts)
// without any bookkeeping.
export const cashAddressSecretAtIndex = (
  domain: string,
  index: number
): Uint8Array | null => {
  const root = serviceRoot(domain)
  return root
    ? deriveNoteKey(root, {chain: 'wallet', account: ACCOUNT, index}).secretKey
    : null
}

// the change-chain counterpart to cashAddressSecretAtIndex
export const changeSecretAtIndex = (
  domain: string,
  index: number
): Uint8Array | null => {
  const root = serviceRoot(domain)
  return root
    ? deriveNoteKey(root, {chain: 'change', account: ACCOUNT, index}).secretKey
    : null
}

// Many Lightning Addresses per mint: each registers its own share
// S/0'/2/n' as its cx1, hardened, so one address's cx1 never reveals
// another's or the wallet's own notes. A SERVICE never accepts a share
// twice, so every registration (and every move by updateUsername) takes a
// fresh one - see addressRegistry.ts's nextShare.
export const addressShareCx1 = (domain: string, share: number): Cx1 | null => {
  const root = serviceRoot(domain)
  return root ? shareCx1(deriveShareNode(root, ACCOUNT, share)) : null
}

// the key a share's register/update/unregister proofs are signed with: the
// share node's own (lib/signature.ts's signAddressProof)
export const addressShareKey = (
  domain: string,
  share: number
): Uint8Array | null => {
  const root = serviceRoot(domain)
  return root ? deriveShareNode(root, ACCOUNT, share).privateKey : null
}

// a note the SERVICE credited to `share` at index i - picked by the SERVICE
// at settlement, so there is nothing for this wallet to count ahead of a
// scan (addressRecovery.ts's scanRegisteredAddress)
export const shareSecretAtIndex = (
  domain: string,
  share: number,
  index: number
): Uint8Array | null => {
  const root = serviceRoot(domain)
  return root
    ? deriveNoteKey(root, {chain: 'share', account: ACCOUNT, share, index})
        .secretKey
    : null
}

// x-only keys (hex) of every note this seed could have made at `domain`
// under LUD-26: the wallet and change chains up to their counters plus
// `margin`, and each of `shares` up to its own index bound. Anything this
// wallet holds as a ck1 outside this set is not recoverable from the seed
// by an ordinary rescan - a note from before LUD-26, or one received from
// someone else - and a refresh moves it onto the wallet chain
// (lud26Migration.ts). Empty with no cash root loaded.
export const seedNoteKeys = (
  domain: string,
  shares: {share: number; upTo: number}[] = [],
  margin = 20
): Set<string> => {
  const keys = new Set<string>()
  const root = serviceRoot(domain)
  if (!root) return keys
  const S = serviceDomainOf(domain)
  const chain = (path: string, parent: () => HDKey, upTo: number) => {
    const node = cached(`${path} ${S}`, parent)
    for (let i = 0; i < upTo; i++) {
      keys.add(bytesToHex(node.deriveChild(i).publicKey!.slice(1)))
    }
  }
  const account = () =>
    cached(`S/0' ${S}`, () => root.deriveChild(HARDENED_OFFSET + ACCOUNT))
  chain(
    "S/0'/0",
    () => account().deriveChild(0),
    nextCashAddressSecretIndex(domain) + margin
  )
  chain(
    "S/0'/1",
    () => account().deriveChild(1),
    nextChangeSecretIndex(domain) + margin
  )
  for (const {share, upTo} of shares) {
    chain(
      `S/0'/2/${share}'`,
      () => deriveShareNode(root, ACCOUNT, share),
      upTo + margin
    )
  }
  return keys
}

// ---- superseded derivation (before LUD-26), read-only, for sweeping ----
//
// The old branch node hashed the host as stored, port included; addresses
// registered either the branch itself (no slot) or its hardened child
// `slot` (2, 3, ...), and their notes were tweaks off it under purpose 2.
export const LEGACY_FIRST_ADDRESS_SLOT = 2

const legacyNode = (domain: string, slot?: number): HDKey | null => {
  const root = cashRoot
  if (!root) return null
  const node = cached(`legacy ${domain}`, () =>
    deriveDomainBranchNode(root, domain)
  )
  return slot === undefined
    ? node
    : cached(`legacy ${domain} ${slot}`, () =>
        node.deriveChild(HARDENED_OFFSET + slot)
      )
}

// the old note at `index` under `purpose` (null: the pre-purpose variant)
export const legacySecretAtIndex = (
  domain: string,
  purpose: number | null,
  index: number,
  slot?: number
): Uint8Array | null => {
  const node = legacyNode(domain, slot)
  if (!node?.privateKey || !node.chainCode) return null
  return legacyDeriveNoteSecretKey(
    node.privateKey,
    node.chainCode,
    purpose,
    index
  )
}

// what signs the PUT (and DELETE) of an old registration: LUD-26 checks a
// proof against x(P) of the cx1 on file, and an old 64-byte cx1's P is the
// branch (or slot) node itself - its own key, not the purpose-0 index-0
// tweak the pre-LUD-26 proofs used
export const legacyAddressProofKey = (
  domain: string,
  slot?: number
): Uint8Array | null => legacyNode(domain, slot)?.privateKey ?? null

export const legacyAddressSecretAtIndex = (
  domain: string,
  index: number,
  slot?: number
): Uint8Array | null =>
  legacySecretAtIndex(
    domain,
    LEGACY_NOTE_PURPOSE_LIGHTNING_ADDRESS,
    index,
    slot
  )

// LUD-26's "next index" convention - a wallet-INITIATED mint/transfer's own
// pubkey-bound output, returned as its actual bearer secret (a ck1 - see
// signNoteOwnership) rather than a raw preimage, from the wallet chain's
// counter.
export const nextCashAddressSecretIndex = (domain: string): number =>
  readIndices(ADDRESS_STORAGE_KEY)[domain] ?? 0

export const nextCashAddressSecret = (domain: string): string | null => {
  const i = nextCashAddressSecretIndex(domain)
  const secretKey = cashAddressSecretAtIndex(domain, i)
  if (secretKey === null) return null
  const indices = readIndices(ADDRESS_STORAGE_KEY)
  indices[domain] = i + 1
  writeIndices(ADDRESS_STORAGE_KEY, indices)
  const {pubkeyXOnly, signature} = signNoteOwnership(secretKey, domain)
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

export const readCashChangeSecretIndices = (): Indices =>
  readIndices(CHANGE_STORAGE_KEY)

export const clearCashChangeSecretIndices = (): void => {
  localStorage.removeItem(CHANGE_STORAGE_KEY)
}

export const nextChangeSecretIndex = (domain: string): number =>
  readIndices(CHANGE_STORAGE_KEY)[domain] ?? 0

// `(domain) => string | null` already matches PubkeySecretProvider's own
// shape exactly (secrets.ts) - wired in directly via
// configureChangePubkeySecretProvider (lnurlcash.ts), no wrapper needed.
// Unlike requireRecoverableCashAddressSecret's mint-invoice case, a caller
// here never NEEDS this to succeed: src/lib's splitNote/internalTransfer.ts
// both fall back to a plain bearer change note whenever this returns null
// (no cash root loaded), same as generatePubkeySecret's own contract.
export const nextChangeSecret = (domain: string): string | null => {
  const i = nextChangeSecretIndex(domain)
  const secretKey = changeSecretAtIndex(domain, i)
  if (secretKey === null) return null
  const indices = readIndices(CHANGE_STORAGE_KEY)
  indices[domain] = i + 1
  writeIndices(CHANGE_STORAGE_KEY, indices)
  const {pubkeyXOnly, signature} = signNoteOwnership(secretKey, domain)
  return encodeCk1(pubkeyXOnly, signature)
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

export const mergeCashChangeSecretIndices = (incoming: unknown): void =>
  mergeIndicesInto(CHANGE_STORAGE_KEY, incoming)

// A bearer note's own reload-survival - deliberately NOT seed-derived (25.md
// defines no derivation for bearer notes, see this file's header comment).
// generateMintSecret (lnurlcash.ts) generates a plain random secret for a
// mint/transfer quote and records it here before the invoice leaves the
// wallet, so a reload between "invoice shown" and "payment settled" doesn't
// strand the bearer note SERVICE will credit - the UI can
// still recover it from this flat, per-domain, append-only list even though
// component state (and any deterministic re-derivation) is gone. This is a
// same-device, same-localStorage guarantee only: unlike a key-path note's
// cx1 branch, nothing here survives a lost device or a fresh reinstall -
// 25.md never promises recoverability for bearer notes either (Seed &
// derivation covers key-path notes only).
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

// The same reload-survival for a rotate/split/merge's own plain bearer
// output (lnurlcash.ts's generateNoteSecret) - recorded here BEFORE its
// hash leaves the wallet as p1/p2, so the secret outlives a reload, a closed
// tab, or an AmbiguousMutationError whose follow-up probe guessed wrong (a
// request that stalled - e.g. a hung TLS handshake - can still be processed
// AFTER the probe reported the input live, leaving the mint holding value
// under a hash whose secret was only ever in memory). Unlike a key-path
// output there is nothing to rescan from seed, so this journal is the only
// copy until the output is persisted as a bearer (WalletContext clears it
// there) or pendingOutputs.ts's reconcile settles it. Same plain,
// same-device trust model as the pending mint list above.
const PENDING_OUTPUT_SECRETS_KEY = 'lnurlcash_pending_output_secrets'
export type PendingOutputSecret = {secret: string; createdAt: number}
type PendingOutputSecrets = Record<string, PendingOutputSecret[]>

const readPendingOutputSecrets = (): PendingOutputSecrets => {
  try {
    const raw = localStorage.getItem(PENDING_OUTPUT_SECRETS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const result: PendingOutputSecrets = {}
    for (const [domain, entries] of Object.entries(parsed)) {
      if (!Array.isArray(entries)) continue
      const valid = entries.filter(
        (e): e is PendingOutputSecret =>
          typeof e?.secret === 'string' && typeof e?.createdAt === 'number'
      )
      if (valid.length > 0) result[domain] = valid
    }
    return result
  } catch {
    return {}
  }
}

const writePendingOutputSecrets = (secrets: PendingOutputSecrets): void => {
  localStorage.setItem(PENDING_OUTPUT_SECRETS_KEY, JSON.stringify(secrets))
}

// throws if localStorage refuses the write - deliberately: the caller is
// about to disclose this secret's hash, and must not do so with the secret
// held nowhere but memory
export const recordPendingOutputSecret = (
  domain: string,
  secret: string,
  now: number = Date.now()
): void => {
  const all = readPendingOutputSecrets()
  const list = all[domain] ?? []
  if (list.some(e => e.secret === secret)) return
  writePendingOutputSecrets({
    ...all,
    [domain]: [...list, {secret, createdAt: now}]
  })
}

// domain-agnostic: the persist hook only has the stored url's k1 in hand,
// and a 32-byte random secret never collides across domains anyway
export const clearPendingOutputSecret = (secret: string): void => {
  const all = readPendingOutputSecrets()
  let changed = false
  const next: PendingOutputSecrets = {}
  for (const [domain, list] of Object.entries(all)) {
    const kept = list.filter(e => e.secret !== secret)
    if (kept.length !== list.length) changed = true
    if (kept.length > 0) next[domain] = kept
  }
  if (changed) writePendingOutputSecrets(next)
}

export const pendingOutputSecrets = (): PendingOutputSecrets =>
  readPendingOutputSecrets()

export const clearPendingOutputSecrets = (): void => {
  localStorage.removeItem(PENDING_OUTPUT_SECRETS_KEY)
}
