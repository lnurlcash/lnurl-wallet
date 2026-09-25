// Implements, one by one, the "Test Vectors" section of LUD-25
// (https://github.com/lnurl/luds/blob/lnurlcash/25.md#test-vectors) against
// this package's own real exported functions - never a re-implementation of
// the math, so this file can only ever pass if the actual kit code produces
// the exact bytes the spec document publishes. If either drifts (a spec
// edit, a code change), this is where that shows up first.
import {describe, expect, it} from 'vitest'
import {HDKey} from '@scure/bip32'
import {secp256k1, schnorr} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {
  CASH_ROOT_PURPOSE,
  lud05PathSuffix,
  deriveDomainBranchNode
} from './branchDerivation'
import {
  deriveNotePubkey,
  deriveNoteSecretKey,
  encodeCp1,
  encodeCk1,
  encodeCx1,
  encodeCs1WithAmount,
  encodeCw1,
  outputKeyOfCw1,
  NOTE_PURPOSE_WALLET,
  NOTE_PURPOSE_CHANGE,
  NOTE_PURPOSE_LIGHTNING_ADDRESS
} from './recoverableNotes'
import {
  signNoteOwnership,
  signAddressProof,
  recoverNoteOwnershipPubkey,
  verifyNoteSignature,
  verifyNoteSignatureForKey,
  verifyNoteSignatureHash
} from './signature'
import {bearerNote, keyPathSighash} from './spend'

// Independent reimplementation of Seed & derivation's own tweak + point-add
// - NOT a call into recoverableNotes.ts's private tweakScalar/deriveNotePubkey
// internals - so t_i and the full point Q_i below cross-check the kit's real
// deriveNotePubkey/deriveNoteSecretKey output against a from-scratch
// computation, not just two copies of the same hardcoded hex.
const NOTE_DERIVE_TAG = 'LNURLcash/derive'
const CURVE_ORDER = schnorr.Point.CURVE().n

const ser32BE = (index: number): Uint8Array => {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, index, false)
  return bytes
}
const bytesToNumberBE = (bytes: Uint8Array): bigint =>
  BigInt(`0x${bytesToHex(bytes)}`)

const tweakAndPoint = (
  branchPubkeyXOnly: Uint8Array,
  chainCode: Uint8Array,
  purpose: number,
  index: number
) => {
  const rawTaggedHash = schnorr.utils.taggedHash(
    NOTE_DERIVE_TAG,
    branchPubkeyXOnly,
    chainCode,
    ser32BE(purpose),
    ser32BE(index)
  )
  const t = bytesToNumberBE(rawTaggedHash) % CURVE_ORDER
  const branchPoint = schnorr.utils.lift_x(bytesToNumberBE(branchPubkeyXOnly))
  const Q = branchPoint.add(schnorr.Point.BASE.multiply(t))
  return {
    tHex: t.toString(16).padStart(64, '0'),
    QCompressedHex: bytesToHex(Q.toBytes(true))
  }
}

