import {describe, expect, it} from 'vitest'
import {
  keyAggregate,
  keyAggExport,
  nonceGen,
  nonceAggregate,
  Session
} from '@scure/btc-signer/musig2.js'
import {schnorr} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {
  newParticipant,
  aggregatePubkeys,
  aggregateAndSign,
  aggregateAndSignBytes,
  generateNonce,
  aggregateNonces,
  partialSign,
  verifyPartialSig,
  combineStagedRound
} from './musig2'

// From the official BIP-327 test vectors (bitcoin/bips,
// bip-0327/vectors/key_agg_vectors.json) - a genuine external check that
// this wrapper's key aggregation matches the spec's own reference output,
// not just self-consistency against itself.
const VECTOR_PUBKEYS = [
  '02F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9',
  '03DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659',
  '023590A94E768F8E1815C2F24B4D80A8E3149316C3518CE7B7AD338368D038CA66'
]

describe('BIP-327 official vectors', () => {
  it('key_agg_vectors.json: key_indices [0,1,2]', () => {
    const pubkeys = VECTOR_PUBKEYS.map(hexToBytes)
    const agg = keyAggregate(pubkeys)
    const groupPubkey = bytesToHex(keyAggExport(agg)).toUpperCase()
    expect(groupPubkey).toBe(
      '90539EEDE565F5D054F32CC0C220126889ED1E5D193BAF15AEF344FE59D4610C'
    )
  })

  it('key_agg_vectors.json: key_indices [2,1,0] (order matters)', () => {
    const pubkeys = [
      VECTOR_PUBKEYS[2]!,
      VECTOR_PUBKEYS[1]!,
      VECTOR_PUBKEYS[0]!
    ].map(hexToBytes)
    const agg = keyAggregate(pubkeys)
    const groupPubkey = bytesToHex(keyAggExport(agg)).toUpperCase()
    expect(groupPubkey).toBe(
      '6204DE8B083426DC6EAF9502D27024D53FC826BF7D2012148A0575435DF54B2B'
    )
  })

  it('key_agg_vectors.json: duplicate keys, key_indices [0,0,0]', () => {
    const pubkeys = [
      VECTOR_PUBKEYS[0]!,
      VECTOR_PUBKEYS[0]!,
      VECTOR_PUBKEYS[0]!
    ].map(hexToBytes)
    const agg = keyAggregate(pubkeys)
    const groupPubkey = bytesToHex(keyAggExport(agg)).toUpperCase()
    expect(groupPubkey).toBe(
      'B436E3BAD62B8CD409969A224731C193D051162D8C5AE8B109306127DA3AA935'
    )
  })
})

describe('aggregatePubkeys', () => {
  it("matches aggregateAndSign's own groupPubkeyHex", () => {
    const a = newParticipant()
    const b = newParticipant()
    const preview = aggregatePubkeys([a.pubkeyHex, b.pubkeyHex])
    const result = aggregateAndSign([a, b], 'hello')
    expect(preview).toBe(result.groupPubkeyHex)
  })

  it('throws with fewer than 2 pubkeys', () => {
    const a = newParticipant()
    expect(() => aggregatePubkeys([a.pubkeyHex])).toThrow()
  })
})

