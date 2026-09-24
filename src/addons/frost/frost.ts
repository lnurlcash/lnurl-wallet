// FROST (RFC 9591 - Flexible Round-Optimized Schnorr Threshold signatures)
// - a thin hex-in/hex-out wrapper around @noble/curves/abstract/frost.js's
// own `schnorr_FROST` ciphersuite (the noble ecosystem's own audited,
// spec-tested implementation - the same author/ecosystem this wallet
// already depends on for @noble/hashes, @noble/curves, and, via
// @scure/btc-signer, the sibling musig2 addon). Not hand-rolled: verified
// live against the real installed package before building this file at
// all (a genuine 2-of-3 trusted-dealer round AND a genuine no-dealer
// 3-round DKG, each followed by a real threshold signature that verifies
// as an ordinary schnorr.verify call).
//
// Genuinely different from the sibling musig2 addon, not just "MuSig2 with
// extra steps": MuSig2 is n-of-n - every key-aggregation participant must
// also sign every time. FROST is t-of-n - a fixed group of n shares, any t
// of them can sign, without the others ever being needed or even knowing a
// signature happened. That needs real Shamir secret sharing and Lagrange
// interpolation under the hood, which is exactly what schnorr_FROST
// already implements; this file never touches that math directly.
//
// Two ways to create a group's shares:
//   TRUSTED DEALER (dealerSetup) - one party generates everything in one
//   shot, playground-style, same posture as musig2.ts's own "every
//   participant local" mode. Simple, but that one party briefly computes
//   the WHOLE group secret before splitting and (in principle) discarding
//   it - a real, if momentary, trust assumption, same spirit as this
//   session's own oracle service being a named, singly-trusted party.
//   DKG (dkgRound1/dkgRound2/dkgRound3) - the real RFC 9591 Appendix-
//   adjacent distributed protocol: every participant generates their own
//   polynomial and verifiably shares it with every other one; NOBODY ever
//   holds the full group secret, not even briefly. Three real rounds,
//   each participant's own broadcast/response has to reach every other
//   participant out of band - this wallet's addon DSL has no live
//   transport of its own, so (same as musig2.ts's own staged flow for its
//   two rounds) each round is its own pure, JSON-safe step a manifest
//   drives by hand: generate this round's own broadcast, paste in what
//   arrived from everyone else, move to the next round.
//
// Signing (frostCommit/frostSignShare/frostVerifyShare/frostAggregate) is
// the SAME two-round shape regardless of which setup produced the shares
// - the library doesn't distinguish, and neither does this file.
//
// @noble/curves' own DKG state (DKG_Secret) and secret-share objects hold
// raw bigints and Uint8Arrays, not the plain JsonValues the addon DSL can
// pass between helper calls (see types.ts's own JsonValue) - toJsonSafe/
// fromJsonSafe below is a small, library-shape-agnostic round-trip
// encoder for exactly that gap, not a reimplementation of anything
// cryptographic.
import {schnorr_FROST, schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import type {
  DealerShares,
  DKG_Round1,
  DKG_Round2,
  DKG_Secret,
  FrostPublic,
  FrostSecret,
  GenNonce,
  Identifier,
  Key,
  NonceCommitments,
  Nonces,
  Signers
} from '@noble/curves/abstract/frost.js'

// ---- generic JSON-safe (de)serialization for the library's own bigint/
// Uint8Array-bearing objects - see this file's own top comment ----

type Json = string | number | boolean | null | Json[] | {[key: string]: Json}

const toJsonSafe = (value: unknown): Json => {
  if (typeof value === 'bigint') return {__bigint: value.toString()}
  if (value instanceof Uint8Array) return {__bytes: bytesToHex(value)}
  if (Array.isArray(value)) return value.map(toJsonSafe)
  if (value && typeof value === 'object') {
    const out: Record<string, Json> = {}
    for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v)
    return out
  }
  return value as Json
}

const fromJsonSafe = (value: Json): unknown => {
  if (Array.isArray(value)) return value.map(fromJsonSafe)
  if (value && typeof value === 'object') {
    if ('__bigint' in value) return BigInt(value.__bigint as string)
    if ('__bytes' in value) return hexToBytes(value.__bytes as string)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = fromJsonSafe(v)
    return out
  }
  return value
}

// a JSON-safe opaque blob - shown/copyable as text, never meant to be
// hand-edited (same "opaque bearer data" posture a cw1 string already has
// elsewhere in this wallet)
const toBlob = (value: unknown): string => JSON.stringify(toJsonSafe(value))
const fromBlob = <T>(text: unknown): T =>
  fromJsonSafe(JSON.parse(String(text ?? '{}'))) as T

const isPositiveInt = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n > 0

export const groupIdentifier = (n: unknown): Identifier =>
  schnorr_FROST.Identifier.fromNumber(Number(n))

