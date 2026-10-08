import {afterEach, describe, expect, it, vi} from 'vitest'
import {secp256k1} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, utf8ToBytes} from '@noble/hashes/utils.js'
import {
  decodeCr1WithAmount,
  decodeCs1WithAmount,
  encodeCr1WithAmount,
  encodeCs1WithAmount,
  isCr1WithAmount,
  isCs1WithAmount
} from './recoverableNotes'
import {
  mergeNotes,
  mergeNotesWithHash,
  rotateNote,
  rotateNoteWithHash,
  splitNoteWithHash
} from './request'
import {verifyNoteSignatureForKey, verifyRotationCertificate} from './signature'

// two real note keys: the pk_0 values specVectors.test.ts derives
const SPENT = 'aad3a0e36c083eb0d2d92ec0860977dc46d10c952f31830e6443b1faa1997634'
const NOTE = '01fee34e378bf66de6afa1bfa6e30f5c89551fd92bc1b089dca93c52b7ab61bc'

// a mint's cr1 for "spent became note": the standard Lightning
// `signmessage` double-sha256 wrapping over
// "LNURLcash:rotate:<amount_msat>:<hex(Q_spent)>:<hex(Q)>", r || s || recid
const certifyRotation = (
  priv: Uint8Array,
  spent: string,
  note: string,
  amountMsat: number
): string => {
  const digest = sha256(
    sha256(
      new Uint8Array([
        ...utf8ToBytes('Lightning Signed Message:'),
        ...utf8ToBytes(`LNURLcash:rotate:${amountMsat}:${spent}:${note}`)
      ])
    )
  )
  const sig = secp256k1.sign(digest, priv, {
    format: 'recovered',
    prehash: false
  })
  return encodeCr1WithAmount(
    amountMsat,
    new Uint8Array([...sig.subarray(1), sig[0]!])
  )
}

describe('cr1 (rotation certificate) encoding', () => {
  it('round-trips, with its amount in the human-readable part like a cs1', () => {
    const signature = new Uint8Array(65).fill(0xab)
    const cr1 = encodeCr1WithAmount(1000, signature)
    expect(cr1.startsWith('cr10n1')).toBe(true)
    expect(cr1.length).toBe(encodeCs1WithAmount(1000, signature).length)
    expect(decodeCr1WithAmount(cr1)).toEqual({amountMsat: 1000, signature})
    expect(isCr1WithAmount(cr1)).toBe(true)
    expect(decodeCr1WithAmount(` ${cr1.toUpperCase()} `)?.amountMsat).toBe(1000)
  })

  it('a cs1 and a cr1 never decode as each other', () => {
    const signature = new Uint8Array(65).fill(0xab)
    const cs1 = encodeCs1WithAmount(1000, signature)
    const cr1 = encodeCr1WithAmount(1000, signature)
    expect(decodeCr1WithAmount(cs1)).toBeNull()
    expect(decodeCs1WithAmount(cr1)).toBeNull()
    expect(isCs1WithAmount(cr1)).toBe(false)
    expect(isCr1WithAmount(cs1)).toBe(false)
  })

  it('rejects garbage, a wrong length and a flipped character', () => {
    expect(decodeCr1WithAmount('')).toBeNull()
    expect(decodeCr1WithAmount('cr1')).toBeNull()
    expect(decodeCr1WithAmount('not a certificate')).toBeNull()
    expect(() => encodeCr1WithAmount(1000, new Uint8Array(64))).toThrow()
    const cr1 = encodeCr1WithAmount(1000, new Uint8Array(65).fill(1))
    const flipped = cr1.slice(0, -1) + (cr1.endsWith('q') ? 'p' : 'q')
    expect(decodeCr1WithAmount(flipped)).toBeNull()
  })
})

