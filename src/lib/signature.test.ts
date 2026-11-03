import {describe, expect, it} from 'vitest'
import {secp256k1, schnorr} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {bech32m} from '@scure/base'
import {
  ck1Pubkey,
  cp1FromCk1,
  hashK1,
  noteCertificateKind,
  recoverNoteOwnershipPubkey,
  signAddressProof,
  signNoteOwnership,
  verifyNoteSignature,
  verifyNoteSignatureHash
} from './signature'
import {bearerNoteIdOfPreimage, keyPathSighash} from './spend'

const DOMAIN = 'mint.example'
import {
  encodeCk1,
  encodeCp1,
  encodeCs1WithAmount,
  decodeCs1WithAmount
} from './recoverableNotes'

const K1 = 'a'.repeat(64)

// a mint's cs1 certificate for the bearer note K1 spends: the standard
// Lightning `signmessage` double-sha256 wrapping over
// "LNURLcash:<domain>:<amount_msat>:<hex(Q)>", encoded r || s || recovery-id
const signAsMint = (
  priv: Uint8Array,
  k1: string,
  amountMsat: number,
  // null: the superseded domain-less message, still read for stored notes
  domain: string | null = DOMAIN
): string => {
  const id = bearerNoteIdOfPreimage(k1)
  const message = utf8ToBytes(
    domain === null
      ? `LNURLcash:${amountMsat}:${id}`
      : `LNURLcash:${domain}:${amountMsat}:${id}`
  )
  const digest = sha256(
    sha256(
      new Uint8Array([...utf8ToBytes('Lightning Signed Message:'), ...message])
    )
  )
  // prehash:false: `digest` is already the final hash a real signer signs;
  // the library's 'recovered' format is recovery-id first, so reorder
  const libSig = secp256k1.sign(digest, priv, {
    format: 'recovered',
    prehash: false
  })
  return encodeCs1WithAmount(
    amountMsat,
    new Uint8Array([...libSig.subarray(1), libSig[0]!])
  )
}

describe('offline signature verification', () => {
  it('verifies a cs1 certificate over the note Q', () => {
    const priv = secp256k1.utils.randomSecretKey()
    const pubHex = bytesToHex(secp256k1.getPublicKey(priv, true))
    const amountMsat = 21000
    const cs1 = signAsMint(priv, K1, amountMsat)

    expect(verifyNoteSignature(K1, DOMAIN, amountMsat, cs1, pubHex)).toBe(true)
    expect(
      verifyNoteSignatureHash(hashK1(K1), DOMAIN, amountMsat, cs1, pubHex)
    ).toBe(true)
    expect(verifyNoteSignature(K1, DOMAIN, amountMsat + 1, cs1, pubHex)).toBe(
      false
    )
    expect(
      verifyNoteSignature('b'.repeat(64), DOMAIN, amountMsat, cs1, pubHex)
    ).toBe(false)
    const otherPub = bytesToHex(
      secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)
    )
    expect(verifyNoteSignature(K1, DOMAIN, amountMsat, cs1, otherPub)).toBe(
      false
    )
  })

  it("binds the certificate to the mint domain - another mint's is no certificate here", () => {
    const priv = secp256k1.utils.randomSecretKey()
    const pubHex = bytesToHex(secp256k1.getPublicKey(priv, true))
    const cs1 = signAsMint(priv, K1, 21000)
    expect(verifyNoteSignature(K1, 'other.example', 21000, cs1, pubHex)).toBe(
      false
    )
    // any URL of the mint names the same domain
    expect(
      verifyNoteSignature(K1, `https://${DOMAIN}:8443/w`, 21000, cs1, pubHex)
    ).toBe(true)
  })

  it('still reads a superseded domain-less certificate as legacy', () => {
    const priv = secp256k1.utils.randomSecretKey()
    const pubHex = bytesToHex(secp256k1.getPublicKey(priv, true))
    const legacy = signAsMint(priv, K1, 21000, null)
    const current = signAsMint(priv, K1, 21000)
    expect(verifyNoteSignature(K1, DOMAIN, 21000, legacy, pubHex)).toBe(true)
    expect(noteCertificateKind(K1, DOMAIN, 21000, legacy, pubHex)).toBe(
      'legacy'
    )
    expect(noteCertificateKind(K1, DOMAIN, 21000, current, pubHex)).toBe(
      'current'
    )
    expect(noteCertificateKind(K1, DOMAIN, 21001, current, pubHex)).toBe(null)
  })

  it('rejects a cs1 relabelled with a different amount', () => {
    const priv = secp256k1.utils.randomSecretKey()
    const pubHex = bytesToHex(secp256k1.getPublicKey(priv, true))
    const cs1 = signAsMint(priv, K1, 21000)
    const relabelled = encodeCs1WithAmount(
      21001,
      decodeCs1WithAmount(cs1)!.signature
    )
    expect(verifyNoteSignature(K1, DOMAIN, 21000, relabelled, pubHex)).toBe(
      false
    )
    expect(verifyNoteSignature(K1, DOMAIN, 21001, relabelled, pubHex)).toBe(
      false
    )
  })

  it('rejects a plain-hex signature: only a cs1 is a certificate', () => {
    const priv = secp256k1.utils.randomSecretKey()
    const pubHex = bytesToHex(secp256k1.getPublicKey(priv, true))
    const cs1 = signAsMint(priv, K1, 1000)
    const hex = bytesToHex(decodeCs1WithAmount(cs1)!.signature)
    expect(verifyNoteSignature(K1, DOMAIN, 1000, hex, pubHex)).toBe(false)
  })

  it('rejects garbage signatures without throwing', () => {
    expect(
      verifyNoteSignature(K1, DOMAIN, 1000, 'not-hex', 'ab'.repeat(33))
    ).toBe(false)
    expect(
      verifyNoteSignature(K1, DOMAIN, 1000, 'ab'.repeat(10), 'ab'.repeat(33))
    ).toBe(false)
  })

  it('rejects a malformed k1 without throwing', () => {
    // a stored note with a non-hex k1 must not crash the digest - "not
    // signed", never an exception escaping into render
    const priv = secp256k1.utils.randomSecretKey()
    const pubHex = bytesToHex(secp256k1.getPublicKey(priv, true))
    const cs1 = signAsMint(priv, K1, 1000)
    expect(verifyNoteSignature('zz', DOMAIN, 1000, cs1, pubHex)).toBe(false)
    expect(verifyNoteSignature('a'.repeat(63), DOMAIN, 1000, cs1, pubHex)).toBe(
      false
    )
  })
})