// ---- Test vector 1: Seed & derivation (branch root has odd-y P) ----
describe('LUD-25 Test Vectors - vector 1 (Seed & derivation, odd-y P)', () => {
  // BIP-32's own "Test vector 1" seed - see 25.md's Test Vectors intro for
  // why these vectors deliberately reuse BIP-32's published seeds rather
  // than a fresh one
  const SEED = hexToBytes('000102030405060708090a0b0c0d0e0f')
  const DOMAIN = 'mint.example'
  const master = () => HDKey.fromMasterSeed(SEED)

  it("cashHashingKey (m/139'/0) and the domain-material suffix (d1..d4)", () => {
    const cashRoot = master().deriveChild(CASH_ROOT_PURPOSE)
    const hashingNode = cashRoot.deriveChild(0)
    expect(bytesToHex(hashingNode.privateKey!)).toBe(
      '45a46de715668a4250ddb7420e71f8cb2a165047095edda920c0bfeb7c4ab7a6'
    )
    const suffix = lud05PathSuffix(hashingNode.privateKey!, DOMAIN)
    expect(suffix).toEqual([2728808236, 3900943163, 3604736224, 1452184550])
  })

  it("branch root (m/139'/d1/d2/d3/d4) - odd-y P, and its cx1 export", () => {
    const cashRoot = master().deriveChild(CASH_ROOT_PURPOSE)
    const branch = deriveDomainBranchNode(cashRoot, DOMAIN)
    expect(bytesToHex(branch.privateKey!)).toBe(
      '7bbab40e4a022ea909cfee28eb1c7a9f56cf746feea94ff73f155a14f2c57d1e'
    )
    expect(bytesToHex(branch.publicKey!)).toBe(
      '03b783d2930dc053a971f019054ca43e7c9de50e0769de872dd1ddde5d0bf4c9d1'
    )
    // odd-y: compressed prefix 0x03 - this branch exercises the
    // sk_i = (n - p) + t formula, vector 2 exercises the other one
    expect(branch.publicKey![0]).toBe(0x03)
    expect(bytesToHex(branch.chainCode!)).toBe(
      'ab91cc11aea395ea6b62292a6147f51ef4150ebea04e745137b68719e238f904'
    )
    const cx1 = encodeCx1(branch.publicKey!.slice(1), branch.chainCode!)
    expect(cx1).toBe(
      'cx1k7pa9ycdcpf6ju0sryz5efp70jw72rs8d80gwtw3mh096zl5e8g6hywvzxh28902dd3zj2npgl63aaq4p6l2qnn52ymmdpceugu0jpqes280t'
    )
  })

  const branchOf = () =>
    deriveDomainBranchNode(master().deriveChild(CASH_ROOT_PURPOSE), DOMAIN)

  it.each([
    [
      NOTE_PURPOSE_WALLET,
      0,
      'b1d16430daa362837db746ce38dc6c5ebb092876692b5cac5bbdce0f3cd92688',
      '02690ac33892c64aa53874b0066ab1332f0ef45cb7c0e017eae0828916f52aa99f',
      '690ac33892c64aa53874b0066ab1332f0ef45cb7c0e017eae0828916f52aa99f',
      '3616b02290a133da73e758a54dbff1bf6439b4067a820cb51ca873fa4a13a96a',
      'cp1dy9vxwyjce922wr5kqrx4vfn9u80gh9hcrsp06hqs2y3daf24x0sxpcl6z'
    ],
    [
      NOTE_PURPOSE_WALLET,
      1,
      '1120c64b536e09cf1f08dad93edb7161682c739773a1330b4e137f3eb1cb9e48',
      '023e76b56c1a90bc64c4bf594be91a3cb8861a150232da92705cff6ee3714bb384',
      '3e76b56c1a90bc64c4bf594be91a3cb8861a150232da92705cff6ee3714bb384',
      '9566123d096bdb261538ecb053bef6c0cc0bdc0e3440834fced083b68f3c626b',
      'cp18emt2mq6jz7xf39lt997jx3uhzrp59gzxtdfyuzulahwxu2tkwzqjttard'
    ],
    [
      NOTE_PURPOSE_WALLET,
      2,
      'da4160b271948f81059ca631c4bdae0eed617f6f39d531d082c9472b795aa4c5',
      '0220146298f9b6439027ead2b4a15738a10721b26c425b58c634baac6147ee7fc7',
      '20146298f9b6439027ead2b4a15738a10721b26c425b58c634baac6147ee7fc7',
      '5e86aca4279260d7fbccb808d9a1336f96920aff4b2be1d943b3ed16869527a7',
      'cp1yq2x9x8ekepeqfl26262z4ec5yrjrvnvgfd43335h2kxz3lw0lrss2e4g5'
    ],
    // deliberately not contiguous with the run above - i is a plain
    // ser32(i) encode of whatever index WALLET is on, see 25.md
    [
      NOTE_PURPOSE_WALLET,
      5,
      '8cf628fcc47354f9c3a2a072f108b41da79792d8300bf8c9d8c74de61897d0a7',
      '02c64ed8f1cd0f4d23aba8ddd739d9ae7e1a7ba2719cb54437384498fbc73788b3',
      'c64ed8f1cd0f4d23aba8ddd739d9ae7e1a7ba2719cb54437384498fbc73788b3',
      '113b74ee7a712650b9d2b24a05ec397e50c81e684162a8d299b1f3d125d25389',
      'cp1ce8d3uwdpaxj82agmhtnnkdw0cd8hgn3nj65gdecgjv0h3eh3zes4mxg2k'
    ],
    // purpose 1 (change) and purpose 2 (Lightning Address), same index 0 -
    // 25.md's own point: purpose alone changes every derived value
    [
      NOTE_PURPOSE_CHANGE,
      0,
      'd17f99715d669d21e4172e3dee64d176b3a2ff18cfc56f9d359213fb5a016023',
      '03e9a2d71a45a4a5a22d3378bdd761f0b3b2622b6a939d24c779668379352d8274',
      'e9a2d71a45a4a5a22d3378bdd761f0b3b2622b6a939d24c779668379352d8274',
      '55c4e56313646e78da474015034856d75cd38aa8e11c1fa5f67cb9e6673be305',
      'cp1ax3dwxj95jj6ytfn0z7awc0skwexy2m2jwwjf3mev6phjdfdsf6qx02dpd'
    ],
    [
      NOTE_PURPOSE_LIGHTNING_ADDRESS,
      0,
      '00194391b44f24f7a5d3c8e2bd2854adcc536e3f2ddcdf5e8091f56117913685',
      '02acff3482453b4671e410d2158fd93ab7d4c3e8c1b9554ce1190deb021fd2cd4c',
      'acff3482453b4671e410d2158fd93ab7d4c3e8c1b9554ce1190deb021fd2cd4c',
      '845e8f836a4cf64e9c03dab9d20bda0d3032d6b5ee7c2fa3014ef9d8f501faa8',
      'cp14nlnfqj98dr8reqs6g2clkf6kl2v86xph925ecgeph4sy87je4xqrl557f'
    ]
  ])(
    'purpose %i, index %i: t_i, Q_i, pk_i, sk_i and cp1<pk_i>, all round-tripping',
    (purpose, i, t, Q, pk, sk, cp1) => {
      const branch = branchOf()
      const branchXonly = branch.publicKey!.slice(1)
      // independent computation, not the kit's own internals
      const independent = tweakAndPoint(
        branchXonly,
        branch.chainCode!,
        purpose,
        i
      )
      expect(independent.tHex).toBe(t)
      expect(independent.QCompressedHex).toBe(Q)
      // x(Q_i) == pk_i
      expect(independent.QCompressedHex.slice(2)).toBe(pk)

      // the kit's own real functions
      const pubkey = deriveNotePubkey(
        branchXonly,
        branch.chainCode!,
        purpose,
        i
      )
      const secretKey = deriveNoteSecretKey(
        branch.privateKey!,
        branch.chainCode!,
        purpose,
        i
      )
      expect(bytesToHex(pubkey)).toBe(pk)
      expect(bytesToHex(secretKey)).toBe(sk)
      expect(encodeCp1(pubkey)).toBe(cp1)
      // x(sk_i·G) == pk_i - the round-trip the spec text calls out explicitly
      expect(bytesToHex(schnorr.getPublicKey(secretKey))).toBe(pk)
    }
  )
})

