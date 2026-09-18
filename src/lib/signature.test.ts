import {describe, expect, it} from 'vitest'
import {secp256k1, schnorr} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {bech32m} from '@scure/base'
import {
  verifyNoteSignature,
  verifyNoteSignatureHash,
  hashK1,
  signNoteOwnership,
  recoverNoteOwnershipPubkey,
  cp1FromCk1,
  signAddressProof
} from './signature'
import {
  encodeCk1,
  encodeCp1,
  encodeCs1,
  encodeCs1WithAmount
} from './recoverableNotes'

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
  return bytesToHex(new Uint8Array([...libSig.subarray(1), libSig[0]!]))
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

  it('verifies a cs1-encoded signature exactly the same as its hex form', () => {
    // SERVICE may disclose sig/sig2 as cs1<...> (bech32m) instead of plain
    // hex (see requireMutationSignature, which now preserves whichever
    // shape SERVICE actually sent rather than normalizing it away) -
    // verification must accept either transparently, dispatched by shape
    const priv = secp256k1.utils.randomSecretKey()
    const pubHex = bytesToHex(secp256k1.getPublicKey(priv, true))
    const amountMsat = 21000
    const sigHex = signAsMint(priv, K1, amountMsat)
    const sigCs1 = encodeCs1(hexToBytes(sigHex))

    expect(verifyNoteSignature(K1, amountMsat, sigCs1, pubHex)).toBe(true)
    expect(
      verifyNoteSignatureHash(hashK1(K1), amountMsat, sigCs1, pubHex)
    ).toBe(true)
    // still correctly rejects a cs1 signature that doesn't actually match
    const otherPub = bytesToHex(
      secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)
    )
    expect(verifyNoteSignature(K1, amountMsat, sigCs1, otherPub)).toBe(false)
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

  it('verifies a cs1-with-amount-encoded signature (25.md "encode amount in offline sig") exactly the same as its hex form', () => {
    // the CURRENT wire shape - amount folded into cs1's own HRP instead of
    // needing a separate `amount` alongside it (see recoverableNotes.ts's
    // encodeCs1WithAmount/decodeAnyCs1) - must verify identically to the
    // legacy cs1 test above, since the signed digest itself never changed,
    // only the wire encoding around it
    const priv = secp256k1.utils.randomSecretKey()
    const pubHex = bytesToHex(secp256k1.getPublicKey(priv, true))
    const amountMsat = 21000
    const sigHex = signAsMint(priv, K1, amountMsat)
    const sigCs1 = encodeCs1WithAmount(amountMsat, hexToBytes(sigHex))

    expect(verifyNoteSignature(K1, amountMsat, sigCs1, pubHex)).toBe(true)
    expect(
      verifyNoteSignatureHash(hashK1(K1), amountMsat, sigCs1, pubHex)
    ).toBe(true)
    const relabelled = encodeCs1WithAmount(amountMsat + 1, hexToBytes(sigHex))
    expect(verifyNoteSignature(K1, amountMsat, relabelled, pubHex)).toBe(false)
    expect(
      verifyNoteSignatureHash(hashK1(K1), amountMsat, relabelled, pubHex)
    ).toBe(false)
    const otherPub = bytesToHex(
      secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)
    )
    expect(verifyNoteSignature(K1, amountMsat, sigCs1, otherPub)).toBe(false)
  })
})