describe('signNoteOwnership (LUD-25 key-path spend, ck1)', () => {
  // what signNoteOwnership signs: a plain BIP-340 Schnorr signature over
  // the canonical spend transaction's key-path sighash for the note's mint
  // (spend.ts's keyPathSighash - itself pinned to 25.md's test vector 3 in
  // spend.test.ts), never a free-form message
  const sighashFor = (pubkeyXOnly: Uint8Array) =>
    keyPathSighash(pubkeyXOnly, DOMAIN)

  it("produces a (pubkey, signature) pair that verifies against the signer's own x-only pubkey", () => {
    const secretKey = schnorr.utils.randomSecretKey()
    const expectedPubkey = schnorr.getPublicKey(secretKey)
    const {pubkeyXOnly, signature} = signNoteOwnership(secretKey, DOMAIN)
    expect(bytesToHex(pubkeyXOnly)).toBe(bytesToHex(expectedPubkey))
    expect(signature).toHaveLength(64)
    expect(
      schnorr.verify(signature, sighashFor(pubkeyXOnly), pubkeyXOnly)
    ).toBe(true)
  })

  it('binds the signature to the mint: another domain gets another signature', () => {
    const secretKey = schnorr.utils.randomSecretKey()
    const here = signNoteOwnership(secretKey, DOMAIN)
    const there = signNoteOwnership(secretKey, 'other.example')
    expect(bytesToHex(here.signature)).not.toBe(bytesToHex(there.signature))
    // a note URL, a server URL and a bare host all name the same domain
    expect(
      bytesToHex(signNoteOwnership(secretKey, `lnurlw://${DOMAIN}/w`).signature)
    ).toBe(bytesToHex(here.signature))
  })

  it('produces a different signature for a different secret key', () => {
    const a = signNoteOwnership(schnorr.utils.randomSecretKey(), DOMAIN)
    const b = signNoteOwnership(schnorr.utils.randomSecretKey(), DOMAIN)
    expect(bytesToHex(a.pubkeyXOnly)).not.toBe(bytesToHex(b.pubkeyXOnly))
  })

  it('is deterministic (fixed aux_rand) for the same secret key - required so a rescan reproduces the same ck1', () => {
    const secretKey = schnorr.utils.randomSecretKey()
    expect(bytesToHex(signNoteOwnership(secretKey, DOMAIN).signature)).toBe(
      bytesToHex(signNoteOwnership(secretKey, DOMAIN).signature)
    )
  })
})