// ---- trusted dealer (playground/one-shot) ----

export type DealerResult = {
  min: number
  max: number
  groupPubkeyHex: string
  // one opaque blob per participant (1-indexed identifier) - hand each
  // participant only THEIRS; the dealer itself should discard all of them
  // once distributed, same "forget the secret" posture Appendix C of the
  // spec itself calls for
  shareBlobs: string[]
  publicBlob: string
}

export const dealerSetup = (min: unknown, max: unknown): DealerResult => {
  const t = Number(min)
  const n = Number(max)
  if (!isPositiveInt(t) || !isPositiveInt(n) || t > n) {
    throw new Error(
      'Need a threshold (t) no greater than the group size (n), both at least 1.'
    )
  }
  if (t < 2)
    throw new Error('A threshold of 1 isn’t a threshold - use 2 or more.')
  const ids = Array.from({length: n}, (_, i) => groupIdentifier(i + 1))
  const deal: DealerShares = schnorr_FROST.trustedDealer({min: t, max: n}, ids)
  return {
    min: t,
    max: n,
    groupPubkeyHex: bytesToHex(deal.public.commitments[0]!).slice(2),
    shareBlobs: ids.map(id => toBlob(deal.secretShares[id])),
    publicBlob: toBlob(deal.public)
  }
}

// ---- DKG (real multi-party, no dealer) ----
//
// Every function below is a pure, re-enterable step - nothing hidden
// carries over between calls except what's explicitly threaded through as
// an opaque blob, same discipline musig2.ts's own staged flow already
// follows and for the same reason (Renderer.tsx can only pass JsonValues
// between helper calls).

export type DkgRound1Result = {
  // broadcast to every other participant, in the open - contains no secret
  broadcastBlob: string
  // THIS participant's own private state - never share, feed into round2
  secretBlob: string
}

export const dkgRound1 = (
  identityNumber: unknown,
  min: unknown,
  max: unknown
): DkgRound1Result => {
  const id = groupIdentifier(identityNumber)
  const signers: Signers = {min: Number(min), max: Number(max)}
  if (
    !isPositiveInt(signers.min) ||
    !isPositiveInt(signers.max) ||
    signers.min > signers.max
  ) {
    throw new Error('Need a threshold (t) no greater than the group size (n).')
  }
  const r1 = schnorr_FROST.DKG.round1(id, signers)
  return {broadcastBlob: toBlob(r1.public), secretBlob: toBlob(r1.secret)}
}

export type DkgRound2Result = {
  // one package PER RECIPIENT - hand recipient[i] ONLY packagesBlob[i],
  // never the others (each one is that recipient's own private share of
  // THIS participant's polynomial)
  recipientIds: string[]
  packageBlobs: string[]
  secretBlob: string
}

// othersRound1Blobs: every OTHER participant's own round1 broadcast
// (never include your own) - order doesn't matter, DKG.round2 matches by
// identifier, not position
export const dkgRound2 = (
  secretBlob: unknown,
  othersRound1Blobs: unknown
): DkgRound2Result => {
  const secret = fromBlob<DKG_Secret>(secretBlob)
  const others = (
    Array.isArray(othersRound1Blobs) ? othersRound1Blobs : []
  ).map(b => fromBlob<DKG_Round1>(b))
  const packages = schnorr_FROST.DKG.round2(secret, others)
  const recipientIds = Object.keys(packages)
  return {
    recipientIds,
    packageBlobs: recipientIds.map(id => toBlob(packages[id])),
    secretBlob: toBlob(secret)
  }
}

export type DkgFinalResult = {
  groupPubkeyHex: string
  keyBlob: string
}

// round1AllBlobs: every OTHER participant's own round1 broadcast (the
// SAME set passed into this participant's own round2 call - round3
// authenticates round2 packages against it). round2ForMeBlobs: the ONE
// package each other participant addressed to THIS identifier (their own
// round2 output, filtered to just this recipient).
export const dkgRound3 = (
  secretBlob: unknown,
  round1AllBlobs: unknown,
  round2ForMeBlobs: unknown
): DkgFinalResult => {
  const secret = fromBlob<DKG_Secret>(secretBlob)
  const round1 = (Array.isArray(round1AllBlobs) ? round1AllBlobs : []).map(b =>
    fromBlob<DKG_Round1>(b)
  )
  const round2 = (Array.isArray(round2ForMeBlobs) ? round2ForMeBlobs : []).map(
    b => fromBlob<DKG_Round2>(b)
  )
  const key: Key = schnorr_FROST.DKG.round3(secret, round1, round2)
  return {
    groupPubkeyHex: bytesToHex(key.public.commitments[0]!).slice(2),
    keyBlob: toBlob(key)
  }
}

// ---- signing (same shape regardless of dealer vs DKG setup) ----