describe('signNoteOwnership (LUD-25 Part 2, ck1)', () => {
  // independently recomputes what signNoteOwnership signs - a plain
  // BIP-340 Schnorr signature over sha256("LNURLcash"), no Lightning-
  // signmessage digest wrapping - deliberately not importing any internal
  // helper, so this test would actually fail if the construction ever
  // silently drifted. Hashed rather than the raw 9-byte string because
  // most conforming Schnorr signers only accept a 32-byte message.
  const FIXED_DIGEST = sha256(utf8ToBytes('LNURLcash'))

  it("produces a (pubkey, signature) pair that verifies against the signer's own x-only pubkey", () => {
    const secretKey = schnorr.utils.randomSecretKey()
    const expectedPubkey = schnorr.getPublicKey(secretKey)
    const {pubkeyXOnly, signature} = signNoteOwnership(secretKey)
    expect(bytesToHex(pubkeyXOnly)).toBe(bytesToHex(expectedPubkey))
    expect(signature).toHaveLength(64)
    expect(schnorr.verify(signature, FIXED_DIGEST, pubkeyXOnly)).toBe(true)
  })

  it('produces a different signature for a different secret key', () => {
    const a = signNoteOwnership(schnorr.utils.randomSecretKey())
    const b = signNoteOwnership(schnorr.utils.randomSecretKey())
    expect(bytesToHex(a.pubkeyXOnly)).not.toBe(bytesToHex(b.pubkeyXOnly))
  })

  it('is deterministic (fixed aux_rand) for the same secret key - required so a rescan reproduces the same ck1', () => {
    const secretKey = schnorr.utils.randomSecretKey()
    expect(bytesToHex(signNoteOwnership(secretKey).signature)).toBe(
      bytesToHex(signNoteOwnership(secretKey).signature)
    )
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
    return bytesToHex(new Uint8Array([...libSig.subarray(1), libSig[0]!]))
  }

  it('verifies a cp1 note (k1=ck1<sig>) against its recovered pubkey', () => {
    const mintPriv = secp256k1.utils.randomSecretKey()
    const mintPubHex = bytesToHex(secp256k1.getPublicKey(mintPriv, true))
    const noteSecretKey = schnorr.utils.randomSecretKey()
    const notePubkeyHex = bytesToHex(schnorr.getPublicKey(noteSecretKey))
    const amountMsat = 21000
    const {pubkeyXOnly, signature} = signNoteOwnership(noteSecretKey)
    const ck1 = encodeCk1(pubkeyXOnly, signature)
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
  it('reads and verifies the exact pubkey a wallet-produced ck1 belongs to', () => {
    const secretKey = schnorr.utils.randomSecretKey()
    const {pubkeyXOnly, signature} = signNoteOwnership(secretKey)
    const ck1 = encodeCk1(pubkeyXOnly, signature)
    const owner = recoverNoteOwnershipPubkey(ck1)
    expect(owner?.legacy).toBe(false)
    expect(bytesToHex(owner!.pubkeyXOnly)).toBe(bytesToHex(pubkeyXOnly))
  })

  it('rejects a ck1 whose embedded pubkey does not match its signature', () => {
    const {signature} = signNoteOwnership(schnorr.utils.randomSecretKey())
    const wrongPubkey = schnorr.getPublicKey(schnorr.utils.randomSecretKey())
    const ck1 = encodeCk1(wrongPubkey, signature)
    expect(recoverNoteOwnershipPubkey(ck1)).toBeNull()
  })

  it('returns null for anything that is not a ck1, rather than throwing', () => {
    expect(recoverNoteOwnershipPubkey('not-a-ck1')).toBeNull()
    expect(recoverNoteOwnershipPubkey(K1)).toBeNull()
  })

  // TODO(deprecated): the OLD bare recoverable-ECDSA ck1 shape (no embedded
  // pubkey) still decodes via ecrecover, flagged legacy:true so a caller
  // (BearerCard.tsx) can warn the holder and prompt a rotate
  it('TODO(deprecated): still recovers a pubkey from the OLD recoverable-ECDSA ck1 shape', () => {
    const priv = secp256k1.utils.randomSecretKey()
    const expectedPubkey = secp256k1.getPublicKey(priv, true).subarray(1)
    const message = utf8ToBytes('LNURLcash')
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
    const legacySignature = new Uint8Array([...libSig.subarray(1), libSig[0]!])
    const legacyCk1 = bech32m.encode(
      'ck',
      bech32m.toWords(legacySignature),
      false
    )
    const owner = recoverNoteOwnershipPubkey(legacyCk1)
    expect(owner?.legacy).toBe(true)
    expect(bytesToHex(owner!.pubkeyXOnly)).toBe(bytesToHex(expectedPubkey))
  })

  // TODO(deprecated): a ck1 signed before the "32-byte hashed message"
  // change (2026-09-16, ../luds commit 6de59b2) - same current pk||sig
  // shape, but Sign(sk, "LNURLcash") over the raw 9-byte string instead of
  // Sign(sk, sha256("LNURLcash")). WALLET never produces this anymore
  // (signNoteOwnership always signs the digest); this only covers reading
  // an already-minted note back. Remove this test alongside the fallback
  // branch in recoverNoteOwnershipPubkey once no such notes are expected
  // to remain in the wild.
  it('TODO(deprecated): still recovers a pubkey from a ck1 signed over the OLD raw (un-hashed) message', () => {
    const secretKey = schnorr.utils.randomSecretKey()
    const pubkeyXOnly = schnorr.getPublicKey(secretKey)
    const rawMessageSignature = schnorr.sign(
      utf8ToBytes('LNURLcash'),
      secretKey,
      new Uint8Array(32)
    )
    const oldCk1 = encodeCk1(pubkeyXOnly, rawMessageSignature)
    const owner = recoverNoteOwnershipPubkey(oldCk1)
    expect(owner?.legacy).toBe(true)
    expect(bytesToHex(owner!.pubkeyXOnly)).toBe(bytesToHex(pubkeyXOnly))
  })

  it('prefers the current digest scheme when a signature happens to be ambiguous - a fresh signNoteOwnership output never falls into the legacy branch', () => {
    const secretKey = schnorr.utils.randomSecretKey()
    const {pubkeyXOnly, signature} = signNoteOwnership(secretKey)
    const ck1 = encodeCk1(pubkeyXOnly, signature)
    expect(recoverNoteOwnershipPubkey(ck1)?.legacy).toBe(false)
  })
})

describe('cp1FromCk1', () => {
  it('recovers the exact cp1 a ck1 secret belongs to, purely locally', () => {
    const secretKey = schnorr.utils.randomSecretKey()
    const {pubkeyXOnly, signature} = signNoteOwnership(secretKey)
    const ck1 = encodeCk1(pubkeyXOnly, signature)
    expect(cp1FromCk1(ck1)).toBe(encodeCp1(pubkeyXOnly))
  })

  it('returns null for anything that is not a ck1', () => {
    expect(cp1FromCk1('not-a-ck1')).toBeNull()
    expect(cp1FromCk1(K1)).toBeNull()
    expect(cp1FromCk1(encodeCp1(schnorr.utils.randomSecretKey()))).toBeNull()
  })
})

describe('signAddressProof (LUD-25 Part 2, un-/register)', () => {
  // independently recomputes the per-action/domain/username digest
  // signAddressProof signs - a plain BIP-340 Schnorr signature over
  // sha256(message), no Lightning-signmessage digest wrapping -
  // deliberately not importing any internal helper
  const digestFor = (
    action: 'register' | 'unregister',
    domain: string,
    username: string
  ) => sha256(utf8ToBytes(`LNURLcash:${action}:${domain}:${username}`))

  it("verifies against the branch key's own pubkey for the exact action/domain/username signed", () => {
    const secretKey = schnorr.utils.randomSecretKey()
    const pubkeyXOnly = schnorr.getPublicKey(secretKey)
    const sig = signAddressProof(secretKey, 'register', 'mint.example', 'alice')
    expect(sig).toHaveLength(64)
    expect(
      schnorr.verify(
        sig,
        digestFor('register', 'mint.example', 'alice'),
        pubkeyXOnly
      )
    ).toBe(true)
  })

  it('is domain-separated by action - a register proof does not verify as unregister', () => {
    const secretKey = schnorr.utils.randomSecretKey()
    const pubkeyXOnly = schnorr.getPublicKey(secretKey)
    const sig = signAddressProof(secretKey, 'register', 'mint.example', 'alice')
    expect(
      schnorr.verify(
        sig,
        digestFor('unregister', 'mint.example', 'alice'),
        pubkeyXOnly
      )
    ).toBe(false)
  })

  it('is domain-separated by username - a proof for one name does not verify for another', () => {
    const secretKey = schnorr.utils.randomSecretKey()
    const pubkeyXOnly = schnorr.getPublicKey(secretKey)
    const sig = signAddressProof(secretKey, 'register', 'mint.example', 'alice')
    expect(
      schnorr.verify(
        sig,
        digestFor('register', 'mint.example', 'bob'),
        pubkeyXOnly
      )
    ).toBe(false)
  })

  it('is domain-separated by domain - a proof for one SERVICE does not verify for another', () => {
    // the cross-mint replay this binding exists to close (luds#cx1-domain-
    // replay): a bare cx1 is otherwise fully portable, and any SERVICE that
    // ever legitimately received a proof from this wallet could otherwise
    // replay it verbatim against a different one's own /p/{username}
    const secretKey = schnorr.utils.randomSecretKey()
    const pubkeyXOnly = schnorr.getPublicKey(secretKey)
    const sig = signAddressProof(secretKey, 'register', 'mint.example', 'alice')
    expect(
      schnorr.verify(
        sig,
        digestFor('register', 'other-mint.example', 'alice'),
        pubkeyXOnly
      )
    ).toBe(false)
  })

  it('is deterministic for the same key/action/domain/username', () => {
    const secretKey = schnorr.utils.randomSecretKey()
    expect(
      bytesToHex(
        signAddressProof(secretKey, 'unregister', 'mint.example', 'alice')
      )
    ).toBe(
      bytesToHex(
        signAddressProof(secretKey, 'unregister', 'mint.example', 'alice')
      )
    )
  })
})
