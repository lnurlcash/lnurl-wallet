import {describe, expect, it} from 'vitest'
import {bytesToHex} from '@noble/hashes/utils.js'
import {mnemonicToSeedSync} from '@scure/bip39'
import {HDKey} from '@scure/bip32'
import {schnorr} from '@noble/curves/secp256k1.js'
import {
  CASH_ROOT_PURPOSE,
  ADDRESS_BRANCH_PURPOSE,
  lud05PathSuffix,
  deriveDomainBranchNode
} from './branchDerivation'
import {
  deriveNotePubkey,
  deriveNoteSecretKey,
  encodeCp1
} from './recoverableNotes'

describe('deriveDomainBranchNode', () => {
  it('Part 1 and Part 2 share the same walk, rooted differently', () => {
    const master = HDKey.fromMasterSeed(
      mnemonicToSeedSync(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      )
    )
    const cashRoot = master.deriveChild(CASH_ROOT_PURPOSE)
    const part1 = deriveDomainBranchNode(cashRoot, 'mint.example')
    const part2 = deriveDomainBranchNode(
      cashRoot.deriveChild(ADDRESS_BRANCH_PURPOSE),
      'mint.example'
    )
    // same domain, different root purpose -> unrelated keys
    expect(bytesToHex(part1.publicKey!)).not.toBe(bytesToHex(part2.publicKey!))
    // deterministic
    expect(
      bytesToHex(deriveDomainBranchNode(cashRoot, 'mint.example').publicKey!)
    ).toBe(bytesToHex(part1.publicKey!))
  })

  it('throws rather than silently returning a wrong node when handed a public-only root', () => {
    const master = HDKey.fromMasterSeed(
      mnemonicToSeedSync(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      )
    )
    const cashRoot = master.deriveChild(CASH_ROOT_PURPOSE)
    const publicOnly = HDKey.fromExtendedKey(cashRoot.publicExtendedKey)
    expect(() => deriveDomainBranchNode(publicOnly, 'mint.example')).toThrow()
  })
})