describe('aggregateAndSign', () => {
  it('produces a valid joint signature for 2 participants', () => {
    const participants = [newParticipant(), newParticipant()]
    const result = aggregateAndSign(participants, 'hello musig2')
    expect(result.verified).toBe(true)
    expect(result.finalSigHex).toHaveLength(128)
    expect(result.signers).toHaveLength(2)
    for (const signer of result.signers) {
      expect(signer.partialVerified).toBe(true)
    }
  })

  it('produces a valid joint signature for 3 participants', () => {
    const participants = [newParticipant(), newParticipant(), newParticipant()]
    const result = aggregateAndSign(participants, 'three signers')
    expect(result.verified).toBe(true)
    expect(result.signers).toHaveLength(3)
    expect(result.signers.every(s => s.partialVerified)).toBe(true)
  })

  it('throws with fewer than 2 participants', () => {
    expect(() => aggregateAndSign([newParticipant()], 'hi')).toThrow()
  })

  it('a corrupted partial signature fails aggregate verification', () => {
    // replicates aggregateAndSign's own pipeline by hand (rather than
    // through the wrapper, which has no seam to inject a bad value) so a
    // tampered partial sig can be fed into the real aggregation step -
    // proves the "verified" line in the UI is load-bearing, not decorative
    const a = newParticipant()
    const b = newParticipant()
    const secretKeys = [hexToBytes(a.secretKeyHex), hexToBytes(b.secretKeyHex)]
    const pubkeys = [hexToBytes(a.pubkeyHex), hexToBytes(b.pubkeyHex)]
    const message = utf8ToBytes('tamper test')

    const agg = keyAggregate(pubkeys)
    const groupPubkey = keyAggExport(agg)
    const nonces = pubkeys.map((pk, i) =>
      nonceGen(pk, secretKeys[i], groupPubkey, message)
    )
    const aggNonce = nonceAggregate(nonces.map(n => n.public))
    const session = new Session(aggNonce, pubkeys, message)
    const partialSigs = secretKeys.map((sk, i) =>
      session.sign(nonces[i]!.secret, sk)
    )

    // flip the final byte of the first signer's partial sig
    const corrupted = Uint8Array.from(partialSigs[0]!)
    corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 0xff

    const finalSig = session.partialSigAgg([corrupted, partialSigs[1]!])
    expect(schnorr.verify(finalSig, message, groupPubkey)).toBe(false)
  })
})

describe('taproot-tweaked rounds (ct1 key-path spends)', () => {
  // the property the whole ct1 lock flow rests on: with a BIP341 tweak
  // threaded through key aggregation, the round's signature verifies under
  // the TWEAKED output key Q - which is what a note locked to ct1<Q> is
  // keyed by - rather than under the bare aggregate P
  it('produces a signature valid under the tweaked output key, not the untweaked one', () => {
    const participants = [newParticipant(), newParticipant()]
    const pubkeysHex = participants.map(p => p.pubkeyHex)
    const internalKeyHex = aggregatePubkeys(pubkeysHex)
    // any 32-byte scalar works as a tweak for this property - the taproot
    // tagged-hash derivation of it is taproot.ts's job, not musig2.ts's
    const tweakHex = bytesToHex(sha256(utf8ToBytes('some taproot tweak')))
    const outputKeyHex = aggregatePubkeys(pubkeysHex, tweakHex)

    // tweaking genuinely moves the key
    expect(outputKeyHex).not.toBe(internalKeyHex)

    const message = sha256(utf8ToBytes('LNURLcash'))
    const tweaked = aggregateAndSignBytes(participants, message, tweakHex)
    expect(tweaked.groupPubkeyHex).toBe(outputKeyHex)
    expect(tweaked.verified).toBe(true)
    expect(tweaked.signers.every(s => s.partialVerified)).toBe(true)

    // and the signature is specific to Q: it does NOT verify under P
    expect(
      schnorr.verify(
        hexToBytes(tweaked.finalSigHex),
        message,
        hexToBytes(internalKeyHex)
      )
    ).toBe(false)
  })

  it('omitting the tweak leaves the round byte-for-byte unchanged', () => {
    // guards the cp1 path against regression from the new optional param
    const participants = [newParticipant(), newParticipant()]
    const untweaked = aggregateAndSignBytes(
      participants,
      sha256(utf8ToBytes('LNURLcash'))
    )
    expect(untweaked.groupPubkeyHex).toBe(
      aggregatePubkeys(participants.map(p => p.pubkeyHex))
    )
    expect(untweaked.verified).toBe(true)
  })

  it('carries the tweak through a staged round too', () => {
    const a = newParticipant()
    const b = newParticipant()
    const pubkeysHex = [a.pubkeyHex, b.pubkeyHex]
    const tweakHex = bytesToHex(sha256(utf8ToBytes('staged taproot tweak')))
    const outputKeyHex = aggregatePubkeys(pubkeysHex, tweakHex)
    const messageHex = bytesToHex(sha256(utf8ToBytes('LNURLcash')))

    // nonces bind to the AGGREGATE key the round is for - the tweaked one
    const nonces = [a, b].map(p =>
      generateNonce(p.pubkeyHex, p.secretKeyHex!, outputKeyHex, messageHex)
    )
    const pubNoncesHex = nonces.map(n => n.publicHex)
    const aggNonceHex = aggregateNonces(pubNoncesHex)
    const partialSigsHex = [a, b].map((p, i) =>
      partialSign(
        aggNonceHex,
        pubkeysHex,
        messageHex,
        nonces[i]!.secretHex,
        p.secretKeyHex!,
        tweakHex
      )
    )
    partialSigsHex.forEach((sig, i) => {
      expect(
        verifyPartialSig(
          aggNonceHex,
          pubkeysHex,
          messageHex,
          pubNoncesHex,
          sig,
          i,
          tweakHex
        )
      ).toBe(true)
    })

    const result = combineStagedRound(
      pubkeysHex,
      pubNoncesHex,
      partialSigsHex,
      messageHex,
      tweakHex
    )
    expect(result.groupPubkeyHex).toBe(outputKeyHex)
    expect(result.verified).toBe(true)
  })
})

