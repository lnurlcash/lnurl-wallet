// LUD-25 domain-branch derivation - the BIP32 hop from a wallet's own
// m/139' LUD-25 root down to the per-SERVICE branch a domain's cx1/cp1/ck1
// values are derived under. "seed phrase -> m/139' root" is deliberately NOT
// here (see this package's README: nothing seed/mnemonic-specific lives in
// the kit, that's wallet policy - lnurl-wallet's own
// keys.ts:deriveLud25CashRootNode does that half). But once a caller has
// *some* m/139' node, walking it down to a given domain's branch is fully
// specified by the LUD-25 draft (25.md, "Seed & derivation") and MUST match
// byte-for-byte across wallets that share a seed phrase, or notes minted in
// one wallet become unrecoverable in another - unlike recoverableNotes.ts's
// per-note tweak (which only ever needs a published cx1 to reproduce),
// nothing about this step is disclosed on the wire, so a shared, exported,
// directly-testable reference is the only way two independent
// implementations can ever confirm they agree. See branchDerivation.test.ts.
//
// This is deliberately the literal spec path, no extra purpose hop:
//
//   deriveDomainBranchNode(cashRoot, domain) -> m/139'/d1/d2/d3/d4
//
// (25.md defines no derivation for plain bearer notes;
// a WALLET is free to generate that secret however it likes. lnurl-wallet
// does so with plain randomness, not a seed-derived branch, so there is no
// second scheme competing for this same path.)
import {HDKey, HARDENED_OFFSET} from '@scure/bip32'
import {hmac} from '@noble/hashes/hmac.js'
import {sha256} from '@noble/hashes/sha2.js'
import {utf8ToBytes} from '@noble/hashes/utils.js'
import type {Cx1, LegacyCx1} from './recoverableNotes'

// LUD-25's own purpose (unrelated to LUD-05's m/138') - lnurl-wallet keeps
// its whole seed-recoverable note tree under here.
export const CASH_ROOT_PURPOSE = 139 + HARDENED_OFFSET // m/139'

const readUint32BE = (bytes: Uint8Array, offset: number): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    offset,
    false
  )

// LUD-05's own steps 1-3 (https://github.com/lnurl/luds/blob/luds/05.md),
// reused verbatim here rather than re-specified: HMAC-SHA256(hashingKey,
// domain), then the first 16 bytes of that MAC read back as four big-endian
// uint32 BIP32 child indices. Whether each of the four ends up hardened
// depends solely on its own magnitude (>= 2^31) - never forced either way,
// exactly as LUD-05 leaves it.
export const lud05PathSuffix = (
  hashingKey: Uint8Array,
  domain: string
): number[] => {
  const material = hmac(sha256, hashingKey, utf8ToBytes(domain))
  return [0, 4, 8, 12].map(i => readUint32BE(material, i))
}

// The domain-branch walk: derive a domain-bound hashing key at `root`'s own
// child 0, HMAC the domain to get the branch's four path indices, then walk
// them non-hardened from `root`. `root` is `cashRoot` (m/139') per the spec
// text - a separate purpose hop is not part of it.
export const deriveDomainBranchNode = (root: HDKey, domain: string): HDKey => {
  const hashingNode = root.deriveChild(0)
  if (!hashingNode.privateKey) {
    throw new Error('Could not derive domain-branch hashing key')
  }
  const suffix = lud05PathSuffix(hashingNode.privateKey, domain)
  let node = root
  for (const index of suffix) node = node.deriveChild(index)
  return node
}

// ---- LUD-26: the tree below each SERVICE's root ----
//
//   S            = m/139'/d1/d2/d3/d4      deriveServiceRoot
//   S/a'/0/i     wallet: every note this wallet mints, rotates or merges into, and a split's p1
//   S/a'/1/i     change: a split's p2
//   S/a'/2/n'    share n, handed out as its cx1 (an xpub)
//   S/a'/2/n'/i  note i of share n, picked and credited by the SERVICE
//
// Plain BIP-32 all the way down: a note's secret key is the private key at
// its path and its Q is x(sk·G), so any BIP-32 library derives the same
// tree, and a SERVICE holding a share's cx1 derives that share's notes with
// CKDpub (recoverableNotes.ts's deriveNotePubkey). Accounts and shares are
// hardened; note indices are not.