describe('verifyNoteSignature - LUD-25 ck1 dispatch', () => {
  // cs1's message is LNURLcash:<domain>:<amount>:<hex(pk)>, pk hex used directly, no
  // hashing - see mintRequest.test.ts's own signAsMintForId, same shape
  const signAsMintForId = (
    priv: Uint8Array,
    idHex: string,
    amountMsat: number
  ): string => {
    const message = utf8ToBytes(`LNURLcash:${DOMAIN}:${amountMsat}:${idHex}`)
    const digest = sha256(
      sha256(
        new Uint8Array([
          ...utf8ToBytes('Lightning Signed Message:'),
          ...message
        ])
      )
    )
    const libSig = secp256k1.sign(digest, priv, {
      format: 'recovered',
      prehash: false
    })
    return encodeCs1WithAmount(
      amountMsat,
      new Uint8Array([...libSig.subarray(1), libSig[0]!])
    )
  }

  it('verifies a cp1 note (k1=ck1<sig>) against its recovered pubkey', () => {
    const mintPriv = secp256k1.utils.randomSecretKey()
    const mintPubHex = bytesToHex(secp256k1.getPublicKey(mintPriv, true))
    const noteSecretKey = schnorr.utils.randomSecretKey()
    const notePubkeyHex = bytesToHex(schnorr.getPublicKey(noteSecretKey))
    const amountMsat = 21000
    const {pubkeyXOnly, signature} = signNoteOwnership(noteSecretKey, DOMAIN)
    const ck1 = encodeCk1(pubkeyXOnly, signature)
    const cs1Sig = signAsMintForId(mintPriv, notePubkeyHex, amountMsat)

    expect(
      verifyNoteSignature(ck1, DOMAIN, amountMsat, cs1Sig, mintPubHex)
    ).toBe(true)
    expect(
      verifyNoteSignature(ck1, DOMAIN, amountMsat + 1, cs1Sig, mintPubHex)
    ).toBe(false)
    const otherPub = bytesToHex(
      secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)
    )
    expect(verifyNoteSignature(ck1, DOMAIN, amountMsat, cs1Sig, otherPub)).toBe(
      false
    )
  })

  it('rejects a malformed ck1 without throwing', () => {
    expect(
      verifyNoteSignature(
        'ck1garbage',
        DOMAIN,
        1000,
        'ab'.repeat(65),
        'ab'.repeat(33)
      )
    ).toBe(false)
  })
})

describe('recoverNoteOwnershipPubkey', () => {
  it('reads and verifies the exact pubkey a wallet-produced ck1 belongs to', () => {
    const secretKey = schnorr.utils.randomSecretKey()
    const {pubkeyXOnly, signature} = signNoteOwnership(secretKey, DOMAIN)
    const ck1 = encodeCk1(pubkeyXOnly, signature)
    const owner = recoverNoteOwnershipPubkey(ck1, DOMAIN)
    expect(bytesToHex(owner!.pubkeyXOnly)).toBe(bytesToHex(pubkeyXOnly))
  })

  it('rejects a ck1 signed for another mint - a replay from elsewhere', () => {
    const secretKey = schnorr.utils.randomSecretKey()
    const {pubkeyXOnly, signature} = signNoteOwnership(
      secretKey,
      'other.example'
    )
    const ck1 = encodeCk1(pubkeyXOnly, signature)
    expect(recoverNoteOwnershipPubkey(ck1, DOMAIN)).toBeNull()
    // ...while its Q still decodes, for a lookup that needs no proof
    expect(bytesToHex(ck1Pubkey(ck1)!)).toBe(bytesToHex(pubkeyXOnly))
  })

  it('rejects a ck1 signed over a fixed message instead of the sighash', () => {
    const secretKey = schnorr.utils.randomSecretKey()
    const pubkeyXOnly = schnorr.getPublicKey(secretKey)
    for (const message of [
      sha256(utf8ToBytes('LNURLcash')),
      utf8ToBytes('LNURLcash')
    ]) {
      const oldCk1 = encodeCk1(
        pubkeyXOnly,
        schnorr.sign(message, secretKey, new Uint8Array(32))
      )
      expect(recoverNoteOwnershipPubkey(oldCk1, DOMAIN)).toBeNull()
    }
  })

  it('rejects a ck1 whose embedded pubkey does not match its signature', () => {
    const {signature} = signNoteOwnership(
      schnorr.utils.randomSecretKey(),
      DOMAIN
    )
    const wrongPubkey = schnorr.getPublicKey(schnorr.utils.randomSecretKey())
    const ck1 = encodeCk1(wrongPubkey, signature)
    expect(recoverNoteOwnershipPubkey(ck1, DOMAIN)).toBeNull()
  })

  it('returns null for anything that is not a ck1, rather than throwing', () => {
    expect(recoverNoteOwnershipPubkey('not-a-ck1', DOMAIN)).toBeNull()
    expect(recoverNoteOwnershipPubkey(K1, DOMAIN)).toBeNull()
  })

  it('rejects the pre-schnorr 65-byte ck1 shape', () => {
    const legacyCk1 = bech32m.encode(
      'ck',
      bech32m.toWords(new Uint8Array(65).fill(0xef)),
      false
    )
    expect(recoverNoteOwnershipPubkey(legacyCk1, DOMAIN)).toBeNull()
    expect(ck1Pubkey(legacyCk1)).toBeNull()
  })
})

