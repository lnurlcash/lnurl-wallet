// LUD-25 "Part 2: Recoverable signatures" - pure protocol math, no wallet
// dependency (same principle as the rest of src/lib - see its README, and
// its own deliberately narrow package.json dependency list: this file
// hand-rolls the couple of BIP341 primitives it needs from @noble/curves
// alone below, rather than pulling in a full transaction-building library
// just for those). Covers the three pieces every Part-2-aware peer
// (wallet or SERVICE) computes the same way regardless of how either side
// happens to derive its own keys:
//
//   1. bech32m (BIP-350, NOT the classic bech32/BIP-173 this repo's own
//      LUD-01 lnurl encoding in urls.ts uses) codecs for the 5 new fixed-
//      or variable-length value types: cp1 (a note's pubkey commitment),
//      ct1 (a taproot output key, ALSO script-path redeemable), ck1 (a
//      BIP-340 Schnorr ownership signature, pubkey attached - the note's
//      actual bearer secret; TODO(deprecated) still decodes the OLD bare
//      recoverable-ECDSA shape too, see isLegacyCk1), cw1 (a ct1's own
//      script-path spend: leaf, control block, witness), cs1 (a SERVICE
//      issuance certificate, still recoverable ECDSA - unchanged), cx1 (a
//      watch-only branch export: pubkey + chain code).
//   2. The non-hardened, taproot-style per-note key tweak a watch-only cx1
//      branch derives pk_i from - this is NOT standard BIP32 child
//      derivation (which hashes differently and needs HMAC-SHA512); it's
//      the exact scheme lnurl-mint's own derivation.py implements, and
//      must match byte-for-byte or a note minted to this wallet's branch
//      would be unfindable (see recoverableNotes.test.ts's cross-checked
//      vectors, generated from that actual mint code, not just internal
//      self-consistency).
//   3. BIP341 script-path commitment derivation (deriveScriptPathCommitment
//      et al, near the bottom of this file) - which taproot output key Q a
//      revealed (script, control block) proves, the read side of a cw1.
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

// A BIP341 taproot OUTPUT key (Q = P + t·G), not a plain signing key -
// byte-identical in shape to cp1 above (same 32-byte x-only payload) and
// deliberately so: everything that already handles "a 32-byte value keyed
// by its own certifying signature" keeps working unchanged. The separate
// HRP is a capability flag, not extra data - it tells SERVICE this note
// may ALSO be redeemed by revealing one of the script leaves committed
// under Q (a cw1 below), where a cp1 only ever accepts a ck1 key-path
// signature. A SERVICE that doesn't implement script-path redemption must
// reject a ct1 output outright rather than silently treat it as a cp1.
//
// Nothing about the script tree is disclosed here, by design: given an
// already-published Q, only whoever built it forward (choosing P and the
// leaves, then tweaking) can ever produce a valid leaf+control-block pair
// for it, so a revealed script path is self-certifying against Q alone -
// see BIP341's own security argument. Unused leaves therefore stay private
// forever, exactly as they do on-chain.
export const encodeCt1 = (outputKeyXOnly: Uint8Array): string =>
  encodeFixed('ct', outputKeyXOnly, 32)
export const decodeCt1 = (value: string): Uint8Array | null =>
  decodeFixed('ct', value, 32)
export const isCt1 = (value: string): boolean => decodeCt1(value) !== null

// "this output names a pubkey commitment, not a legacy hash" - the check
// every dispatch site wants, since cp1 and ct1 are treated identically
// everywhere a note is CREATED (canonical p1/p2 field names, a mandatory
// certifying signature). They only diverge at redemption, which is the one
// place the distinction has to be read back out explicitly.
export const isPubkeyCommitment = (value: string): boolean =>
  isCp1(value) || isCt1(value)

// CURRENT form (2026-09-16, luds#ck1): a 32-byte BIP-340 x-only pubkey
// concatenated with a 64-byte Schnorr signature over it - pk travels
// alongside the signature explicitly, verified directly, rather than
// recovered from it. 96 bytes total.
export const CK1_LENGTH = 96

