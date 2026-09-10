import {describe, expect, it} from 'vitest'
import {secp256k1} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {verifyNoteSignature, verifyNoteSignatureHash, hashK1} from './signature'

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
