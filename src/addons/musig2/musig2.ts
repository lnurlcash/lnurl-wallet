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
  // absent means this participant is only known by their pubkey - pasted
  // in by hand rather than generated on this page - so this wallet has no
  // way to nonce or sign on their behalf (see the staged functions below)
  secretKeyHex?: string
  pubkeyHex: string // 33-byte compressed
  // this participant's own MuSig2 nonce pair for the CURRENT signing round
  // (see generateNonce) - secretHex only ever exists for a local
  // participant (nonceGen needs the secret key), never pasted in or sent
  // anywhere; publicHex is the one thing that has to leave this page for a
  // real external co-signer, and the one thing pasted in for one added here
  nonceSecretHex?: string
  pubNonceHex?: string
  // this participant's own partial signature for the current round -
  // computed locally (partialSign) for a participant this page holds the
  // secret key for, pasted in by hand for one that's pubkey-only
  partialSigHex?: string
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

// BIP341's own x-only tweak, threaded into key aggregation (and into every
// Session built from it) so a round's signature verifies under the TWEAKED
// output key Q = P + t·G rather than the untweaked aggregate P. This is
// what makes a MuSig2 group usable as a taproot INTERNAL key: lock a note
// to cp1<Q>, and the group can still key-path spend it, but only if every
// step of the round applies the same tweak - applying it afterwards is not
// possible, which is exactly why it has to be a parameter here rather than
// something a caller can bolt on later.
//
// `undefined` means no tweak at all - a plain MuSig2 round, byte-for-byte
// as before. BIP327's ApplyTweak takes a tweak list plus a matching
// per-tweak isXonly flag; a taproot output key is always x-only.
const tweakArgs = (tweakHex?: string): [Uint8Array[], boolean[]] =>
  tweakHex === undefined
    ? [[], []]
    : [[parseHex(tweakHex, 32, 'Tweak')], [true]]

