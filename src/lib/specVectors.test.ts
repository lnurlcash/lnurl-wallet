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
  encodeCs1WithAmount
} from './recoverableNotes'
import {
  signNoteOwnership,
  signAddressProof,
  recoverNoteOwnershipPubkey,
  verifyNoteSignatureHash
} from './signature'

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
  index: number
) => {
  const rawTaggedHash = schnorr.utils.taggedHash(
    NOTE_DERIVE_TAG,
    branchPubkeyXOnly,
    chainCode,
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
      0,
      '10054a4025dc5678a26e16087703ac1af6be92dab9cc20f10c5a5ae0ffbd057c',
      '02aad3a0e36c083eb0d2d92ec0860977dc46d10c952f31830e6443b1faa1997634',
      'aad3a0e36c083eb0d2d92ec0860977dc46d10c952f31830e6443b1faa1997634',
      '944a9631dbda27cf989e27df8be7317a5a9dfb517a6b71358d175f58dd2dc99f',
      'cp14tf6pcmvpqltp5ke9mqgvzthm3rdzry49uccxrnygwcl4gvewc6qh2fkky'
    ],
    [
      1,
      '08c401f6e9646a046291700ec99fa5181f46b241cb4667cd1aa7b86ed30fde19',
      '02f0c1ea9aede945b9cf84f3bf8df27ac65154a937e4d10cb8a5865df0583b1083',
      'f0c1ea9aede945b9cf84f3bf8df27ac65154a937e4d10cb8a5865df0583b1083',
      '8d094de89f623b5b58c181e5de832a7783261ab88be5b8119b64bce6b080a23c',
      'cp17rq74xhda9zmnnuy7wlcmun6ceg4f2fhungsew99sewlqkpmzzpsf28ex8'
    ],
    [
      2,
      'b17b1b45fb64a2d70009c968f965790e11a6b9879041eb9730fda21ca199181f',
      '03c1e51bc2b8ad1c6ecfe382fe201c322506e2783a2e4d3eae0da47fece2eab078',
      'c1e51bc2b8ad1c6ecfe382fe201c322506e2783a2e4d3eae0da47fece2eab078',
      '35c06737b162742df639db400e48fe6ebad74517a1989b9ff1e84807aed39b01',
      'cp1c8j3hs4c45wxanlrstlzq8pjy5rwy7p69exnatsd53l7ech2kpuqsypsv2'
    ],
    // deliberately not contiguous with the run above - i is a plain
    // ser32(i) encode of whatever index WALLET is on, see 25.md
    [
      5,
      '468c1cdcf8fe1194f33d2b4c543c9a6000423bddc9b8a83f17c3ace9b0796568',
      '02c2b6a6d230d3ca51cc680bf84948c416eab70109542a0cf4fd1fbebbd647891a',
      'c2b6a6d230d3ca51cc680bf84948c416eab70109542a0cf4fd1fbebbd647891a',
      'cad168ceaefbe2ebe96d3d2369201fbf6421a4548a57f8839880b1618dea298b',
      'cp1c2m2d53s6099rnrgp0uyjjxyzm4twqgf2s4qea8ar7lth4j83ydqcznzj6'
    ]
  ])(
    'note index %i: t_i, Q_i, pk_i, sk_i and cp1<pk_i>, all round-tripping',
    (i, t, Q, pk, sk, cp1) => {
      const branch = branchOf()
      const branchXonly = branch.publicKey!.slice(1)
      // independent computation, not the kit's own internals
      const independent = tweakAndPoint(branchXonly, branch.chainCode!, i)
      expect(independent.tHex).toBe(t)
      expect(independent.QCompressedHex).toBe(Q)
      // x(Q_i) == pk_i
      expect(independent.QCompressedHex.slice(2)).toBe(pk)

      // the kit's own real functions
      const pubkey = deriveNotePubkey(branchXonly, branch.chainCode!, i)
      const secretKey = deriveNoteSecretKey(
        branch.privateKey!,
        branch.chainCode!,
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
      '4d010c0ae5b4e0def5d0eb651d5e08de7fc36aef5703231480372b24688d2711',
      '0223bf26d94335b65e84b8383eb0a8baec8c32e2ebc561a204a386bb720b4cd130',
      '23bf26d94335b65e84b8383eb0a8baec8c32e2ebc561a204a386bb720b4cd130',
      'bc1e4427b38f7b48ef379ff7cefbef6612cf84a0f582b06c90bf6b51d2c89f29',
      'cp1ywljdk2rxkm9ap9c8qltp296ajxr9chtc4s6yp9rs6ahyz6v6ycqvtd8z5'
    ],
    [
      1,
      '370d05e7dca3f107e7ec061de1ea81a51f2a7f5756330317d1a662fdfd35f618',
      '03b1ab49e8ca397385ccb6d17d611bf8afc75390513bdcdfe3d760e0bb9860e0aa',
      'b1ab49e8ca397385ccb6d17d611bf8afc75390513bdcdfe3d760e0bb9860e0aa',
      'a62a3e04aa7e8b71e152bab09388682cb2369908f4b2906fe22ea32b67716e30',
      'cp1kx45n6x289ectn9k697kzxlc4lr48yz380wdlc7hvrsthxrquz4qtpysaz'
    ],
    [
      2,
      '3d978b10770f8566e6630d978f46a79cb2d237ab0f6168123154dc83c3dc1392',
      '039cf00b60589f863cedd2773b42341e6f5102d6bd23d04559a3103d50611b2ada',
      '9cf00b60589f863cedd2773b42341e6f5102d6bd23d04559a3103d50611b2ada',
      'acb4c32d44ea1fd0dfc9c22a40e48e2445de515cade0f56a41dd1cb12e178baa',
      'cp1nncqkczcn7rremwjwua5ydq7dags944ay0gy2kdrzq74qcgm9tdq37e4dd'
    ]
  ])(
    'note index %i: t_i, Q_i, pk_i, sk_i and cp1<pk_i>, all round-tripping',
    (i, t, Q, pk, sk, cp1) => {
      const branch = branchOf()
      const branchXonly = branch.publicKey!.slice(1)
      const independent = tweakAndPoint(branchXonly, branch.chainCode!, i)
      expect(independent.tHex).toBe(t)
      expect(independent.QCompressedHex).toBe(Q)
      expect(independent.QCompressedHex.slice(2)).toBe(pk)

      const pubkey = deriveNotePubkey(branchXonly, branch.chainCode!, i)
      const secretKey = deriveNoteSecretKey(
        branch.privateKey!,
        branch.chainCode!,
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
    return deriveNoteSecretKey(branch.privateKey!, branch.chainCode!, 0)
  }

  it('LN address registration proof - "register" over sk_0 (signs sha256(message), domain-bound to this vector\'s own SERVICE domain)', () => {
    const digest = sha256(
      utf8ToBytes(`LNURLcash:register:${DOMAIN}:${USERNAME}`)
    )
    expect(bytesToHex(digest)).toBe(
      'be730f1fc4a81feea4bc0464d9f6adff04dfe652687e39cba30eac9caa73fcdd'
    )
    const sig = signAddressProof(sk0(), 'register', DOMAIN, USERNAME)
    expect(bytesToHex(sig)).toBe(
      '9d96780fe55f602a9e238a4b2640a9f8ca939cacbbcde109cfd6ba94a6f9d46ff4aaf56ba1e4e72696f7c0e8833445bd194bd06155a133cf524eb587d52e8d22'
    )
  })

  it('LN address registration proof - "unregister" over sk_0 (a different digest, never interchangeable with register)', () => {
    const digest = sha256(
      utf8ToBytes(`LNURLcash:unregister:${DOMAIN}:${USERNAME}`)
    )
    expect(bytesToHex(digest)).toBe(
      'dc12e80f7d0486fab791c743688e54bcc759111722d80dfa5fa70586a7d9d9d9'
    )
    const sig = signAddressProof(sk0(), 'unregister', DOMAIN, USERNAME)
    expect(bytesToHex(sig)).toBe(
      '7250ab2403333eb5ed73f7a212ac4f35b58f426fe5c2acb8b2194a112881332bfbeebeba0bc4615bcf361bc125d5a4149ddbe4b6ea3b755b711fefd8bba58728'
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
      0
    )
    expect(schnorr.verify(sig, otherDigest, pubkeyXOnly)).toBe(false)
  })
})