describe('verifyRotationCertificate', () => {
  it("matches lnurl-mint's own test vector", () => {
    // tests/test_rotation_certificate.py::test_cr1_test_vector - the mint
    // key is sha256("LNURLcash rotation certificate test vector")
    const mintPubkey =
      '0305299ebc7d5301da5ff64350c558d2daf9933445e611574474024d10d30f826a'
    const cr1 =
      'cr10n18mcryqw3gk2v280y65mj74crdv5uplkef7yvsp8udd53nzjqz4w562tfhlhh4y3x78auk9fydgd7pshcc0xz6zvrurp7vljz937gquqp09cjwz'
    const cr1For21m =
      'cr210u1dsefe3qy79fwt4va8deha2drgln33dnkgat8n5fakzu3z27lusryhtn5zmy8jx9dqvzz8jwu7jgnn98g86e833k2n6249y3zpnqsntqpu0dlaz'
    expect(bytesToHex(decodeCr1WithAmount(cr1)!.signature)).toBe(
      '3ef03201d14594c51de4d5372f57036b29c0fed94f88c804fc6b69198a40155d4d2969bfef7a9226f1fbcb15246a1be0c2f8c3cc2d0983e0c3e67e422c7c807001'
    )
    expect(verifyRotationCertificate(SPENT, NOTE, 1000, cr1, mintPubkey)).toBe(
      true
    )
    expect(
      verifyRotationCertificate(SPENT, NOTE, 21_000_000, cr1For21m, mintPubkey)
    ).toBe(true)
    // the amount, the direction and both notes are signed
    expect(
      verifyRotationCertificate(SPENT, NOTE, 21_000_000, cr1, mintPubkey)
    ).toBe(false)
    expect(
      verifyRotationCertificate(SPENT, NOTE, 1000, cr1For21m, mintPubkey)
    ).toBe(false)
    expect(verifyRotationCertificate(NOTE, SPENT, 1000, cr1, mintPubkey)).toBe(
      false
    )
    expect(verifyRotationCertificate(SPENT, SPENT, 1000, cr1, mintPubkey)).toBe(
      false
    )
  })

  it('verifies only against the mint that signed it', () => {
    const priv = secp256k1.utils.randomSecretKey()
    const pub = bytesToHex(secp256k1.getPublicKey(priv, true))
    const other = bytesToHex(
      secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)
    )
    const cr1 = certifyRotation(priv, SPENT, NOTE, 5000)
    expect(verifyRotationCertificate(SPENT, NOTE, 5000, cr1, pub)).toBe(true)
    expect(verifyRotationCertificate(SPENT, NOTE, 5000, cr1, other)).toBe(false)
    // case and whitespace of the ids and the key don't matter
    expect(
      verifyRotationCertificate(
        ` ${SPENT.toUpperCase()} `,
        NOTE.toUpperCase(),
        5000,
        cr1,
        pub.toUpperCase()
      )
    ).toBe(true)
  })

  it('rejects a cr1 relabelled with a different amount', () => {
    const priv = secp256k1.utils.randomSecretKey()
    const pub = bytesToHex(secp256k1.getPublicKey(priv, true))
    const cr1 = certifyRotation(priv, SPENT, NOTE, 5000)
    const relabelled = encodeCr1WithAmount(
      5001,
      decodeCr1WithAmount(cr1)!.signature
    )
    expect(verifyRotationCertificate(SPENT, NOTE, 5000, relabelled, pub)).toBe(
      false
    )
    expect(verifyRotationCertificate(SPENT, NOTE, 5001, relabelled, pub)).toBe(
      false
    )
  })

  it('is never a note certificate, and a note certificate is never one', () => {
    const priv = secp256k1.utils.randomSecretKey()
    const pub = bytesToHex(secp256k1.getPublicKey(priv, true))
    const cr1 = certifyRotation(priv, SPENT, NOTE, 5000)
    const signature = decodeCr1WithAmount(cr1)!.signature
    // the same signature bytes under a cs1's prefix certify neither note
    const asCs1 = encodeCs1WithAmount(5000, signature)
    expect(verifyNoteSignatureForKey(NOTE, 5000, asCs1, pub)).toBe(false)
    expect(verifyNoteSignatureForKey(SPENT, 5000, asCs1, pub)).toBe(false)
    // and a cs1 handed in where a cr1 belongs is not a certificate at all
    expect(verifyRotationCertificate(SPENT, NOTE, 5000, asCs1, pub)).toBe(false)
  })

  it('rejects malformed input without throwing', () => {
    const pub = bytesToHex(
      secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)
    )
    const cr1 = encodeCr1WithAmount(5000, new Uint8Array(65).fill(7))
    expect(verifyRotationCertificate('zz', NOTE, 5000, cr1, pub)).toBe(false)
    expect(verifyRotationCertificate(SPENT, 'ab', 5000, cr1, pub)).toBe(false)
    expect(verifyRotationCertificate(SPENT, NOTE, 5000, 'nope', pub)).toBe(
      false
    )
    expect(verifyRotationCertificate(SPENT, NOTE, 5000, cr1, 'nope')).toBe(
      false
    )
    expect(verifyRotationCertificate(SPENT, NOTE, 5000, cr1, pub)).toBe(false)
  })
})