// TODO(deprecated): the OLD ck1 shape - a bare 65-byte recoverable ECDSA
// signature (r || s || recovery-id), no embedded pubkey; a verifier had to
// ecrecover it back out. Kept only so a note minted before this scheme
// changed still decodes - see signature.ts's legacyRecoverNoteOwnershipPubkey
// for the matching (deprecated) recovery path, and isLegacyCk1 below for the
// check a UI uses to warn a holder and prompt a rotate. Once no such notes
// are expected to remain in the wild, this whole legacy branch (here and in
// signature.ts) can be deleted outright.
export const CK1_LEGACY_LENGTH = 65

export type DecodedCk1 =
  | {legacy: true; signature: Uint8Array}
  | {legacy: false; pubkeyXOnly: Uint8Array; signature: Uint8Array}

export const encodeCk1 = (
  pubkeyXOnly: Uint8Array,
  signature: Uint8Array
): string =>
  encodeFixed('ck', new Uint8Array([...pubkeyXOnly, ...signature]), CK1_LENGTH)

const decodeCk1Bytes = (value: string): Uint8Array | null => {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed.startsWith('ck1')) return null
  try {
    const decoded = bech32m.decode(trimmed as `${string}1${string}`, false)
    if (decoded.prefix !== 'ck') return null
    return bech32m.fromWords(decoded.words)
  } catch {
    return null
  }
}

export const decodeCk1 = (value: string): DecodedCk1 | null => {
  const bytes = decodeCk1Bytes(value)
  if (!bytes) return null
  if (bytes.length === CK1_LENGTH) {
    return {
      legacy: false,
      pubkeyXOnly: bytes.slice(0, 32),
      signature: bytes.slice(32)
    }
  }
  if (bytes.length === CK1_LEGACY_LENGTH) {
    return {legacy: true, signature: bytes}
  }
  return null
}

// TODO(deprecated): true iff `value` decodes as a ck1 under the OLD
// recoverable-ECDSA shape (CK1_LEGACY_LENGTH) rather than the current
// pk||sig one - a UI should treat this as "this note's bearer secret uses a
// deprecated format" and prompt the holder to rotate it (see BearerCard.tsx),
// closing the exposure and re-issuing it under the current scheme. Delete
// alongside the rest of the legacy branch once it's no longer needed.
export const isLegacyCk1 = (value: string): boolean =>
  decodeCk1(value)?.legacy === true

export const isCk1 = (value: string): boolean => decodeCk1(value) !== null

// The script-path counterpart to ck1 above. Where a ck1 proves ownership
// of a cp1/ct1's own key (one BIP-340 signature over the fixed message), a
// cw1 proves that one of the script leaves committed under a ct1's output
// key is satisfied: the leaf script itself, BIP341's control block (leaf
// version + output-key parity, the internal pubkey P, and the merkle path
// proving this leaf sits under Q's committed root), and whatever witness
// stack that particular leaf demands.
//
// It also carries the redeemer's claimed `locktime` and `sequence`, and this
// is load-bearing rather than incidental: a tapscript CHECKSIG signature
// commits to the spending transaction's nLockTime AND nSequence (BIP341's
// sighash includes both, even under ANYONECANPAY). The redeemer therefore has
// to pick those values BEFORE signing, so they must travel with the proof - a
// SERVICE cannot choose "now" after the fact and expect the signature to
// still verify. This mirrors Bitcoin's own split: the script compares its
// number against these two fields, and a separate finality check (here, the
// SERVICE's clock) decides whether the fields themselves are acceptable yet.
// That clock check is a custodial policy assertion, not a consensus one.
//
// Variable length, unlike every other type in this file: a leaf script, a
// merkle path and a witness stack are all genuinely unbounded, so there's
// no byte length to pin. encodeFixed's per-type pinning above was a
// simplicity choice for values that HAVE a fixed size, never a bech32m
// constraint.
//
// Wire layout, all integers big-endian:
//   u32 locktime || u32 sequence
//   || u16 len(script) || script || u16 len(controlBlock) || controlBlock
//   || (u16 len(witness_i) || witness_i)*
export type Cw1 = {
  locktime: number
  sequence: number
  script: Uint8Array
  controlBlock: Uint8Array
  witness: Uint8Array[]
}

