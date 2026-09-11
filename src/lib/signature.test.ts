import {describe, expect, it} from 'vitest'
import {secp256k1, schnorr} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {
  verifyNoteSignature,
  verifyNoteSignatureHash,
  hashK1,
  signNoteOwnership,
  recoverNoteOwnershipPubkey,
  cp1FromCk1
} from './signature'
import {encodeCk1, encodeCp1} from './recoverableNotes'

const K1 = 'a'.repeat(64)

// signed the same way LUD-13 signs its auth seed phrase - the standard
// Lightning `signmessage` double-sha256 wrapping, over a message that
// embeds the amount as decimal ASCII (not binary) and sha256(k1) as hex
// (not raw bytes)
const signAsMint = (
  priv: Uint8Array,
  k1: string,
  amountMsat: number
): string => {
  const k1Hash = bytesToHex(sha256(hexToBytes(k1)))
  const message = utf8ToBytes(`LNURLcash:${amountMsat}:${k1Hash}`)
  const digest = sha256(
    sha256(
      new Uint8Array([...utf8ToBytes('Lightning Signed Message:'), ...message])
    )
  )
  // library's 'recovered' format is empirically recovery-id-first (rec ||
  // r || s) - the spec's wire format is r || s || recovery-id, so reorder.
  // prehash:false: `digest` is already the final hash a real signer
  // (lnd/cln's signmessage) signs directly - the default prehash:true
  // would hash it again, producing a signature nothing downstream (this
  // wallet's own verifyNoteSignature, or a real mint) could ever recover
  // against a real signer's key
  const libSig = secp256k1.sign(digest, priv, {
    format: 'recovered',
    prehash: false
  })
  return bytesToHex(new Uint8Array([...libSig.subarray(1), libSig[0]]))
}

describe('offline signature verification', () => {
  it('verifies a signature made per the LUD-25 Lightning-signmessage scheme', () => {
    const priv = secp256k1.utils.randomSecretKey()
    const pubHex = bytesToHex(secp256k1.getPublicKey(priv, true))
    const amountMsat = 21000
    const sigHex = signAsMint(priv, K1, amountMsat)

    expect(verifyNoteSignature(K1, amountMsat, sigHex, pubHex)).toBe(true)
    expect(
      verifyNoteSignatureHash(hashK1(K1), amountMsat, sigHex, pubHex)
    ).toBe(true)
    expect(verifyNoteSignature(K1, amountMsat + 1, sigHex, pubHex)).toBe(false)
    expect(
      verifyNoteSignature('b'.repeat(64), amountMsat, sigHex, pubHex)
    ).toBe(false)
    const otherPub = bytesToHex(
      secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)
    )
    expect(verifyNoteSignature(K1, amountMsat, sigHex, otherPub)).toBe(false)
  })

  it('also verifies the recovery-id-leading layout some mints still send', () => {
    // lnurl-mint used to forward its Lightning node's signmessage RPC
    // output unreordered (recovery-id || r || s) rather than the spec
    // text's r || s || recovery-id, and has since fixed that - kept here
    // as a real-world-interop regression guard in case another
    // implementation (or a not-yet-updated lnurl-mint) gets it wrong
    const priv = secp256k1.utils.randomSecretKey()
    const pubHex = bytesToHex(secp256k1.getPublicKey(priv, true))
    const amountMsat = 6000
    const k1Hash = bytesToHex(sha256(hexToBytes(K1)))
    const message = utf8ToBytes(`LNURLcash:${amountMsat}:${k1Hash}`)
    const digest = sha256(
      sha256(
        new Uint8Array([
          ...utf8ToBytes('Lightning Signed Message:'),
          ...message
        ])
      )
    )
    const leadingSigHex = bytesToHex(
      secp256k1.sign(digest, priv, {format: 'recovered', prehash: false})
    )
    expect(verifyNoteSignature(K1, amountMsat, leadingSigHex, pubHex)).toBe(
      true
    )
  })

  it('rejects garbage signatures without throwing', () => {
    expect(verifyNoteSignature(K1, 1000, 'not-hex', 'ab'.repeat(33))).toBe(
      false
    )
    // wrong length (not 65 bytes)
    expect(
      verifyNoteSignature(K1, 1000, 'ab'.repeat(10), 'ab'.repeat(33))
    ).toBe(false)
  })

  it('rejects a malformed k1 without throwing', () => {
    // a stored note with a non-hex k1 must not crash the digest - "not
    // signed", never an exception escaping into render
    const priv = secp256k1.utils.randomSecretKey()
    const pubHex = bytesToHex(secp256k1.getPublicKey(priv, true))
    const sigHex = signAsMint(priv, K1, 1000)
    expect(verifyNoteSignature('zz', 1000, sigHex, pubHex)).toBe(false)
    expect(verifyNoteSignature('a'.repeat(63), 1000, sigHex, pubHex)).toBe(
      false
    )
  })
})

