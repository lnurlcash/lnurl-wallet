// LUD-25 "Part 2: Recoverable signatures" - pure protocol math, no wallet
// dependency (same principle as the rest of src/lib - see its README).
// Covers the two pieces every Part-2-aware peer (wallet or SERVICE)
// computes the same way regardless of how either side happens to derive
// its own keys:
//
//   1. bech32m (BIP-350, NOT the classic bech32/BIP-173 this repo's own
//      LUD-01 lnurl encoding in urls.ts uses) codecs for the 4 new fixed-
//      length value types: cp1 (a note's pubkey commitment), ck1 (a
//      recoverable ownership signature - the note's actual bearer secret),
//      cs1 (a SERVICE issuance certificate), cx1 (a watch-only branch
//      export: pubkey + chain code).
//   2. The non-hardened, taproot-style per-note key tweak a watch-only cx1
//      branch derives pk_i from - this is NOT standard BIP32 child
//      derivation (which hashes differently and needs HMAC-SHA512); it's
//      the exact scheme lnurl-mint's own derivation.py implements, and
//      must match byte-for-byte or a note minted to this wallet's branch
//      would be unfindable (see recoverableNotes.test.ts's cross-checked
//      vectors, generated from that actual mint code, not just internal
//      self-consistency).
import {bech32m} from '@scure/base'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {schnorr} from '@noble/curves/secp256k1.js'
import {encodeBolt11AmountSuffix, decodeBolt11AmountSuffix} from './bolt11'

// ---- bech32m codec ----

// no length limit is meaningful here - every payload's exact byte length
// is already pinned per-type below, so `false` (no cap) is simpler and
// more honest than picking an arbitrary generous number the way urls.ts's
// LUD-01 encoding does (that one has no fixed payload length to pin
// instead). This is also why @scure/base's own higher-level
// encodeFromBytes/decodeToBytes helpers aren't used - they hardcode
// BIP-173's ~90-char default limit, which ck1/cs1 (65 bytes) exceed.
const encodeFixed = (
  hrp: string,
  bytes: Uint8Array,
  length: number
): string => {
  if (bytes.length !== length) {
    throw new Error(`${hrp}1... payload must be exactly ${length} bytes`)
  }
  return bech32m.encode(hrp, bech32m.toWords(bytes), false)
}

const decodeFixed = (
  hrp: string,
  value: string,
  length: number
): Uint8Array | null => {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed.startsWith(`${hrp}1`)) return null
  try {
    const decoded = bech32m.decode(trimmed as `${string}1${string}`, false)
    if (decoded.prefix !== hrp) return null
    const bytes = bech32m.fromWords(decoded.words)
    return bytes.length === length ? bytes : null
  } catch {
    return null
  }
}

export const encodeCp1 = (pubkeyXOnly: Uint8Array): string =>
  encodeFixed('cp', pubkeyXOnly, 32)
export const decodeCp1 = (value: string): Uint8Array | null =>
  decodeFixed('cp', value, 32)
export const isCp1 = (value: string): boolean => decodeCp1(value) !== null

export const encodeCk1 = (signature: Uint8Array): string =>
  encodeFixed('ck', signature, 65)
export const decodeCk1 = (value: string): Uint8Array | null =>
  decodeFixed('ck', value, 65)
export const isCk1 = (value: string): boolean => decodeCk1(value) !== null

// LEGACY, fixed-HRP form: a cs1 certificate with no amount encoded in it
// at all (SERVICE and WALLET had to carry amount_msat alongside it
// separately - see request.ts's own `amount` query param history). Kept
// byte-for-byte as-is, only for interop with a SERVICE that hasn't
// migrated to encodeCs1WithAmount below (25.md: "encode amount in offline
// sig") - once none remain, this trio (and every decodeAnyCs1/isAnyCs1
// fallback path that reaches it) can be deleted outright.
export const encodeCs1 = (signature: Uint8Array): string =>
  encodeFixed('cs', signature, 65)
export const decodeCs1 = (value: string): Uint8Array | null =>
  decodeFixed('cs', value, 65)
export const isCs1 = (value: string): boolean => decodeCs1(value) !== null

// CURRENT form: a cs1 certificate whose own human-readable part folds in
// amount_msat the same way a BOLT-11 invoice's HRP does ("cs10n" for 1000
// msat - see bolt11.ts's encodeBolt11AmountSuffix/decodeBolt11AmountSuffix,
// which this wallet already had for parsing plain BOLT-11 invoices, and
// which lnurl-mint's own bech32m.py reuses verbatim from the same `bolt11`
// package). Nothing needs to travel alongside it on the wire any more - no
// separate `amount` query param, no separate JSON field - a verifier reads
// the amount straight off the certificate. That variable-width HRP is why
// this can't reuse encodeFixed/decodeFixed's own fixed-`hrp` signature
// directly the way its siblings above do; it computes the HRP text itself
// first, then delegates to the same two helpers for the bech32m mechanics.
export const encodeCs1WithAmount = (
  amountMsat: number,
  signature: Uint8Array
): string =>
  encodeFixed(`cs${encodeBolt11AmountSuffix(amountMsat)}`, signature, 65)

