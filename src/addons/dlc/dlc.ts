// Discreet Log Contracts (DLCs) - a single-oracle enum event's "outcome
// point" and the attestation that turns exactly one of them into a usable
// key. No wallet access, no new script template: an outcome point IS just
// a 32-byte x-only pubkey, so it plugs directly into the sibling taproot
// addon's own `pk` template (<pubkey> CHECKSIG) - nothing here compiles
// Script itself. See the sibling `betlocker` addon for what locks a real
// note to one of these.
//
// The core idea (cross-checked against dlcspecs/Oracle.md,
// https://bitcoinops.org/en/topics/discreet-log-contracts/, and the
// original Tadge Dryja DLC paper): an oracle commits ahead of time to a
// nonce point R (alongside its long-term pubkey P). For a specific outcome
// message m, define
//
//   e = tagged_hash("BIP0340/challenge", R || P || m)
//   T = R + e·P                                    <- the "outcome point"
//
// A real BIP340 signature (R, s) for m satisfies s·G = T - i.e. s IS the
// discrete log of T. Nobody can compute s before the oracle actually signs
// m (that's the hard problem DLCs rely on); the instant the oracle attests
// to whichever outcome really happened, s becomes public and T's private
// key is now known to everyone who saw the attestation. Every OTHER
// possible outcome's point never gets signed, so its own discrete log is
// never revealed - not "trust the oracle", provably unspendable for as
// long as the discrete log problem holds.
//
// Statically imported, not lazy - see taproot.ts's own note on why every
// export here must stay SYNCHRONOUS (a live Text/Show binding never awaits).
import {schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'

// dlcspecs/Oracle.md's own tag for the message an attestation actually
// signs - NOT the raw outcome string. Cross-checked against the published
// spec text; not yet cross-checked against a real external oracle
// implementation's own test vectors (unlike ct1/cw1's own
// ct1Interop.test.ts, which has real Bitcoin Core on the other end) - if a
// real-world oracle's attestation ever fails to verify here, this constant
// is the first thing to re-check.
const ATTESTATION_TAG = 'DLC/oracle/attestation/v0'

const outcomeMessageHash = (outcome: string): Uint8Array =>
  schnorr.utils.taggedHash(ATTESTATION_TAG, utf8ToBytes(outcome))

const bytesToNumberBE = (bytes: Uint8Array): bigint =>
  BigInt(`0x${bytesToHex(bytes)}`)

const numberToBytesBE = (n: bigint, length: number): Uint8Array =>
  hexToBytes(n.toString(16).padStart(length * 2, '0'))

const CURVE_ORDER = schnorr.Point.CURVE().n

const parseHex32 = (hex: string, label: string): Uint8Array => {
  const trimmed = hex.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(trimmed)) {
    throw new Error(`${label} must be 32 bytes of hex.`)
  }
  return hexToBytes(trimmed)
}

export type OracleKeypair = {secretKeyHex: string; pubkeyHex: string}

// An oracle's long-term identity key and a per-event nonce are the exact
// same math (a random scalar and its x-only point) - two names for the one
// generator, kept as separate exports so a holder playing "be the oracle"
// in the playground below doesn't have to know a nonce IS a keypair under
// the hood.
export const generateOracleKeypair = (): OracleKeypair => {
  const secretKey = schnorr.utils.randomSecretKey()
  return {
    secretKeyHex: bytesToHex(secretKey),
    pubkeyHex: bytesToHex(schnorr.getPublicKey(secretKey))
  }
}
export const generateNonce = generateOracleKeypair

// T = R + e·P - the pubkey a specific outcome's leaf locks to, computable
// by anyone the instant the oracle PUBLISHES its announcement (P, R), long
// before the event resolves. Throws on malformed hex.
export const outcomePoint = (
  oraclePubkeyHex: string,
  nonceHex: string,
  outcome: string
): string => {
  const P = parseHex32(oraclePubkeyHex, 'Oracle pubkey')
  const R = parseHex32(nonceHex, 'Nonce')
  const e =
    bytesToNumberBE(
      schnorr.utils.taggedHash(
        'BIP0340/challenge',
        R,
        P,
        outcomeMessageHash(outcome)
      )
    ) % CURVE_ORDER
  const Rpoint = schnorr.utils.lift_x(bytesToNumberBE(R))
  const Ppoint = schnorr.utils.lift_x(bytesToNumberBE(P))
  const T = Rpoint.add(Ppoint.multiply(e))
  return bytesToHex(schnorr.utils.pointToBytes(T))
}