// ---- Test vector 3: Wallet-side ownership proof (ck1) ----
describe('LUD-25 Test Vectors - vector 3 (ck1 wallet-side ownership proof)', () => {
  // sk_0/pk_0 from vector 1 above
  const SK = hexToBytes(
    '944a9631dbda27cf989e27df8be7317a5a9dfb517a6b71358d175f58dd2dc99f'
  )
  const PK = 'aad3a0e36c083eb0d2d92ec0860977dc46d10c952f31830e6443b1faa1997634'

  it('signs sha256("LNURLcash") - a 32-byte digest, not the raw 9-byte string - with a deterministic (all-zero aux_rand) BIP-340 signature', () => {
    const digest = sha256(utf8ToBytes('LNURLcash'))
    expect(bytesToHex(digest)).toBe(
      '49a9bb7cae28a0c1f77bc7fac7693456b1cc149f83c413acfd938dc95ea21cf5'
    )
    const {pubkeyXOnly, signature} = signNoteOwnership(SK)
    expect(bytesToHex(pubkeyXOnly)).toBe(PK)
    expect(bytesToHex(signature)).toBe(
      'a83def8861b558c6f04ed877e5e8dcdf675c871f5c4b3383c1723b2329658a40451002bda2a824be84284147eff3f572968504c2f44a6629d6de8cfbd4e3960a'
    )
    expect(schnorr.verify(signature, digest, pubkeyXOnly)).toBe(true)
  })

  it('encodes as ck1<pk><sig> and verifies directly against the embedded pk, no recovery', () => {
    const {pubkeyXOnly, signature} = signNoteOwnership(SK)
    const ck1 = encodeCk1(pubkeyXOnly, signature)
    expect(ck1).toBe(
      'ck14tf6pcmvpqltp5ke9mqgvzthm3rdzry49uccxrnygwcl4gvewc62s0003psm2kxx7p8dsal9arwd7e6usu04cjens0qhywer99jc5sz9zqptmg4gyjlgg2zpglhl8atjj6zsfsh5ffnzn4k73naafcukpgdezzqx'
    )
    const owner = recoverNoteOwnershipPubkey(ck1)
    expect(owner?.legacy).toBe(false)
    expect(owner && bytesToHex(owner.pubkeyXOnly)).toBe(PK)
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
  // pk_0 from vector 1
  const PK = 'aad3a0e36c083eb0d2d92ec0860977dc46d10c952f31830e6443b1faa1997634'

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
      '30894ad113df18b1e00a27015ed62e8b94a87498c8da7997ddac48e4cd7bb20f'
    )
    expect(bytesToHex(sig65)).toBe(
      '41a69c2e826555b1c5c099b3166e8d50cc3bbba3ccb9b87c377e96ae070d532c3b6230194ae97d322d663fb38266abd26f3553c62a7d5a528ce9c72d3838fffc01'
    )
    expect(cs1).toBe(
      'cs10n1gxnfct5zv42mr3wqnxe3vm5d2rxrhwarejumslph06t2upcd2vkrkc3sr99wjlfj94nrlvuzv64ayme420rz5l2622xwn3ed8qu0llqpeg9n5x'
    )
    // the kit's own real verifier, checked against this vector's own
    // mintPubkey - not a re-implementation, the actual shipped code
    expect(
      verifyNoteSignatureHash(PK, 1000, bytesToHex(sig65), MINT_PUBKEY)
    ).toBe(true)
    expect(verifyNoteSignatureHash(PK, 1000, cs1, MINT_PUBKEY)).toBe(true)
  })

  it('amount_msat = 21000000: message, digest, signature and cs1<...>', () => {
    const {digest, sig65, cs1} = buildCs1(21000000)
    expect(bytesToHex(digest)).toBe(
      '6186fd2c1c258a6c0a3627e895efbc3d0988325c4f36f0050b52b4c4751ab13d'
    )
    expect(bytesToHex(sig65)).toBe(
      'b5c6c3dd151708501bc8820ae00ef3d6439cdcca8bac00fb2675fee6b89a7767079e37f62c2502c6744a56295c459d52c0475e27a0eb34745790b44c54b9386200'
    )
    expect(cs1).toBe(
      'cs210u1khrv8hg4zuy9qx7gsg9wqrhn6epeehx23wkqp7exwhlwdwy6wans083h7ckz2qkxw399v22ugkw49sz8tcn6p6e5w3tepdzv2junscsqwvvr03'
    )
    expect(
      verifyNoteSignatureHash(PK, 21000000, bytesToHex(sig65), MINT_PUBKEY)
    ).toBe(true)
    expect(verifyNoteSignatureHash(PK, 21000000, cs1, MINT_PUBKEY)).toBe(true)
  })

  it('a certificate for one amount does not verify against a different amount (message binds amount_msat)', () => {
    const {sig65} = buildCs1(1000)
    expect(
      verifyNoteSignatureHash(PK, 21000000, bytesToHex(sig65), MINT_PUBKEY)
    ).toBe(false)
  })

  it('a certificate does not verify against a different pk (message binds pk)', () => {
    const {sig65} = buildCs1(1000)
    const otherPk =
      'f0c1ea9aede945b9cf84f3bf8df27ac65154a937e4d10cb8a5865df0583b1083' // pk_1 from vector 1
    expect(
      verifyNoteSignatureHash(otherPk, 1000, bytesToHex(sig65), MINT_PUBKEY)
    ).toBe(false)
  })
})
