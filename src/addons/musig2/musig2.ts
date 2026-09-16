// MuSig2 (BIP327) - a thin hex-in/hex-out wrapper around
// @scure/btc-signer/musig2.js, which implements exactly the BIP327
// primitives (its own top comment links straight to the spec and
// reference code - not a "simplified"/approximate version). Statically
// imported and fully synchronous, same reasoning as taproot.ts's own top
// comment.
//
// The library's own types (KeyAggregate, Session) hold live secp256k1
// points and bigints - not JSON-safe, and the addon DSL can only pass
// plain JsonValues between helper calls (see addons/types.ts). Rather than
// inventing a serialize-every-intermediate-step wire format, the entire
// aggregate -> nonce -> sign -> combine -> verify pipeline runs inside ONE
// synchronous function (aggregateAndSign below) and only the final,
// already-hex summary crosses back into addon state - mirroring how
// seedGenerator's own keypairsForSeed hides its loop inside one helper
// rather than exposing per-iteration DSL calls.
//
// Nonces are generated fresh, per signer, INSIDE aggregateAndSign right
// before signing - never at participant-creation time - so a nonce can
// never be reused across two different "Aggregate & sign" clicks (BIP327's
// own security note: reusing a secret nonce across two signing sessions
// can leak the secret key).
import {
  IndividualPubkey,
  keyAggregate,
  keyAggExport,
  nonceGen,
  nonceAggregate,
  Session
} from '@scure/btc-signer/musig2.js'
import {randomPrivateKeyBytes} from '@scure/btc-signer/utils.js'
import {schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'

const parseHex = (
  hex: string,
  expectedBytes: number,
  label: string
): Uint8Array => {
  const trimmed = hex.trim().toLowerCase()
  if (!/^[0-9a-f]*$/.test(trimmed) || trimmed.length !== expectedBytes * 2) {
    throw new Error(`${label} must be ${expectedBytes * 2} hex characters.`)
  }
  return hexToBytes(trimmed)
}

export type Musig2Participant = {
  secretKeyHex: string
  pubkeyHex: string // 33-byte compressed
}

// generates a fresh random keypair entirely client-side - same ephemeral,
// never-touches-the-real-seed posture as taproot.ts's generateKeypair
export const newParticipant = (): Musig2Participant => {
  const secretKey = randomPrivateKeyBytes()
  return {
    secretKeyHex: bytesToHex(secretKey),
    pubkeyHex: bytesToHex(IndividualPubkey(secretKey))
  }
}

// pure key-aggregation preview, no signing - lets the UI show the group
// pubkey as soon as 2+ participants exist, before a message is even typed
export const aggregatePubkeys = (pubkeysHex: string[]): string => {
  if (pubkeysHex.length < 2) {
    throw new Error('Need at least 2 participants to aggregate.')
  }
  const pubkeys = pubkeysHex.map(hex => parseHex(hex, 33, 'Pubkey'))
  const agg = keyAggregate(pubkeys)
  return bytesToHex(keyAggExport(agg))
}

export type Musig2SignerResult = {
  pubkeyHex: string
  partialSigHex: string
  partialVerified: boolean
}

export type Musig2Result = {
  groupPubkeyHex: string
  finalSigHex: string
  verified: boolean // independent check: @noble/curves schnorr.verify against groupPubkeyHex
  signers: Musig2SignerResult[]
}

// the whole MuSig2 round for N local participants, in one shot: aggregate
// keys, generate fresh nonces, aggregate nonces, build a signing Session,
// have every participant partially sign (Session.sign self-verifies each
// one by default - a broken nonce/key throws right here), aggregate the
// partial signatures into one final BIP340 Schnorr signature, then verify
// it independently with @noble/curves - the same signature-verification
// code this wallet already uses everywhere else, since a MuSig2-aggregated
// signature is - by design - indistinguishable from a single signer's.
export const aggregateAndSign = (
  participants: Musig2Participant[],
  messageUtf8: string
): Musig2Result => {
  if (participants.length < 2) {
    throw new Error('Need at least 2 participants to sign together.')
  }
  const secretKeys = participants.map(p =>
    parseHex(p.secretKeyHex, 32, 'Secret key')
  )
  const pubkeys = participants.map(p => parseHex(p.pubkeyHex, 33, 'Pubkey'))
  const message = utf8ToBytes(messageUtf8)

  const agg = keyAggregate(pubkeys)
  const groupPubkey = keyAggExport(agg)

  const nonces = pubkeys.map((pubkey, i) =>
    nonceGen(pubkey, secretKeys[i], groupPubkey, message)
  )
  const pubNonces = nonces.map(n => n.public)
  const aggNonce = nonceAggregate(pubNonces)

  const session = new Session(aggNonce, pubkeys, message)
  const partialSigs = secretKeys.map((secretKey, i) =>
    session.sign(nonces[i]!.secret, secretKey)
  )
  const finalSig = session.partialSigAgg(partialSigs)

  const signers: Musig2SignerResult[] = pubkeys.map((pubkey, i) => ({
    pubkeyHex: bytesToHex(pubkey),
    partialSigHex: bytesToHex(partialSigs[i]!),
    partialVerified: session.partialSigVerify(partialSigs[i]!, pubNonces, i)
  }))

  return {
    groupPubkeyHex: bytesToHex(groupPubkey),
    finalSigHex: bytesToHex(finalSig),
    verified: schnorr.verify(finalSig, message, groupPubkey),
    signers
  }
}