export type Attestation = {outcome: string; signatureHex: string}

// The oracle's own act: sign whichever outcome actually happened, with the
// SAME nonce secret whose public point it already announced as R. This is
// deliberately NOT @noble/curves' own schnorr.sign (which derives its own
// fresh nonce internally, per BIP340's default signing algorithm) - the
// entire DLC mechanism depends on reusing the pre-announced nonce, so an
// oracle library needs "sign with THIS exact nonce", the one real thing
// this module can't get from the vanilla BIP340 API. Implements BIP340's
// own signing algorithm by hand with an externally supplied nonce secret
// in place of its internal tagged-hash nonce derivation - same even-y
// parity correction (for both the signing key and the nonce) BIP340 itself
// requires, same pattern recoverableNotes.ts's own deriveNoteSecretKey
// already uses for the signing-key half.
export const attest = (
  oracleSecretKeyHex: string,
  nonceSecretHex: string,
  outcome: string
): Attestation => {
  const rawD = bytesToNumberBE(
    parseHex32(oracleSecretKeyHex, 'Oracle secret key')
  )
  const rawK = bytesToNumberBE(parseHex32(nonceSecretHex, 'Nonce secret'))

  const dPoint = schnorr.Point.BASE.multiply(rawD)
  const d = dPoint.y % 2n === 0n ? rawD : (CURVE_ORDER - rawD) % CURVE_ORDER
  const P = schnorr.utils.pointToBytes(dPoint)

  const kPoint = schnorr.Point.BASE.multiply(rawK)
  const k = kPoint.y % 2n === 0n ? rawK : (CURVE_ORDER - rawK) % CURVE_ORDER
  const R = schnorr.utils.pointToBytes(kPoint)

  const e =
    bytesToNumberBE(
      schnorr.utils.taggedHash(
        'BIP0340/challenge',
        R,
        P,
        outcomeMessageHash(outcome)
      )
    ) % CURVE_ORDER
  const s = (k + e * d) % CURVE_ORDER

  return {
    outcome,
    signatureHex: bytesToHex(R) + bytesToHex(numberToBytesBE(s, 32))
  }
}

// A real attestation is more than "a valid BIP340 signature over this
// outcome" - it must also use the SAME nonce the oracle already announced
// (R), or it isn't a signature over the pre-committed event at all, just
// some other valid-looking signature. Checks both. Never throws.
export const verifyAttestation = (
  oraclePubkeyHex: string,
  nonceHex: string,
  attestation: Attestation
): boolean => {
  try {
    const sig = hexToBytes(attestation.signatureHex)
    if (sig.length !== 64) return false
    const sigR = bytesToHex(sig.subarray(0, 32))
    if (sigR !== nonceHex.trim().toLowerCase()) return false
    return schnorr.verify(
      sig,
      outcomeMessageHash(attestation.outcome),
      parseHex32(oraclePubkeyHex, 'Oracle pubkey')
    )
  } catch {
    return false
  }
}

// The redeeming secret an attestation reveals - s, the last 32 bytes of
// the 64-byte (R, s) signature. This is a real private key: signing
// anything with it produces a valid signature under outcomePoint's own Q
// for the matching (oraclePubkeyHex, nonceHex, outcome) - see this
// addon's own test for the round trip. Throws on malformed hex.
export const attestationScalar = (signatureHex: string): string => {
  const sig = hexToBytes(signatureHex.trim().toLowerCase())
  if (sig.length !== 64) throw new Error('A signature must be 64 bytes of hex.')
  return bytesToHex(sig.subarray(32))
}