// ---- Test vector 2: Seed & derivation (branch root has even-y P) + LN
// address registration proof ----
describe('LUD-25 Test Vectors - vector 2 (Seed & derivation, even-y P) + registration proof', () => {
  // BIP-32's own "Test vector 2" seed
  const SEED = hexToBytes(
    'fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a29f9c999693908d8a8784817e7b7875726f6c696663605d5a5754514e4b484542'
  )
  const DOMAIN = 'cash.example.com'
  const master = () => HDKey.fromMasterSeed(SEED)
  const branchOf = () =>
    deriveDomainBranchNode(master().deriveChild(CASH_ROOT_PURPOSE), DOMAIN)

  it("cashHashingKey (m/139'/0) and the domain-material suffix (d1..d4)", () => {
    const cashRoot = master().deriveChild(CASH_ROOT_PURPOSE)
    const hashingNode = cashRoot.deriveChild(0)
    expect(bytesToHex(hashingNode.privateKey!)).toBe(
      '7d6d06012307b130432c5ab845fc746f72d4703a91981a6c012a420b83176dd8'
    )
    const suffix = lud05PathSuffix(hashingNode.privateKey!, DOMAIN)
    expect(suffix).toEqual([2886871684, 4226627351, 2748717696, 1002847463])
  })

  it("branch root (m/139'/d1/d2/d3/d4) - even-y P, and its cx1 export", () => {
    const branch = branchOf()
    expect(bytesToHex(branch.privateKey!)).toBe(
      '6f1d381ccdda9a69f966b492b19de687930c19b19e7f8d581088402d6a3b7818'
    )
    expect(bytesToHex(branch.publicKey!)).toBe(
      '0264885a9cab93ec051761b8a0b80e1854a61865878d58f72a365dfd640850f675'
    )
    // even-y: compressed prefix 0x02 - this branch exercises sk_i = p + t,
    // vector 1 exercises the other formula
    expect(branch.publicKey![0]).toBe(0x02)
    expect(bytesToHex(branch.chainCode!)).toBe(
      '6b95795f9807ada85c8ca50ec93c921483a183abfed4a3b4abe6b95c89880306'
    )
    const cx1 = encodeCx1(branch.publicKey!.slice(1), branch.chainCode!)
    expect(cx1).toBe(
      'cx1vjy9489tj0kq29mphzstsrsc2jnpsev834v0w23kth7kgzzs7e6kh9tet7vq0tdgtjx22rkf8jfpfqapsw4la49rkj47dw2u3xyqxpspgvxpa'
    )
  })

  it.each([
    [
      0,
      '3867f7253bf0d9b02bb522625e3ae902b2d46896c199a62ea64b97d4dc2ad230',
      '0201fee34e378bf66de6afa1bfa6e30f5c89551fd92bc1b089dca93c52b7ab61bc',
      '01fee34e378bf66de6afa1bfa6e30f5c89551fd92bc1b089dca93c52b7ab61bc',
      'a7852f4209cb741a251bd6f50fd8cf8a45e0824860193386b6d3d80246664a48',
      'cp1q8lwxn3h30mxme405xl6dcc0tjy4287e90qmpzwu4y799datvx7q0uv35q'
    ],
    [
      1,
      '82d50d21bffa50acf24a242b550df20925493cc425c9e25e28049d2824298e79',
      '037c5434c33d25bc24d98c35b2610dd484cb2a3d4a7854de354f7747e9b10597b8',
      '7c5434c33d25bc24d98c35b2610dd484cb2a3d4a7854de354f7747e9b10597b8',
      'f1f2453e8dd4eb16ebb0d8be06abd890b8555675c4496fb6388cdd558e650691',
      'cp1032rfseayk7zfkvvxkexzrw5sn9j50220p2dud20war7nvg9j7uqsksqqz'
    ],
    [
      2,
      'fcf834f455a2a184581dc705400bce64ac19dda82e17d8e77b50482cdce746c9',
      '032517f8221468e33cb7aafdffde313950446da0cf4d790c9b758b373dc67a5686',
      '2517f8221468e33cb7aafdffde313950446da0cf4d790c9b758b373dc67a5686',
      '6c156d11237d3bee51847b97f1a9b4ed84771a731d4ec603cc0629cd76ec7da0',
      'cp1y5tlsgs5dr3neda2lhlauvfe2pzxmgx0f4usexm43vmnm3n626rqslqkvr'
    ]
  ])(
    'purpose 0 (wallet), index %i: t_i, Q_i, pk_i, sk_i and cp1<pk_i>, all round-tripping',
    (i, t, Q, pk, sk, cp1) => {
      const branch = branchOf()
      const branchXonly = branch.publicKey!.slice(1)
      const independent = tweakAndPoint(
        branchXonly,
        branch.chainCode!,
        NOTE_PURPOSE_WALLET,
        i
      )
      expect(independent.tHex).toBe(t)
      expect(independent.QCompressedHex).toBe(Q)
      expect(independent.QCompressedHex.slice(2)).toBe(pk)

      const pubkey = deriveNotePubkey(
        branchXonly,
        branch.chainCode!,
        NOTE_PURPOSE_WALLET,
        i
      )
      const secretKey = deriveNoteSecretKey(
        branch.privateKey!,
        branch.chainCode!,
        NOTE_PURPOSE_WALLET,
        i
      )
      expect(bytesToHex(pubkey)).toBe(pk)
      expect(bytesToHex(secretKey)).toBe(sk)
      expect(encodeCp1(pubkey)).toBe(cp1)
      expect(bytesToHex(schnorr.getPublicKey(secretKey))).toBe(pk)
    }
  )

  const USERNAME = 'alice'
  const sk0 = () => {
    const branch = branchOf()
    return deriveNoteSecretKey(
      branch.privateKey!,
      branch.chainCode!,
      NOTE_PURPOSE_WALLET,
      0
    )
  }

  it('LN address registration proof - "register" over the purpose-0 sk_0 (signs sha256(message), domain-bound to this vector\'s own SERVICE domain)', () => {
    const digest = sha256(
      utf8ToBytes(`LNURLcash:register:${DOMAIN}:${USERNAME}`)
    )
    expect(bytesToHex(digest)).toBe(
      'be730f1fc4a81feea4bc0464d9f6adff04dfe652687e39cba30eac9caa73fcdd'
    )
    const sig = signAddressProof(sk0(), 'register', DOMAIN, USERNAME)
    expect(bytesToHex(sig)).toBe(
      '9169a81db3372d8bb8a080f271f8036192131d4ed02596c0baa181613fdc5d6e17b3230b01f510a759fdb6c46b53671e57678f57ac0a6a3deb6300761225adc7'
    )
  })

  it('LN address registration proof - "unregister" over the purpose-0 sk_0 (a different digest, never interchangeable with register)', () => {
    const digest = sha256(
      utf8ToBytes(`LNURLcash:unregister:${DOMAIN}:${USERNAME}`)
    )
    expect(bytesToHex(digest)).toBe(
      'dc12e80f7d0486fab791c743688e54bcc759111722d80dfa5fa70586a7d9d9d9'
    )
    const sig = signAddressProof(sk0(), 'unregister', DOMAIN, USERNAME)
    expect(bytesToHex(sig)).toBe(
      'fcc6a96f560d6505bfc475d8c2d4383047f2ece6593412af9b2834913af60f108b6e194cef31c377a23a051f8c80c1660efc2313b7876a2f80bc1f0f423c7835'
    )
  })

  it('LN address registration proof does not verify against a different SERVICE domain', () => {
    // the cross-mint replay this binding exists to close (luds#cx1-domain-
    // replay, 2026-09-18): a bare cx1 carries no proof of which domain's
    // hash it was derived under, so without `domain` folded into the signed
    // message a proof captured by one SERVICE would verify verbatim against
    // any other
    const sig = signAddressProof(sk0(), 'register', DOMAIN, USERNAME)
    const otherDigest = sha256(
      utf8ToBytes(`LNURLcash:register:mint.example:${USERNAME}`)
    )
    const pubkeyXOnly = deriveNotePubkey(
      branchOf().publicKey!.slice(1),
      branchOf().chainCode!,
      NOTE_PURPOSE_WALLET,
      0
    )
    expect(schnorr.verify(sig, otherDigest, pubkeyXOnly)).toBe(false)
  })
})