// pure key-aggregation preview, no signing - lets the UI show the group
// pubkey as soon as 2+ participants exist, before a message is even typed.
// With `tweakHex`, previews the taproot output key Q instead of the bare
// aggregate P.
export const aggregatePubkeys = (
  pubkeysHex: string[],
  tweakHex?: string
): string => {
  if (pubkeysHex.length < 2) {
    throw new Error('Need at least 2 participants to aggregate.')
  }
  const pubkeys = pubkeysHex.map(hex => parseHex(hex, 33, 'Pubkey'))
  const agg = keyAggregate(pubkeys, ...tweakArgs(tweakHex))
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

// shared tail between the one-shot pipeline below and the staged
// combine step further down: given a completed Session and every
// participant's own (pubkey, public nonce, partial signature), aggregate
// the partial signatures into the final signature, verify it independently
// with @noble/curves, and check every individual partial signature against
// the session too, exactly the same way regardless of whether they were
// all just computed locally or partly pasted in from elsewhere.
const summarizeRound = (
  session: Session,
  pubkeys: Uint8Array[],
  pubNonces: Uint8Array[],
  partialSigs: Uint8Array[],
  message: Uint8Array,
  groupPubkey: Uint8Array
): Musig2Result => {
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

// the whole MuSig2 round for N LOCAL participants (every one of them
// generated on this page, so its secret key is in hand), in one shot:
// aggregate keys, generate fresh nonces, aggregate nonces, build a signing
// Session, have every participant partially sign (Session.sign
// self-verifies each one by default - a broken nonce/key throws right
// here), aggregate the partial signatures into one final BIP340 Schnorr
// signature, then verify it independently with @noble/curves - the same
// signature-verification code this wallet already uses everywhere else,
// since a MuSig2-aggregated signature is - by design - indistinguishable
// from a single signer's. A participant who is only a pasted-in pubkey
// can't go through this one-shot path at all (this page has no secret key
// to nonce or sign with) - see the staged functions below for that case.
//
// Takes the message as raw bytes, not text: aggregateAndSign below is the
// UTF-8-string convenience wrapper the UI's free-text "message to sign"
// field uses, but the ck1 worked example (manifest.ts) needs to sign a
// 32-byte digest instead - the LUD-25 key-path sighash a ck1 signs
// (src/lib/spend.ts's keyPathSighash) - which UTF-8-encoding a string could
// never produce.
export const aggregateAndSignBytes = (
  participants: Musig2Participant[],
  message: Uint8Array,
  tweakHex?: string
): Musig2Result => {
  if (participants.length < 2) {
    throw new Error('Need at least 2 participants to sign together.')
  }
  const secretKeys = participants.map(p => {
    if (!p.secretKeyHex) {
      throw new Error(
        'Every participant needs a secret key for a one-shot round - a pubkey-only participant needs the staged nonce/sign flow instead.'
      )
    }
    return parseHex(p.secretKeyHex, 32, 'Secret key')
  })
  const pubkeys = participants.map(p => parseHex(p.pubkeyHex, 33, 'Pubkey'))

  const [tweaks, isXonly] = tweakArgs(tweakHex)
  const agg = keyAggregate(pubkeys, tweaks, isXonly)
  const groupPubkey = keyAggExport(agg)

  const nonces = pubkeys.map((pubkey, i) =>
    nonceGen(pubkey, secretKeys[i], groupPubkey, message)
  )
  const pubNonces = nonces.map(n => n.public)
  const aggNonce = nonceAggregate(pubNonces)

  const session = new Session(aggNonce, pubkeys, message, tweaks, isXonly)
  const partialSigs = secretKeys.map((secretKey, i) =>
    session.sign(nonces[i]!.secret, secretKey)
  )

  return summarizeRound(
    session,
    pubkeys,
    pubNonces,
    partialSigs,
    message,
    groupPubkey
  )
}

// the UI's free-text "message to sign" field's own entry point - UTF-8
// encodes whatever was typed and delegates to aggregateAndSignBytes above
export const aggregateAndSign = (
  participants: Musig2Participant[],
  messageUtf8: string
): Musig2Result => aggregateAndSignBytes(participants, utf8ToBytes(messageUtf8))

// ---- staged signing ----
//
// aggregateAndSignBytes above only ever works when every participant's
// secret key lives on this same page - fine for "everyone's ephemeral keys
// were generated locally", but a participant who is only a pasted-in
// pubkey can't go through it at all (this page never has their secret
// key). The functions below decompose that same aggregate -> nonce -> sign
// -> combine -> verify pipeline into individually re-enterable, JSON-safe
// steps (see this file's own top comment on why the addon DSL can only
// pass hex strings/plain JsonValues between helper calls), so a manifest
// can drive a real, interactive BIP327 round instead: generate and show
// whatever a genuine outside co-signer needs at each stage (their required
// inputs are just this participant list's own public fields), and accept
// back whatever they compute on their end, pasted in as hex.
//
// Every step is a pure function of its own hex inputs - nothing hidden
// carries over between calls - so no Session/KeyAggregate object itself
// has to survive between addon helper calls; each step just rebuilds
// whichever one it needs from the same reconstructible pieces
// (aggregation and Session are both pure functions of an ORDERED pubkey
// list, so every step below takes that same list, in the same order, as
// aggregatePubkeys/aggregateAndSignBytes above already do).
export type Musig2Nonce = {secretHex: string; publicHex: string}

// one signer's own nonce pair for one signing round. SECURITY: never reuse
// the secret half across two rounds (nonceGen's own security note) - this
// page only ever calls it once per participant per "Generate nonces"
// click, right before that round's own signing step, same reasoning
// aggregateAndSignBytes's own top comment already documents.
export const generateNonce = (
  pubkeyHex: string,
  secretKeyHex: string,
  groupPubkeyHex: string,
  messageHex: string
): Musig2Nonce => {
  const nonce = nonceGen(
    parseHex(pubkeyHex, 33, 'Pubkey'),
    parseHex(secretKeyHex, 32, 'Secret key'),
    parseHex(groupPubkeyHex, 32, 'Group pubkey'),
    parseHex(messageHex, 32, 'Message')
  )
  return {
    secretHex: bytesToHex(nonce.secret),
    publicHex: bytesToHex(nonce.public)
  }
}

// combines every participant's public nonce - order must match the pubkey
// order used everywhere else in this round - into the one aggregate nonce
// a Session needs. This is the one value a genuine external co-signer
// needs back from this page before they can produce their own partial
// signature (alongside the pubkey list and message, both already visible).
export const aggregateNonces = (pubNoncesHex: string[]): string =>
  bytesToHex(
    nonceAggregate(pubNoncesHex.map(hex => parseHex(hex, 66, 'Public nonce')))
  )

// this signer's own partial signature, given the full session context
// (aggregate nonce, every participant's pubkey in order, and the message).
// Rebuilds the Session fresh rather than accepting one as an argument -
// cheap to reconstruct, and not JSON-safe to carry between addon helper
// calls anyway.
export const partialSign = (
  aggNonceHex: string,
  pubkeysHex: string[],
  messageHex: string,
  nonceSecretHex: string,
  secretKeyHex: string,
  tweakHex?: string
): string => {
  const session = new Session(
    parseHex(aggNonceHex, 66, 'Aggregate nonce'),
    pubkeysHex.map(hex => parseHex(hex, 33, 'Pubkey')),
    parseHex(messageHex, 32, 'Message'),
    ...tweakArgs(tweakHex)
  )
  return bytesToHex(
    session.sign(
      parseHex(nonceSecretHex, 97, 'Secret nonce'),
      parseHex(secretKeyHex, 32, 'Secret key')
    )
  )
}

// checks one already-collected partial signature (this page's own, or one
// pasted in from an external co-signer) against the same session context -
// lets a manifest flag a bad paste immediately, the same self-check
// Session.sign already runs on a locally-produced partial signature.
// Never throws: a not-yet-complete or malformed input reads as "not
// verified" rather than crashing a live preview.
export const verifyPartialSig = (
  aggNonceHex: string,
  pubkeysHex: string[],
  messageHex: string,
  pubNoncesHex: string[],
  partialSigHex: string,
  index: number,
  tweakHex?: string
): boolean => {
  try {
    const session = new Session(
      parseHex(aggNonceHex, 66, 'Aggregate nonce'),
      pubkeysHex.map(hex => parseHex(hex, 33, 'Pubkey')),
      parseHex(messageHex, 32, 'Message'),
      ...tweakArgs(tweakHex)
    )
    return session.partialSigVerify(
      parseHex(partialSigHex, 32, 'Partial signature'),
      pubNoncesHex.map(hex => parseHex(hex, 66, 'Public nonce')),
      index
    )
  } catch {
    return false
  }
}

// the staged round's own last step: every participant now has a pubkey, a
// public nonce, and a partial signature (computed locally, or pasted in
// from an external co-signer - by this point it makes no difference which)
// - aggregate the partial signatures into the final signature and build
// the same Musig2Result summary aggregateAndSignBytes's one-shot path
// produces, via the same shared tail (summarizeRound above).
export const combineStagedRound = (
  pubkeysHex: string[],
  pubNoncesHex: string[],
  partialSigsHex: string[],
  messageHex: string,
  tweakHex?: string
): Musig2Result => {
  if (pubkeysHex.length < 2) {
    throw new Error('Need at least 2 participants to sign together.')
  }
  const pubkeys = pubkeysHex.map(hex => parseHex(hex, 33, 'Pubkey'))
  const pubNonces = pubNoncesHex.map(hex => parseHex(hex, 66, 'Public nonce'))
  const partialSigs = partialSigsHex.map(hex =>
    parseHex(hex, 32, 'Partial signature')
  )
  const message = parseHex(messageHex, 32, 'Message')
  const [tweaks, isXonly] = tweakArgs(tweakHex)
  const groupPubkey = keyAggExport(keyAggregate(pubkeys, tweaks, isXonly))
  const aggNonce = nonceAggregate(pubNonces)
  const session = new Session(aggNonce, pubkeys, message, tweaks, isXonly)
  return summarizeRound(
    session,
    pubkeys,
    pubNonces,
    partialSigs,
    message,
    groupPubkey
  )
}
