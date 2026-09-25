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