// ---- Test vector 3: Key-path spend (ck1) ----
describe('LUD-25 Test Vectors - vector 3 (ck1 key-path spend)', () => {
  // sk_0/pk_0 from vector 1's purpose 0 (wallet) above, spending Q = pk_0
  // at mint.example
  const SK = hexToBytes(
    '3616b02290a133da73e758a54dbff1bf6439b4067a820cb51ca873fa4a13a96a'
  )
  const PK = '690ac33892c64aa53874b0066ab1332f0ef45cb7c0e017eae0828916f52aa99f'
  const DOMAIN = 'mint.example'

  it('signs the canonical spend transaction sighash for its domain, deterministically (all-zero aux_rand)', () => {
    const sighash = keyPathSighash(hexToBytes(PK), DOMAIN)
    expect(bytesToHex(sighash)).toBe(
      'e97bb6831a916ff83919046f50a39c18ab98bf43079cf68cd364d251f7de527f'
    )
    const {pubkeyXOnly, signature} = signNoteOwnership(SK, DOMAIN)
    expect(bytesToHex(pubkeyXOnly)).toBe(PK)
    expect(bytesToHex(signature)).toBe(
      'fc3491f1c6bca73dcd76b38fc6b7a82aef0f1fa67212ceb7d7f64dbc41c8bfe77e0db6077624bf117badb65efe0445e382ac9f4cd582f7a5cc366c7aeb4580d4'
    )
    expect(schnorr.verify(signature, sighash, pubkeyXOnly)).toBe(true)
  })

  it('encodes as ck1<Q><sig> and verifies directly against the embedded Q - at its own domain only', () => {
    const {pubkeyXOnly, signature} = signNoteOwnership(SK, DOMAIN)
    const ck1 = encodeCk1(pubkeyXOnly, signature)
    expect(ck1).toBe(
      'ck1dy9vxwyjce922wr5kqrx4vfn9u80gh9hcrsp06hqs2y3daf24x0lcdy378rtefeae4mt8r7xk75z4mc0r7n8yykwkltlvndug8ytlem7pkmqwa3yhughhtdktmlqg30rs2kf7nx4stm6tnpkd3awk3vq6smm20wz'
    )
    const owner = recoverNoteOwnershipPubkey(ck1, DOMAIN)
    expect(owner && bytesToHex(owner.pubkeyXOnly)).toBe(PK)
    expect(recoverNoteOwnershipPubkey(ck1, 'cash.example.com')).toBeNull()
  })
})