const CW1_MAX_PART = 0xffff
const CW1_HEADER_LENGTH = 8
const U32_MAX = 0xffffffff

const isU32 = (n: number): boolean =>
  Number.isInteger(n) && n >= 0 && n <= U32_MAX

export const encodeCw1 = ({
  locktime,
  sequence,
  script,
  controlBlock,
  witness
}: Cw1): string => {
  if (!isU32(locktime) || !isU32(sequence)) {
    throw new Error('cw1... locktime and sequence must each be a u32')
  }
  const parts = [script, controlBlock, ...witness]
  let total = CW1_HEADER_LENGTH
  for (const part of parts) {
    if (part.length > CW1_MAX_PART) {
      throw new Error(`cw1... part must be at most ${CW1_MAX_PART} bytes`)
    }
    total += 2 + part.length
  }
  const payload = new Uint8Array(total)
  const view = new DataView(payload.buffer)
  view.setUint32(0, locktime, false)
  view.setUint32(4, sequence, false)
  let offset = CW1_HEADER_LENGTH
  for (const part of parts) {
    view.setUint16(offset, part.length, false)
    payload.set(part, offset + 2)
    offset += 2 + part.length
  }
  return bech32m.encode('cw', bech32m.toWords(payload), false)
}

export const decodeCw1 = (value: string): Cw1 | null => {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed.startsWith('cw1')) return null
  let bytes: Uint8Array
  try {
    const decoded = bech32m.decode(trimmed as `${string}1${string}`, false)
    if (decoded.prefix !== 'cw') return null
    bytes = bech32m.fromWords(decoded.words)
  } catch {
    return null
  }
  if (bytes.length < CW1_HEADER_LENGTH) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const locktime = view.getUint32(0, false)
  const sequence = view.getUint32(4, false)

  const parts: Uint8Array[] = []
  let offset = CW1_HEADER_LENGTH
  while (offset < bytes.length) {
    // a truncated length prefix, or one claiming more bytes than actually
    // remain, means this isn't a well-formed cw1 - never a partial read
    if (offset + 2 > bytes.length) return null
    const length = view.getUint16(offset, false)
    offset += 2
    if (offset + length > bytes.length) return null
    parts.push(bytes.slice(offset, offset + length))
    offset += length
  }
  // script and control block are both mandatory; the witness stack may
  // legitimately be empty (a pure timelock leaf needs nothing pushed)
  if (parts.length < 2) return null
  return {
    locktime,
    sequence,
    script: parts[0]!,
    controlBlock: parts[1]!,
    witness: parts.slice(2)
  }
}

export const isCw1 = (value: string): boolean => decodeCw1(value) !== null

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

// ---- BIP341 script-path commitment (what a bare cw1 names) ----
//
// Which taproot output key Q a revealed (script, control block) commits to
// - the same algorithm lnurl-mint's own ct1.py:derive_output_key runs, and
// the verification half of the addons/taproot playground's own tree-
// building (addons/taproot/taproot.ts's verifyScriptPath calls this
// directly rather than duplicating it). Self-certifying: whoever presents
// a leaf can only ever reach the one Q it was built forward from - this is
// what lets a bare cw1 name its own note without a mint-issued pointer.
//
// Built from this package's own already-declared dependencies only
// (@noble/curves - the same point-tweak math deriveNotePubkey above
// already does, just under BIP341's own tags/encoding instead of this
// scheme's LNURLcash/derive one) rather than pulling in @scure/btc-signer,
// a full transaction-building library this package (@lnurlcash/kit, a
// deliberately dependency-light protocol client - see this file's own top
// comment) has no other reason to depend on for two small primitives it
// can already build from what it has.