describe('cp1FromCk1', () => {
  it('recovers the exact cp1 a ck1 secret belongs to, purely locally', () => {
    const secretKey = schnorr.utils.randomSecretKey()
    const {pubkeyXOnly, signature} = signNoteOwnership(secretKey, DOMAIN)
    const ck1 = encodeCk1(pubkeyXOnly, signature)
    expect(cp1FromCk1(ck1)).toBe(encodeCp1(pubkeyXOnly))
  })

  it('returns null for anything that is not a ck1', () => {
    expect(cp1FromCk1('not-a-ck1')).toBeNull()
    expect(cp1FromCk1(K1)).toBeNull()
    expect(cp1FromCk1(encodeCp1(schnorr.utils.randomSecretKey()))).toBeNull()
  })
})

describe('signAddressProof (LUD-26 register/update/unregister)', () => {
  // independently recomputes the digest signAddressProof signs - a plain
  // BIP-340 Schnorr signature by the share key over sha256(message), no
  // Lightning-signmessage wrapping - deliberately not importing any helper
  const CX1 = 'cx1' + 'q'.repeat(110)
  const digestFor = (
    action: 'register' | 'update' | 'unregister',
    domain: string,
    username: string,
    cx1?: string
  ) =>
    sha256(
      utf8ToBytes(
        action === 'unregister'
          ? `LNURLcash:unregister:${domain}:${username}`
          : `LNURLcash:${action}:${domain}:${username}:${cx1}`
      )
    )
  const keyPair = () => {
    const secretKey = schnorr.utils.randomSecretKey()
    return {secretKey, pubkeyXOnly: schnorr.getPublicKey(secretKey)}
  }

  it('verifies against the share key for the exact action/domain/username/cx1 signed', () => {
    const {secretKey, pubkeyXOnly} = keyPair()
    const sig = signAddressProof(secretKey, 'register', DOMAIN, 'alice', CX1)
    expect(sig).toHaveLength(64)
    expect(
      schnorr.verify(
        sig,
        digestFor('register', DOMAIN, 'alice', CX1),
        pubkeyXOnly
      )
    ).toBe(true)
    const un = signAddressProof(secretKey, 'unregister', DOMAIN, 'alice')
    expect(
      schnorr.verify(un, digestFor('unregister', DOMAIN, 'alice'), pubkeyXOnly)
    ).toBe(true)
  })

  it('signs the username lowercase and the domain without port', () => {
    const {secretKey, pubkeyXOnly} = keyPair()
    const sig = signAddressProof(
      secretKey,
      'update',
      `https://${DOMAIN}:8443`,
      'Alice',
      CX1
    )
    expect(
      schnorr.verify(
        sig,
        digestFor('update', DOMAIN, 'alice', CX1),
        pubkeyXOnly
      )
    ).toBe(true)
  })

  it('refuses a register or update proof without the cx1 it binds', () => {
    const {secretKey} = keyPair()
    expect(() =>
      signAddressProof(secretKey, 'register', DOMAIN, 'alice')
    ).toThrow()
    expect(() =>
      signAddressProof(secretKey, 'update', DOMAIN, 'alice')
    ).toThrow()
  })

  it('is separated by action, username, domain and cx1', () => {
    const {secretKey, pubkeyXOnly} = keyPair()
    const sig = signAddressProof(secretKey, 'register', DOMAIN, 'alice', CX1)
    for (const digest of [
      digestFor('update', DOMAIN, 'alice', CX1),
      digestFor('register', DOMAIN, 'bob', CX1),
      digestFor('register', 'other-mint.example', 'alice', CX1),
      digestFor('register', DOMAIN, 'alice', 'cx1' + 'p'.repeat(110))
    ]) {
      expect(schnorr.verify(sig, digest, pubkeyXOnly)).toBe(false)
    }
  })

  it('is deterministic for the same inputs', () => {
    const {secretKey} = keyPair()
    expect(
      bytesToHex(signAddressProof(secretKey, 'unregister', DOMAIN, 'alice'))
    ).toBe(
      bytesToHex(signAddressProof(secretKey, 'unregister', DOMAIN, 'alice'))
    )
  })
})