describe('rotateNoteWithHash: the rotation certificate SERVICE answers with', () => {
  const CALLBACK = 'https://mint.example.com/w/cb'
  const K1 = 'a'.repeat(64)
  const H = 'b'.repeat(64)
  const CS1 = encodeCs1WithAmount(1000, new Uint8Array(65).fill(0xab))
  const CR1 = encodeCr1WithAmount(1000, new Uint8Array(65).fill(0xcd))

  afterEach(() => vi.unstubAllGlobals())

  const answer = (body: Record<string, unknown>) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({json: async () => body}) as Response)
    )

  it('hands back `r` exactly as SERVICE sent it', async () => {
    answer({status: 'OK', c: CS1, r: CR1})
    expect(await rotateNoteWithHash(CALLBACK, K1, H)).toEqual({
      signature: CS1,
      rotation: CR1
    })
  })

  it('a SERVICE that issues none is no error - the field is simply absent', async () => {
    answer({status: 'OK', c: CS1})
    const result = await rotateNoteWithHash(CALLBACK, K1, H)
    expect(result).toEqual({signature: CS1})
    expect('rotation' in result).toBe(false)
  })

  it('drops a malformed `r` rather than failing a rotate that already landed', async () => {
    for (const r of ['nope', CS1, 42, null, 'ab'.repeat(65)]) {
      answer({status: 'OK', c: CS1, r})
      expect(await rotateNoteWithHash(CALLBACK, K1, H)).toEqual({
        signature: CS1
      })
    }
  })

  it('a split and a merge never report one, whatever SERVICE sends', async () => {
    answer({status: 'OK', c: CS1, c2: CS1, r: CR1})
    const split = await splitNoteWithHash(
      CALLBACK,
      [K1],
      400,
      H,
      'c'.repeat(64)
    )
    expect('rotation' in split).toBe(false)
    const merged = await mergeNotesWithHash(CALLBACK, [K1, 'd'.repeat(64)], H)
    expect('rotation' in merged).toBe(false)
  })

  it('rotateNote hands it on with the fresh secret; mergeNotes never has one', async () => {
    answer({status: 'OK', c: CS1, r: CR1})
    const rotated = await rotateNote(CALLBACK, K1)
    expect(rotated.rotation).toBe(CR1)
    expect(rotated.k1).toMatch(/^[0-9a-f]{64}$/)
    answer({status: 'OK', c: CS1})
    expect('rotation' in (await rotateNote(CALLBACK, K1))).toBe(false)
    answer({status: 'OK', c: CS1, r: CR1})
    expect(
      'rotation' in (await mergeNotes(CALLBACK, [K1, 'd'.repeat(64)]))
    ).toBe(false)
  })
})