// Bitcoin's CompactSize (VarInt) length prefix - only the small range
// tapLeafHash below ever needs (no Script this package handles is anywhere
// near the 0xfd/0xfe thresholds, but the encoding is cheap to get exactly
// right regardless).
const compactSize = (n: number): Uint8Array => {
  if (n < 0xfd) return new Uint8Array([n])
  if (n <= 0xffff) {
    const bytes = new Uint8Array(3)
    bytes[0] = 0xfd
    new DataView(bytes.buffer).setUint16(1, n, true)
    return bytes
  }
  const bytes = new Uint8Array(5)
  bytes[0] = 0xfe
  new DataView(bytes.buffer).setUint32(1, n, true)
  return bytes
}

// BIP341: tagged_hash("TapLeaf", leaf_version || compact_size(len(script)) || script)
const tapLeafHash = (script: Uint8Array, leafVersion: number): Uint8Array =>
  schnorr.utils.taggedHash(
    'TapLeaf',
    new Uint8Array([leafVersion]),
    compactSize(script.length),
    script
  )

// BIP341: Q = lift_x(P) + tagged_hash("TapTweak", P || merkleRoot)·G,
// serialized x-only (BIP340 convention) alongside Q's own y-parity - a
// verifier needs both: the control block is required to carry that same
// parity bit, and a mismatch means the control block doesn't actually
// describe how Q was built (see verifyScriptPath's own extra check).
const taprootTweakPubkey = (
  internalKeyXOnly: Uint8Array,
  merkleRoot: Uint8Array
): {outputKey: Uint8Array; parity: 0 | 1} => {
  const t =
    bytesToNumberBE(
      schnorr.utils.taggedHash('TapTweak', internalKeyXOnly, merkleRoot)
    ) % CURVE_ORDER
  const internalPoint = schnorr.utils.lift_x(bytesToNumberBE(internalKeyXOnly))
  const tweakedPoint = internalPoint.add(schnorr.Point.BASE.multiply(t))
  return {
    outputKey: schnorr.utils.pointToBytes(tweakedPoint),
    parity: tweakedPoint.y % 2n === 0n ? 0 : 1
  }
}

export type ScriptPathCommitment = {outputKey: Uint8Array; parity: 0 | 1}

const compareBytesLex = (a: Uint8Array, b: Uint8Array): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!
  }
  return a.length - b.length
}

// Walks the merkle path in the control block up to its root (leaf hash,
// then each sibling folded in with a sorted-pair TapBranch tagged hash),
// then tweaks the control block's own internal key by that root. Never
// throws; a malformed control block is null.
export const deriveScriptPathCommitment = (
  script: Uint8Array,
  controlBlock: Uint8Array
): ScriptPathCommitment | null => {
  if (controlBlock.length < 33) return null
  if ((controlBlock.length - 33) % 32 !== 0) return null
  if ((controlBlock.length - 33) / 32 > 128) return null // BIP341's own cap
  try {
    const leafVersion = controlBlock[0]! & 0xfe
    const internalKey = controlBlock.subarray(1, 33)
    let node = tapLeafHash(script, leafVersion)
    for (let i = 33; i < controlBlock.length; i += 32) {
      const sibling = controlBlock.subarray(i, i + 32)
      const [a, b] =
        compareBytesLex(node, sibling) <= 0 ? [node, sibling] : [sibling, node]
      node = schnorr.utils.taggedHash('TapBranch', a, b)
    }
    return taprootTweakPubkey(internalKey, node)
  } catch {
    return null
  }
}

// convenience for callers that just want Q, e.g. resolving a held cw1 note
// against a mint (encodeCt1(outputKeyOfScriptPath(cw1.script, cw1.controlBlock)))
export const outputKeyOfScriptPath = (
  script: Uint8Array,
  controlBlock: Uint8Array
): Uint8Array | null =>
  deriveScriptPathCommitment(script, controlBlock)?.outputKey ?? null

// the ct1 output key hex a bare cw1 value commits to, or null if it isn't a
// well-formed cw1 or its control block is malformed
export const outputKeyOfCw1 = (value: string): string | null => {
  const cw1 = decodeCw1(value)
  if (!cw1) return null
  const key = outputKeyOfScriptPath(cw1.script, cw1.controlBlock)
  return key ? bytesToHex(key) : null
}