export const CHAIN_WALLET = 0
export const CHAIN_CHANGE = 1
export const CHAIN_SHARE = 2

// The string every signature at a mint commits to, and what S is hashed
// over: the lowercase hostname, never a scheme or port - so `localhost:3338`
// and `localhost` are the same mint and the same tree. Accepts a bare host,
// a host:port, or any URL.
export const serviceDomainOf = (value: string): string => {
  const trimmed = value.trim()
  const url = new URL(
    /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  )
  return url.hostname.toLowerCase()
}

// S for one mint, from the wallet's m/139' root. Bearer material for every
// note the wallet holds there: hand out a share's cx1, never this node.
// The superseded schemes hashed the host as stored, port included (see
// deriveDomainBranchNode); for a host without a port the two are one node.
export const deriveServiceRoot = (root: HDKey, domain: string): HDKey =>
  deriveDomainBranchNode(root, serviceDomainOf(domain))

export type NotePath =
  | {chain: 'wallet'; account: number; index: number}
  | {chain: 'change'; account: number; index: number}
  | {chain: 'share'; account: number; share: number; index: number}

const belowHardened = (value: number, what: string): number => {
  if (!Number.isInteger(value) || value < 0 || value >= HARDENED_OFFSET) {
    throw new Error(`${what} ${value} is not below 2^31.`)
  }
  return value
}

// the BIP-32 indices below S, hardened ones included
export const notePathIndices = (path: NotePath): number[] => {
  const account = belowHardened(path.account, 'An account') + HARDENED_OFFSET
  const index = belowHardened(path.index, 'A note index')
  switch (path.chain) {
    case 'wallet':
      return [account, CHAIN_WALLET, index]
    case 'change':
      return [account, CHAIN_CHANGE, index]
    case 'share':
      return [
        account,
        CHAIN_SHARE,
        belowHardened(path.share, 'A share') + HARDENED_OFFSET,
        index
      ]
  }
}

export type NoteKey = {
  secretKey: Uint8Array
  // compressed, so its y parity is visible
  pubkey: Uint8Array
  // Q = x(pubkey), the note itself
  outputKey: Uint8Array
}

// the note at `path` below a SERVICE root (deriveServiceRoot)
export const deriveNoteKey = (serviceRoot: HDKey, path: NotePath): NoteKey => {
  let node = serviceRoot
  for (const index of notePathIndices(path)) node = node.deriveChild(index)
  if (!node.privateKey || !node.publicKey) {
    throw new Error('Could not derive the note key.')
  }
  return {
    secretKey: node.privateKey,
    pubkey: node.publicKey,
    outputKey: node.publicKey.slice(1)
  }
}

// S/a'/2/n', the node behind a share's cx1: its own key signs the share's
// registration proofs (signature.ts's signAddressProof)
export const deriveShareNode = (
  serviceRoot: HDKey,
  account: number,
  share: number
): HDKey =>
  serviceRoot
    .deriveChild(belowHardened(account, 'An account') + HARDENED_OFFSET)
    .deriveChild(CHAIN_SHARE)
    .deriveChild(belowHardened(share, 'A share') + HARDENED_OFFSET)

// a share node's cx1, never its private half
export const shareCx1 = (node: HDKey): Cx1 => {
  if (!node.publicKey) throw new Error('A share node has no public key.')
  return {chainCode: node.chainCode!, pubkey: node.publicKey}
}

// ---- superseded: the legacy branch, for sweeping only ----
//
// The node the per-note tweak scheme (before luds a6c4652) derived its notes
// from is deriveDomainBranchNode over the host as the wallet stored it, port
// included; its watch-only half was the 64-byte x(P) || chain_code.
export const legacyCx1Of = (node: HDKey): LegacyCx1 => {
  if (!node.publicKey) throw new Error('A branch node has no public key.')
  return {pubkeyXOnly: node.publicKey.slice(1), chainCode: node.chainCode!}
}