describe('signNoteOwnership (LUD-25 Part 2, ck1)', () => {
  // independently recomputes the fixed digest signNoteOwnership signs -
  // deliberately not importing any internal helper, so this test would
  // actually fail if the digest construction ever silently drifted
  const fixedDigest = (): Uint8Array => {
    const message = utf8ToBytes('LNURLcash')
    return sha256(
      sha256(
        new Uint8Array([
          ...utf8ToBytes('Lightning Signed Message:'),
          ...message
        ])
      )
    )
  }

  it("produces a signature that recovers to the signer's own x-only pubkey", () => {
    const secretKey = schnorr.utils.randomSecretKey()
    const pubkeyXOnly = schnorr.getPublicKey(secretKey)
    const sig = signNoteOwnership(secretKey)
    expect(sig).toHaveLength(65)

    // sig is wire format (r||s||recid, trailing) - @noble/curves'
    // recoverPublicKey expects recid-leading for raw bytes (the same
    // reason verifyNoteSignatureDigest itself reorders before calling it),
    // so reorder back before recovering
    const recidLeading = new Uint8Array([sig[64]!, ...sig.subarray(0, 64)])
    const recovered = secp256k1.recoverPublicKey(recidLeading, fixedDigest(), {
      prehash: false
    })
    // recoverPublicKey gives a full compressed point - the x-only note id
    // is everything after the 02/03 prefix byte, same as the mint's own
    // recover_note_pubkey (PublicKey.format(compressed=True)[1:])
    expect(bytesToHex(recovered.subarray(1))).toBe(bytesToHex(pubkeyXOnly))
  })

  it('is deterministic for the same secret key', () => {
    const secretKey = schnorr.utils.randomSecretKey()
    expect(bytesToHex(signNoteOwnership(secretKey))).toBe(
      bytesToHex(signNoteOwnership(secretKey))
    )
  })

  it('produces a different signature for a different secret key', () => {
    const a = signNoteOwnership(schnorr.utils.randomSecretKey())
    const b = signNoteOwnership(schnorr.utils.randomSecretKey())
    expect(bytesToHex(a)).not.toBe(bytesToHex(b))
  })
})

describe('verifyNoteSignature - LUD-25 Part 2 ck1 dispatch', () => {
  // cs1's message is LNURLcash:<amount>:<hex(pk)>, pk hex used directly, no
  // hashing - see mintRequest.test.ts's own signAsMintForId, same shape
  const signAsMintForId = (
    priv: Uint8Array,
    idHex: string,
    amountMsat: number
  ): string => {
    const message = utf8ToBytes(`LNURLcash:${amountMsat}:${idHex}`)
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
    return bytesToHex(new Uint8Array([...libSig.subarray(1), libSig[0]]))
  }

  it('verifies a cp1 note (k1=ck1<sig>) against its recovered pubkey', () => {
    const mintPriv = secp256k1.utils.randomSecretKey()
    const mintPubHex = bytesToHex(secp256k1.getPublicKey(mintPriv, true))
    const noteSecretKey = schnorr.utils.randomSecretKey()
    const notePubkeyHex = bytesToHex(schnorr.getPublicKey(noteSecretKey))
    const amountMsat = 21000
    const ck1 = encodeCk1(signNoteOwnership(noteSecretKey))
    const cs1Sig = signAsMintForId(mintPriv, notePubkeyHex, amountMsat)

    expect(verifyNoteSignature(ck1, amountMsat, cs1Sig, mintPubHex)).toBe(true)
    expect(verifyNoteSignature(ck1, amountMsat + 1, cs1Sig, mintPubHex)).toBe(
      false
    )
    const otherPub = bytesToHex(
      secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)
    )
    expect(verifyNoteSignature(ck1, amountMsat, cs1Sig, otherPub)).toBe(false)
  })

  it('rejects a malformed ck1 without throwing', () => {
    expect(
      verifyNoteSignature('ck1garbage', 1000, 'ab'.repeat(65), 'ab'.repeat(33))
    ).toBe(false)
  })
})

describe('recoverNoteOwnershipPubkey', () => {
  it('recovers the exact pubkey a wallet-produced ck1 belongs to', () => {
    const secretKey = schnorr.utils.randomSecretKey()
    const pubkeyXOnly = schnorr.getPublicKey(secretKey)
    const sig = signNoteOwnership(secretKey)
    expect(bytesToHex(recoverNoteOwnershipPubkey(sig)!)).toBe(
      bytesToHex(pubkeyXOnly)
    )
  })

  it('returns null for a malformed signature rather than throwing', () => {
    expect(recoverNoteOwnershipPubkey(new Uint8Array(10))).toBeNull()
    expect(recoverNoteOwnershipPubkey(new Uint8Array(65))).toBeNull()
  })
})

describe('cp1FromCk1', () => {
  it('recovers the exact cp1 a ck1 secret belongs to, purely locally', () => {
    const secretKey = schnorr.utils.randomSecretKey()
    const pubkeyXOnly = schnorr.getPublicKey(secretKey)
    const ck1 = encodeCk1(signNoteOwnership(secretKey))
    expect(cp1FromCk1(ck1)).toBe(encodeCp1(pubkeyXOnly))
  })

  it('returns null for anything that is not a ck1', () => {
    expect(cp1FromCk1('not-a-ck1')).toBeNull()
    expect(cp1FromCk1(K1)).toBeNull()
    expect(cp1FromCk1(encodeCp1(schnorr.utils.randomSecretKey()))).toBeNull()
  })
})