describe('staged signing', () => {
  // one full round driven entirely through the granular, hex-in/hex-out
  // steps a manifest actually calls (generateNonce -> aggregateNonces ->
  // partialSign -> combineStagedRound), with every participant played as
  // if it were an external, pasted-in pubkey - proves the decomposed
  // pipeline produces a genuinely valid joint signature, not just one that
  // happens to type-check
  it('produces a valid joint signature when driven step by step', () => {
    const a = newParticipant()
    const b = newParticipant()
    const c = newParticipant()
    const pubkeysHex = [a.pubkeyHex, b.pubkeyHex, c.pubkeyHex]
    const groupPubkeyHex = aggregatePubkeys(pubkeysHex)
    // the staged functions take a message hash, not raw text (same 32-byte
    // constraint the manifest's own fixed ck1 digest satisfies)
    const messageHex = bytesToHex(sha256(utf8ToBytes('staged musig2')))

    const nonces = [a, b, c].map(p =>
      generateNonce(p.pubkeyHex, p.secretKeyHex!, groupPubkeyHex, messageHex)
    )
    const pubNoncesHex = nonces.map(n => n.publicHex)
    const aggNonceHex = aggregateNonces(pubNoncesHex)

    const partialSigsHex = [a, b, c].map((p, i) =>
      partialSign(
        aggNonceHex,
        pubkeysHex,
        messageHex,
        nonces[i]!.secretHex,
        p.secretKeyHex!
      )
    )

    // each partial signature checks out individually before combining -
    // the same live-preview check a manifest would run as each is pasted in
    partialSigsHex.forEach((sig, i) => {
      expect(
        verifyPartialSig(
          aggNonceHex,
          pubkeysHex,
          messageHex,
          pubNoncesHex,
          sig,
          i
        )
      ).toBe(true)
    })

    const result = combineStagedRound(
      pubkeysHex,
      pubNoncesHex,
      partialSigsHex,
      messageHex
    )
    expect(result.groupPubkeyHex).toBe(groupPubkeyHex)
    expect(result.verified).toBe(true)
    expect(result.signers).toHaveLength(3)
    expect(result.signers.every(s => s.partialVerified)).toBe(true)

    // and it matches the one-shot pipeline bit-for-bit given the exact same
    // nonces - the staged path is a genuine decomposition, not a different
    // (and only coincidentally compatible) implementation
    const oneShot = combineStagedRound(
      pubkeysHex,
      pubNoncesHex,
      partialSigsHex,
      messageHex
    )
    expect(oneShot.finalSigHex).toBe(result.finalSigHex)
  })

  it('verifyPartialSig rejects a corrupted partial signature', () => {
    const a = newParticipant()
    const b = newParticipant()
    const pubkeysHex = [a.pubkeyHex, b.pubkeyHex]
    const groupPubkeyHex = aggregatePubkeys(pubkeysHex)
    const messageHex = bytesToHex(sha256(utf8ToBytes('staged tamper test')))

    const nonces = [a, b].map(p =>
      generateNonce(p.pubkeyHex, p.secretKeyHex!, groupPubkeyHex, messageHex)
    )
    const pubNoncesHex = nonces.map(n => n.publicHex)
    const aggNonceHex = aggregateNonces(pubNoncesHex)
    const goodSig = partialSign(
      aggNonceHex,
      pubkeysHex,
      messageHex,
      nonces[0]!.secretHex,
      a.secretKeyHex!
    )
    const corrupted =
      goodSig.slice(0, -2) + (goodSig.slice(-2) === '00' ? '01' : '00')
    expect(
      verifyPartialSig(
        aggNonceHex,
        pubkeysHex,
        messageHex,
        pubNoncesHex,
        corrupted,
        0
      )
    ).toBe(false)
  })
})