// ---- Test vector 5: Bearer note ----
describe('LUD-25 Test Vectors - vector 5 (bearer note)', () => {
  const PREIMAGE =
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
  const Q = 'd18b619687343df2fc7a47e1daf25260b909bb563fb4b4b11e59e2bd64880982'
  const CW1 =
    'cw1qqqqqq8lllll7qpr4qsxxrwd99nvgvmxjyf9gj9mkfd5laqj5jw8xtdjez4urwzcr0t3phv8qqsuq5yjnd6vrgzf2jmckjmqxh5h5hs83fdq728vjm2500lwnt8gqwkqqqsqqqgzqvzq2ps8pqys5zcvp58q7yq3zgf3g9gkzuvpjxsmrsw3u8c6x6a4c'
  const CS1 =
    'cs10n1caxh3wxfa0g2zxj6lt90rlksv8dgemtavcj7dqymvfxa7683d268mawdsvygd0maru024z9ehtdv5fptumsr3t0v0vuv2x3e953557qq5c70z5'
  const MINT_PUBKEY =
    '035acdbd57663f858be6d61ec4bfcbc99492699010f1451e30a6550f26295e813d'

  it('the full cw1 is the spend its preimage short form stands for', () => {
    const {outputKey, controlBlock, leaf} = bearerNote(
      sha256(hexToBytes(PREIMAGE))
    )
    expect(bytesToHex(outputKey)).toBe(Q)
    expect(
      encodeCw1({
        locktime: 0,
        sequence: 0xffffffff,
        script: leaf,
        controlBlock,
        witness: [hexToBytes(PREIMAGE)]
      })
    ).toBe(CW1)
    expect(outputKeyOfCw1(CW1)).toBe(Q)
  })

  it("the mint's cs1 over Q verifies from either form of the spend", () => {
    expect(verifyNoteSignature(PREIMAGE, 1000, CS1, MINT_PUBKEY)).toBe(true)
    expect(verifyNoteSignature(CW1, 1000, CS1, MINT_PUBKEY)).toBe(true)
    expect(
      verifyNoteSignatureHash(
        bytesToHex(sha256(hexToBytes(PREIMAGE))),
        1000,
        CS1,
        MINT_PUBKEY
      )
    ).toBe(true)
    expect(verifyNoteSignature(PREIMAGE, 1001, CS1, MINT_PUBKEY)).toBe(false)
  })
})