export type FrostNonceResult = {
  // private - never share, feed into frostSignShare
  nonceBlob: string
  // public - broadcast to the coordinator/every other signer in this round
  commitmentBlob: string
}

export const frostCommit = (secretShareBlob: unknown): FrostNonceResult => {
  const secret = fromBlob<FrostSecret>(secretShareBlob)
  const gen: GenNonce = schnorr_FROST.commit(secret)
  return {
    nonceBlob: toBlob(gen.nonces),
    commitmentBlob: toBlob(gen.commitments)
  }
}

export const frostSignShare = (
  secretShareBlob: unknown,
  publicBlob: unknown,
  nonceBlob: unknown,
  commitmentBlobs: unknown,
  messageHex: unknown
): string => {
  const secret = fromBlob<FrostSecret>(secretShareBlob)
  const pub = fromBlob<FrostPublic>(publicBlob)
  const nonces = fromBlob<Nonces>(nonceBlob)
  const commitmentList = (
    Array.isArray(commitmentBlobs) ? commitmentBlobs : []
  ).map(b => fromBlob<NonceCommitments>(b))
  const msg = hexToBytes(String(messageHex ?? ''))
  return bytesToHex(
    schnorr_FROST.signShare(secret, pub, nonces, commitmentList, msg)
  )
}

export const frostVerifyShare = (
  publicBlob: unknown,
  commitmentBlobs: unknown,
  messageHex: unknown,
  identityNumber: unknown,
  shareHex: unknown
): boolean => {
  try {
    const pub = fromBlob<FrostPublic>(publicBlob)
    const commitmentList = (
      Array.isArray(commitmentBlobs) ? commitmentBlobs : []
    ).map(b => fromBlob<NonceCommitments>(b))
    const msg = hexToBytes(String(messageHex ?? ''))
    const id = groupIdentifier(identityNumber)
    return schnorr_FROST.verifyShare(
      pub,
      commitmentList,
      msg,
      id,
      hexToBytes(String(shareHex ?? ''))
    )
  } catch {
    return false
  }
}

export type FrostResult = {
  groupPubkeyHex: string
  finalSigHex: string
  verified: boolean
}

// identityNumbers/shareHexes must be the SAME length and order (signer i's
// identity pairs with share i) - the signers who actually participated in
// THIS round, which may be any t (or more) of the group's own n, not all
// of them
export const frostAggregate = (
  publicBlob: unknown,
  commitmentBlobs: unknown,
  messageHex: unknown,
  identityNumbers: unknown,
  shareHexes: unknown
): FrostResult => {
  const pub = fromBlob<FrostPublic>(publicBlob)
  const commitmentList = (
    Array.isArray(commitmentBlobs) ? commitmentBlobs : []
  ).map(b => fromBlob<NonceCommitments>(b))
  const msg = hexToBytes(String(messageHex ?? ''))
  const ids = Array.isArray(identityNumbers) ? identityNumbers : []
  const shares = Array.isArray(shareHexes) ? shareHexes : []
  if (ids.length !== shares.length || ids.length === 0) {
    throw new Error('Need a matching identity for every signature share.')
  }
  const sigShares: Record<Identifier, Uint8Array> = {}
  ids.forEach((n, i) => {
    sigShares[groupIdentifier(n)] = hexToBytes(String(shares[i]))
  })
  const finalSig = schnorr_FROST.aggregate(pub, commitmentList, msg, sigShares)
  const groupPubkeyHex = bytesToHex(pub.commitments[0]!).slice(2)
  return {
    groupPubkeyHex,
    finalSigHex: bytesToHex(finalSig),
    verified: schnorr.verify(finalSig, msg, hexToBytes(groupPubkeyHex))
  }
}

// UTF-8 convenience wrapper - the UI's free-text "message to sign" field
export const utf8MessageHex = (text: unknown): string =>
  bytesToHex(utf8ToBytes(String(text ?? '')))

// ---- NOT YET: taproot script-tree tweaking (a cp1 with a backup leaf) ----
//
// @noble/curves does ship frostTweakPublic/frostTweakSecret (BIP341
// tweaking for a FROST group), but ONLY via an export literally named
// __TEST in the installed version (2.4.0) - not the library's stable
// public API. That's a real, deliberate signal, not a naming accident:
// building a real feature on an internal test-only binding means it can
// change or disappear in a patch release with no warning, and - more to
// the point - tweaking a THRESHOLD group correctly (so the eventual
// signature is valid for the tweaked output key Q, not the untweaked
// group key P, regardless of which t of n participants actually sign) is
// exactly the kind of subtle math this session's own standard refuses to
// ship without independent, real verification. Left out of v1 rather than
// either quietly relying on __TEST or quietly downgrading scope without
// saying so - see this addon's own manifest.ts top comment.