export const decodeCs1WithAmount = (
  value: string
): {amountMsat: number; signature: Uint8Array} | null => {
  const trimmed = value.trim().toLowerCase()
  const sep = trimmed.lastIndexOf('1')
  if (sep < 2 || !trimmed.slice(0, sep).startsWith('cs')) return null
  const amountMsat = decodeBolt11AmountSuffix(trimmed.slice(2, sep))
  if (amountMsat === null) return null
  const signature = decodeFixed(trimmed.slice(0, sep), trimmed, 65)
  return signature ? {amountMsat, signature} : null
}

export const isCs1WithAmount = (value: string): boolean =>
  decodeCs1WithAmount(value) !== null

// the one entry point most callers actually want: "give me the raw
// 65-byte signature, whichever cs1 wire shape SERVICE happens to still
// send" - tries the current amount-encoding form first, falls back to the
// legacy fixed-HRP one, so this wallet stays interoperable with both an
// unmigrated and a migrated SERVICE without call sites needing to know or
// care which. See signature.ts's normalizeSignatureHex/
// requireMutationSignature and mintRequest.ts's normalizeSignature for
// where this actually matters.
export const decodeAnyCs1 = (value: string): Uint8Array | null =>
  decodeCs1WithAmount(value)?.signature ?? decodeCs1(value)

export const isAnyCs1 = (value: string): boolean =>
  isCs1WithAmount(value) || isCs1(value)

export type Cx1 = {pubkeyXOnly: Uint8Array; chainCode: Uint8Array}

export const encodeCx1 = (
  pubkeyXOnly: Uint8Array,
  chainCode: Uint8Array
): string =>
  encodeFixed('cx', new Uint8Array([...pubkeyXOnly, ...chainCode]), 64)

export const decodeCx1 = (value: string): Cx1 | null => {
  const bytes = decodeFixed('cx', value, 64)
  if (!bytes) return null
  return {pubkeyXOnly: bytes.slice(0, 32), chainCode: bytes.slice(32)}
}
export const isCx1 = (value: string): boolean => decodeCx1(value) !== null

// ---- per-note key tweak ----
//
//   t     = tagged_hash("LNURLcash/derive", P || chain_code || ser32(i))
//   Q     = lift_x(P) + t·G
//   pk_i  = x(Q)
//
// ser32(i) is a 4-byte BIG-ENDIAN index - lnurl-mint's own derivation.py
// flags this width choice as "genuinely interoperability-critical" since
// the spec text doesn't pin it; this must match exactly.
const NOTE_DERIVE_TAG = 'LNURLcash/derive'

const ser32BE = (index: number): Uint8Array => {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, index, false)
  return bytes
}

const bytesToNumberBE = (bytes: Uint8Array): bigint =>
  BigInt(`0x${bytesToHex(bytes)}`)

const numberToBytesBE = (n: bigint, length: number): Uint8Array =>
  hexToBytes(n.toString(16).padStart(length * 2, '0'))

// the scalar field order n - reused rather than hardcoded so this tracks
// the library's own curve parameters if they ever change representation
const CURVE_ORDER = schnorr.Point.CURVE().n

const tweakScalar = (
  branchPubkeyXOnly: Uint8Array,
  chainCode: Uint8Array,
  index: number
): bigint => {
  const t = schnorr.utils.taggedHash(
    NOTE_DERIVE_TAG,
    branchPubkeyXOnly,
    chainCode,
    ser32BE(index)
  )
  return bytesToNumberBE(t) % CURVE_ORDER
}

// watch-only: needs only the branch's PUBLIC key + chain code (cx1's own
// payload) - this is what lets a SERVICE (or anyone holding cx1) derive
// pk_i without ever touching a private key
export const deriveNotePubkey = (
  branchPubkeyXOnly: Uint8Array,
  chainCode: Uint8Array,
  index: number
): Uint8Array => {
  const t = tweakScalar(branchPubkeyXOnly, chainCode, index)
  const branchPoint = schnorr.utils.lift_x(bytesToNumberBE(branchPubkeyXOnly))
  const notePoint = branchPoint.add(schnorr.Point.BASE.multiply(t))
  return schnorr.utils.pointToBytes(notePoint)
}

// only the wallet (holder of the branch's actual private key) can do this.
// BIP-340/341's own even-Y convention: `branchPubkeyXOnly` (whatever
// deriveNotePubkey is given) always names the EVEN-y point at that x
// (lift_x's own contract) - so if the raw private scalar's true point has
// ODD y, it must be negated (mod n) BEFORE adding the tweak, or the
// derived secret's own public point won't match what deriveNotePubkey
// (or the SERVICE, independently) computes from the x-only bytes alone.
// Getting this parity step wrong is the single easiest way for this whole
// scheme to silently derive a keypair that doesn't match its own address -
// see recoverableNotes.test.ts's round-trip check (sk_i's own pubkey must equal
// deriveNotePubkey's output), which exists specifically to catch that.
export const deriveNoteSecretKey = (
  branchPrivateKey: Uint8Array,
  chainCode: Uint8Array,
  index: number
): Uint8Array => {
  const branchPubkeyXOnly = schnorr.getPublicKey(branchPrivateKey)
  const t = tweakScalar(branchPubkeyXOnly, chainCode, index)
  const rawScalar = bytesToNumberBE(branchPrivateKey)
  const branchFullPoint = schnorr.Point.BASE.multiply(rawScalar)
  const evenYScalar =
    branchFullPoint.y % 2n === 0n
      ? rawScalar
      : (CURVE_ORDER - rawScalar) % CURVE_ORDER
  const noteScalar = (evenYScalar + t) % CURVE_ORDER
  return numberToBytesBE(noteScalar, 32)
}