// Cross-implementation vector: mnemonic, mint domain and expected cp1
// borrowed from an INDEPENDENT LUD-25 Part 2 client written against a
// different stack (org.tbk.lnurlcash.playground.example.utils
// .LnurlcashWalletUtilsTest - a JVM wallet built on ACINQ's bitcoin-kmp/
// secp256k1-kmp, not this package). The point of this test isn't this
// package's own self-consistency (recoverableNotes.test.ts already covers
// that) - it's proof that two separately-written implementations, given the
// same seed phrase and mint domain, derive the exact same watch-only branch
// and the exact same index-0 note pubkey. Every intermediate value below was
// captured from a real run of this package's own code, so a future change
// that silently breaks cross-wallet recoverability fails at the step that
// actually changed, not just at the final cp1 comparison.
describe('LUD-25 Part 2 branch derivation - cross-implementation vector', () => {
  const MNEMONIC =
    'dragon spell warfare girl patrol false erase surprise satisfy lucky curious ill'
  const MINT_DOMAIN = 'https://mint.lnurlcash.com'
  const EXPECTED_CP1 =
    'cp1p264cpjjmuuxeal7n6tdmlcf54leqn5pfm5pl7fz2xec92xe7r7q8plxc7'

  it('step 1: BIP39 seed from the fixed mnemonic', () => {
    const seed = mnemonicToSeedSync(MNEMONIC)
    expect(bytesToHex(seed)).toBe(
      '1c77403f77e0c9c558fa00cdea65ec5c5b7eb9bd10880219b9f5d8fa259aad14a81e9ad409641fd61ba3024de788cd88a1f0a27f0ff0a1a8ae140bd17bc3ee5c'
    )
  })

  it("step 2: BIP32 master -> m/139' cash root", () => {
    const master = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC))
    const cashRoot = master.deriveChild(CASH_ROOT_PURPOSE)
    expect(bytesToHex(cashRoot.privateKey!)).toBe(
      '4a3d18056e50748412b8f4e3b2cc52f536c7c50743c00d9e81c79a6689f6ed20'
    )
    expect(bytesToHex(cashRoot.publicKey!)).toBe(
      '034d027129bfb3d6bc2cc75572288f3275ebfdf64929beb7f2118afb6b94735015'
    )
    expect(bytesToHex(cashRoot.chainCode!)).toBe(
      '55caea700c82759aabef7611ecd76eae9524d58074f0c2590b9f9fe33992bf6c'
    )
  })

  it("step 3: cash root -> m/139'/1' Part 2 address-branch purpose", () => {
    const master = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC))
    const cashRoot = master.deriveChild(CASH_ROOT_PURPOSE)
    const addressRoot = cashRoot.deriveChild(ADDRESS_BRANCH_PURPOSE)
    expect(bytesToHex(addressRoot.privateKey!)).toBe(
      'ac8746274b14bf620a15e79aa198767cd4ea7d34bcbfadb8fa02a822543d0f6b'
    )
    expect(bytesToHex(addressRoot.publicKey!)).toBe(
      '026b35f02609607966f0dd7e27380731131ded979576ac6b1adf7dc9a2a454e64d'
    )
    expect(bytesToHex(addressRoot.chainCode!)).toBe(
      'e73363ffc9f02cae9df24f896107bae7b7f173c105ddd0f1eb9ad41409b24bfe'
    )
  })

  it("step 4: address root's own child 0 - the domain-hashing key", () => {
    const master = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC))
    const addressRoot = master
      .deriveChild(CASH_ROOT_PURPOSE)
      .deriveChild(ADDRESS_BRANCH_PURPOSE)
    const hashingNode = addressRoot.deriveChild(0)
    expect(bytesToHex(hashingNode.privateKey!)).toBe(
      'b32c81f83998d7ef43d6a308e67af62b23612f9701c3bf89a6013a7b90001650'
    )
  })

  it('step 5: HMAC-SHA256(hashingKey, domain) -> four big-endian uint32 path indices', () => {
    const master = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC))
    const hashingNode = master
      .deriveChild(CASH_ROOT_PURPOSE)
      .deriveChild(ADDRESS_BRANCH_PURPOSE)
      .deriveChild(0)
    const suffix = lud05PathSuffix(hashingNode.privateKey!, MINT_DOMAIN)
    expect(suffix).toEqual([441958618, 4004023034, 3109408102, 324642731])
  })

  it("step 6: the full walk -> m/139'/1'/d1/d2/d3/d4 branch node", () => {
    const master = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC))
    const cashRoot = master.deriveChild(CASH_ROOT_PURPOSE)
    const branch = deriveDomainBranchNode(
      cashRoot.deriveChild(ADDRESS_BRANCH_PURPOSE),
      MINT_DOMAIN
    )
    expect(bytesToHex(branch.privateKey!)).toBe(
      '17436bda95df455b6691a0e0c0cbf077007acf0a57f7fb2aad29b7059d9ffb20'
    )
    expect(bytesToHex(branch.publicKey!)).toBe(
      '02f09f1970faba83e4b345db8f43963fc570deda63f7cfbe95baa2a1a10891e580'
    )
    expect(bytesToHex(branch.publicKey!.slice(1))).toBe(
      'f09f1970faba83e4b345db8f43963fc570deda63f7cfbe95baa2a1a10891e580'
    )
    expect(bytesToHex(branch.chainCode!)).toBe(
      'ba890ada12a853b95a3741b05800bc66f7b43567ac12ab649cb64bdf2e5f2e42'
    )
  })

  it('step 7: index-0 note pubkey off the branch (the per-note tweak from recoverableNotes.ts)', () => {
    const master = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC))
    const cashRoot = master.deriveChild(CASH_ROOT_PURPOSE)
    const branch = deriveDomainBranchNode(
      cashRoot.deriveChild(ADDRESS_BRANCH_PURPOSE),
      MINT_DOMAIN
    )
    const notePubkey0 = deriveNotePubkey(
      branch.publicKey!.slice(1),
      branch.chainCode!,
      0
    )
    expect(bytesToHex(notePubkey0)).toBe(
      '0ab55c0652df386cf7fe9e96ddff09a57f904e814ee81ff92251b382a8d9f0fc'
    )
  })

  it('step 8: cp1-encodes to the exact value the independent JVM client expects', () => {
    const master = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC))
    const cashRoot = master.deriveChild(CASH_ROOT_PURPOSE)
    const branch = deriveDomainBranchNode(
      cashRoot.deriveChild(ADDRESS_BRANCH_PURPOSE),
      MINT_DOMAIN
    )
    const notePubkey0 = deriveNotePubkey(
      branch.publicKey!.slice(1),
      branch.chainCode!,
      0
    )
    expect(encodeCp1(notePubkey0)).toBe(EXPECTED_CP1)
  })

  it("step 9: the branch's own private key derives a secret whose pubkey round-trips to the same notePubkey0", () => {
    const master = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC))
    const cashRoot = master.deriveChild(CASH_ROOT_PURPOSE)
    const branch = deriveDomainBranchNode(
      cashRoot.deriveChild(ADDRESS_BRANCH_PURPOSE),
      MINT_DOMAIN
    )
    const noteSecretKey0 = deriveNoteSecretKey(
      branch.privateKey!,
      branch.chainCode!,
      0
    )
    expect(bytesToHex(noteSecretKey0)).toBe(
      'd603a139cfc7acdc86762cc7cceb640a22718e9390158022d5d0dc1667da653b'
    )
    expect(bytesToHex(schnorr.getPublicKey(noteSecretKey0))).toBe(
      bytesToHex(
        deriveNotePubkey(branch.publicKey!.slice(1), branch.chainCode!, 0)
      )
    )
  })
})