// ---- Test vector 4: Offline verification (mint's cs1 certificate) ----
//
// SERVICE-side signing is deliberately NOT part of this kit's own public API
// (a WALLET only ever verifies a cs1, never produces one - only a mint
// does), so this test builds the certificate itself, directly per 25.md's
// own "Offline verification" formula, the same way an independent mint
// implementation would. verifyNoteSignatureHash below is the kit's real,
// shipped verifier - the actual cross-check this vector exists to make.
describe('LUD-25 Test Vectors - vector 4 (cs1 mint offline certificate)', () => {
  const LIGHTNING_SIGNED_MESSAGE_PREFIX = utf8ToBytes(
    'Lightning Signed Message:'
  )
  const SERVICE_SK = sha256(utf8ToBytes('LUD-25 test vector mint node'))
  const MINT_PUBKEY = bytesToHex(secp256k1.getPublicKey(SERVICE_SK, true))
  // pk_0 from vector 1's purpose 0 (wallet)
  const PK = '690ac33892c64aa53874b0066ab1332f0ef45cb7c0e017eae0828916f52aa99f'

  it('mintPubkey derived from the SERVICE signing key', () => {
    expect(MINT_PUBKEY).toBe(
      '035acdbd57663f858be6d61ec4bfcbc99492699010f1451e30a6550f26295e813d'
    )
  })

  const buildCs1 = (amountMsat: number) => {
    const message = utf8ToBytes(`LNURLcash:${amountMsat}:${PK}`)
    const digest = sha256(
      sha256(new Uint8Array([...LIGHTNING_SIGNED_MESSAGE_PREFIX, ...message]))
    )
    // RFC6979 deterministic k is @noble/curves' default; 'recovered' format
    // returns recovery-id || r || s (leading) - reordered to r || s ||
    // recovery-id (trailing) to match 25.md's own wire layout
    const leading = secp256k1.sign(digest, SERVICE_SK, {
      prehash: false,
      format: 'recovered'
    }) as Uint8Array
    const trailing = new Uint8Array([...leading.subarray(1), leading[0]!])
    return {
      digest,
      sig65: trailing,
      cs1: encodeCs1WithAmount(amountMsat, trailing)
    }
  }

  it('amount_msat = 1000: message, digest, signature and cs1<...>', () => {
    const {digest, sig65, cs1} = buildCs1(1000)
    expect(bytesToHex(digest)).toBe(
      '516ed4b15e18e8e23e6f7d36a8d7eb88505997b5b6ab537939d22127cf69594c'
    )
    expect(bytesToHex(sig65)).toBe(
      '30d2250a5a97e7aee8de9f0296cbe550f4c88dc2ef2004b9731009c7dcd2df4f4ddd974c04971d09d9f22a3ff0a7c9a249cc52673dc1ba6c5071815889be995100'
    )
    expect(cs1).toBe(
      'cs10n1xrfz2zj6jln6a6x7nupfdjl92r6v3rwzausqfwtnzqyu0hxjma85mhvhfszfw8gfm8ez50ls5ly6yjwv2fnnmsd6d3g8rq2c3xlfj5gqqstd9v'
    )
    // the kit's own real verifier, checked against this vector's own
    // mintPubkey - not a re-implementation, the actual shipped code
    // only the cs1 is a certificate; its bare 65 bytes are not
    expect(
      verifyNoteSignatureForKey(PK, 1000, bytesToHex(sig65), MINT_PUBKEY)
    ).toBe(false)
    expect(verifyNoteSignatureForKey(PK, 1000, cs1, MINT_PUBKEY)).toBe(true)
  })

  it('amount_msat = 21000000: message, digest, signature and cs1<...>', () => {
    const {digest, sig65, cs1} = buildCs1(21000000)
    expect(bytesToHex(digest)).toBe(
      '30d8b4219483353c7c9286dbf630070439712aaaf06460afa4eca93c4864eeaa'
    )
    expect(bytesToHex(sig65)).toBe(
      'cd0e543690ae62c1fa70279bd6d406733739803c361bce8ca633b935db59246a08db7f25ebf6da82a4b42ecc8baf9e97cf9213477a628910bd50a0d2092959b301'
    )
    expect(cs1).toBe(
      'cs210u1e589gd5s4e3vr7nsy7dad4qxwvmnnqpuxcduar9xxwuntk6ey34q3kmlyh4ldk5z5j6zanyt470f0nujzdrh5c5fzz74pgxjpy54nvcpd0rph6'
    )
    expect(
      verifyNoteSignatureForKey(PK, 21000000, bytesToHex(sig65), MINT_PUBKEY)
    ).toBe(false)
    expect(verifyNoteSignatureForKey(PK, 21000000, cs1, MINT_PUBKEY)).toBe(true)
  })

  it('a certificate for one amount does not verify against a different amount (message binds amount_msat)', () => {
    const {sig65} = buildCs1(1000)
    // the same signature relabelled with the other amount
    const relabelled = encodeCs1WithAmount(21000000, sig65)
    expect(
      verifyNoteSignatureForKey(PK, 21000000, relabelled, MINT_PUBKEY)
    ).toBe(false)
  })

  it('a certificate does not verify against a different pk (message binds pk)', () => {
    const {cs1} = buildCs1(1000)
    const otherPk =
      '3e76b56c1a90bc64c4bf594be91a3cb8861a150232da92705cff6ee3714bb384' // pk_1 from vector 1's purpose 0
    expect(verifyNoteSignatureForKey(otherPk, 1000, cs1, MINT_PUBKEY)).toBe(
      false
    )
  })
})
