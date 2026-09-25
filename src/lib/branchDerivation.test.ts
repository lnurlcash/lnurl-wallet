import {describe, expect, it} from 'vitest'
import {bytesToHex} from '@noble/hashes/utils.js'
import {mnemonicToSeedSync} from '@scure/bip39'
import {HDKey} from '@scure/bip32'
import {schnorr} from '@noble/curves/secp256k1.js'
import {
  CASH_ROOT_PURPOSE,
  lud05PathSuffix,
  deriveDomainBranchNode
} from './branchDerivation'
import {
  deriveNotePubkey,
  deriveNoteSecretKey,
  encodeCp1,
  NOTE_PURPOSE_WALLET
} from './recoverableNotes'

describe('deriveDomainBranchNode', () => {
  it('is deterministic and differs per domain', () => {
    const master = HDKey.fromMasterSeed(
      mnemonicToSeedSync(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      )
    )
    const cashRoot = master.deriveChild(CASH_ROOT_PURPOSE)
    const a = deriveDomainBranchNode(cashRoot, 'mint.example')
    const b = deriveDomainBranchNode(cashRoot, 'other.example')
    expect(bytesToHex(a.publicKey!)).not.toBe(bytesToHex(b.publicKey!))
    expect(
      bytesToHex(deriveDomainBranchNode(cashRoot, 'mint.example').publicKey!)
    ).toBe(bytesToHex(a.publicKey!))
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

// Vector pinning the literal LUD-25 "Seed & derivation" path (25.md):
// cashHashingKey = derive(masterKey, m/139'/0), domainMaterial =
// hmacSha256(cashHashingKey, full SERVICE domain), branch = derive(masterKey,
// m/139'/d1/d2/d3/d4) - no extra purpose hop, and `domain` is LUD-05's own
// bare-FQDN form (05.md: "for https://x.y.z.com/... it would be x.y.z.com"),
// matching what this repo's own serverOf() actually feeds in at runtime
// (src/lnurlcash.ts re-exports it from src/lib/urls.ts). An earlier version
// of this file pinned a value from an independent JVM client's own test
// vector instead; that value depended on a non-spec purpose hop this repo
// used to add (m/139'/1') and a non-spec scheme-prefixed domain string
// ("https://mint.lnurlcash.com" rather than the bare host) - two deviations
// that happened to cancel out for that one test. This vector intentionally
// does NOT reproduce it; it pins the literal spec text instead.
describe('LUD-25 branch derivation - literal spec-path vector', () => {
  const MNEMONIC =
    'dragon spell warfare girl patrol false erase surprise satisfy lucky curious ill'
  const MINT_DOMAIN = 'mint.lnurlcash.com'

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

  it("step 3: cash root's own child 0 - the domain-hashing key", () => {
    const master = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC))
    const hashingNode = master.deriveChild(CASH_ROOT_PURPOSE).deriveChild(0)
    expect(bytesToHex(hashingNode.privateKey!)).toBe(
      'b830f0fba87088a5a9f5c49869d0efc8688f5e474ce6bb190e645fc44d051e85'
    )
  })

  it('step 4: HMAC-SHA256(hashingKey, bare-host domain) -> four big-endian uint32 path indices', () => {
    const master = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC))
    const hashingNode = master.deriveChild(CASH_ROOT_PURPOSE).deriveChild(0)
    const suffix = lud05PathSuffix(hashingNode.privateKey!, MINT_DOMAIN)
    expect(suffix).toEqual([738629152, 1209031866, 1901688010, 3539475032])
  })

  it("step 5: the full walk -> m/139'/d1/d2/d3/d4 branch node", () => {
    const master = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC))
    const cashRoot = master.deriveChild(CASH_ROOT_PURPOSE)
    const branch = deriveDomainBranchNode(cashRoot, MINT_DOMAIN)
    expect(bytesToHex(branch.privateKey!)).toBe(
      'ec94d2f4f89e8ea4f4335970e9a7781e30b4223eb405b070f9e3930afccbdc9b'
    )
    expect(bytesToHex(branch.publicKey!)).toBe(
      '028e01241eef39ebb12e56b391fa21ba58aa5b89de33442ea7827d753b6f632a31'
    )
    expect(bytesToHex(branch.publicKey!.slice(1))).toBe(
      '8e01241eef39ebb12e56b391fa21ba58aa5b89de33442ea7827d753b6f632a31'
    )
    expect(bytesToHex(branch.chainCode!)).toBe(
      '62ba198d1cf6f086f85f867aff7f8d6845a65dd93152df219f1815d1f707bc99'
    )
  })

  it('step 6: index-0 note pubkey off the branch (the per-note tweak from recoverableNotes.ts)', () => {
    const master = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC))
    const cashRoot = master.deriveChild(CASH_ROOT_PURPOSE)
    const branch = deriveDomainBranchNode(cashRoot, MINT_DOMAIN)
    const notePubkey0 = deriveNotePubkey(
      branch.publicKey!.slice(1),
      branch.chainCode!,
      NOTE_PURPOSE_WALLET,
      0
    )
    expect(bytesToHex(notePubkey0)).toBe(
      'be5f31ff0b2bc0329961bcb08722b3033ab77a8bb35c776236a15d35afd911ab'
    )
    expect(encodeCp1(notePubkey0)).toBe(
      'cp1he0nrlct90qr9xtphjcgwg4nqvatw75tkdw8wc3k59wntt7ezx4ssr0vem'
    )
  })

  it("step 7: the branch's own private key derives a secret whose pubkey round-trips to the same notePubkey0", () => {
    const master = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC))
    const cashRoot = master.deriveChild(CASH_ROOT_PURPOSE)
    const branch = deriveDomainBranchNode(cashRoot, MINT_DOMAIN)
    const noteSecretKey0 = deriveNoteSecretKey(
      branch.privateKey!,
      branch.chainCode!,
      NOTE_PURPOSE_WALLET,
      0
    )
    expect(bytesToHex(noteSecretKey0)).toBe(
      '96dd2859f09d747bc0913083056d371509bd5e03dcfe472fdf8cc17f7c3c9798'
    )
    expect(bytesToHex(schnorr.getPublicKey(noteSecretKey0))).toBe(
      bytesToHex(
        deriveNotePubkey(
          branch.publicKey!.slice(1),
          branch.chainCode!,
          NOTE_PURPOSE_WALLET,
          0
        )
      )
    )
  })
})
