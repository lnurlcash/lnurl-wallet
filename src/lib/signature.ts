import {sha256} from '@noble/hashes/sha2.js'
import {secp256k1} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {AmbiguousMintError} from './errors'
import {decodeCs1, isCk1, decodeCk1, encodeCp1} from './recoverableNotes'

// ---- offline verification ----

export const MINT_PUBKEY_PATTERN = /^0[23][0-9a-f]{64}$/i
export const NOTE_SIGNATURE_PATTERN = /^[0-9a-f]{130}$/i

export const parseMintKey = (body: any): {mintPubkey: string} => {
  if (
    typeof body?.mintPubkey !== 'string' ||
    !MINT_PUBKEY_PATTERN.test(body.mintPubkey)
  ) {
    throw new Error(
      'SERVICE did not publish a valid persistent signing key (mintPubkey).'
    )
  }
  return {mintPubkey: body.mintPubkey.toLowerCase()}
}

// exported so callers can hash the mint secret behind a LUD-12 `comment`
// the same way a rotate/split/merge hash names a fresh output - it's the
// same hex-in/hex-out sha256 either way, just applied to a not-yet-disclosed
// secret instead of an existing k1
export const hashK1 = (k1: string): string => bytesToHex(sha256(hexToBytes(k1)))

// Signed the same way LUD-13 signs its auth seed phrase - the standard
// Lightning node `signmessage` wrapping:
//   message = "LNURLcash:" || amount_msat (decimal ASCII) || ":" || hex(sha256(k1))
//   digest  = sha256(sha256("Lightning Signed Message:" || message))
const LIGHTNING_SIGNED_MESSAGE_PREFIX = utf8ToBytes('Lightning Signed Message:')

const noteSignatureDigestForHash = (
  h: string,
  amountMsat: number
): Uint8Array => {
  if (!/^[0-9a-fA-F]{64}$/.test(h.trim())) {
    throw new Error('A note hash must be 32 bytes of hex.')
  }
  const message = utf8ToBytes(
    `LNURLcash:${amountMsat}:${h.trim().toLowerCase()}`
  )
  return sha256(
    sha256(new Uint8Array([...LIGHTNING_SIGNED_MESSAGE_PREFIX, ...message]))
  )
}

const noteSignatureDigest = (k1: string, amountMsat: number): Uint8Array =>
  noteSignatureDigestForHash(hashK1(k1), amountMsat)

// recovers the signer's pubkey from (k1, amountMsat, signature) and checks
// it against `mintPubkey` - true only if both match. `signature` is 65
// bytes, but which end carries the recovery id varies by mint in practice:
// the spec text calls for r || s || recovery-id (trailing - the same
// layout raw BOLT-11 signatures use); at least one real implementation
// instead sent its underlying Lightning node's signmessage RPC output
// unreordered - recovery-id || r || s (leading). Trying both candidate
// orderings costs nothing security-wise (recovering against the wrong one
// just yields an unrelated pubkey that won't match mintPubkey) and means a
// note verifies correctly regardless of which convention its issuer
// followed.
const verifyNoteSignatureDigest = (
  digest: Uint8Array,
  signatureHex: string,
  mintPubkeyHex: string
): boolean => {
  let wireSig: Uint8Array
  try {
    wireSig = hexToBytes(signatureHex)
  } catch {
    return false
  }
  if (wireSig.length !== 65) return false
  const target = mintPubkeyHex.toLowerCase()
  const trailing = new Uint8Array([wireSig[64], ...wireSig.subarray(0, 64)])
  const leading = wireSig
  for (const candidate of [trailing, leading]) {
    try {
      // `digest` is already the final double-sha256 per the spec/LUD-13 -
      // @noble/curves' recoverPublicKey otherwise defaults to `prehash:
      // true` and hashes it again internally, which would make this
      // recover against a value nothing ever actually signed and never
      // match a real signer's key
      const recovered = secp256k1.recoverPublicKey(candidate, digest, {
        prehash: false
      })
      if (bytesToHex(recovered) === target) return true
    } catch {
      // not a valid recovery under this ordering - try the other one
    }
  }
  return false
}

export const verifyNoteSignature = (
  k1: string,
  amountMsat: number,
  signatureHex: string,
  mintPubkeyHex: string
): boolean => {
  // LUD-25 Part 2: a cp1 note's k1 is a ck1 signature, not a preimage -
  // hashing it (noteSignatureDigest's normal path) would check against a
  // digest nothing ever signed. Recover the note's own pubkey locally
  // instead (no network needed) and verify against THAT hex, the exact
  // same digest template a legacy hash uses (see noteSignatureDigestForHash -
  // it never cared whether the hex it names a note by is a hash or a raw
  // pubkey). Centralized here, not left to each call site, so nothing that
  // calls this generic entry point can reintroduce the same bug.
  if (isCk1(k1)) {
    const signatureBytes = decodeCk1(k1)
    const pubkey = signatureBytes
      ? recoverNoteOwnershipPubkey(signatureBytes)
      : null
    return pubkey
      ? verifyNoteSignatureHash(
          bytesToHex(pubkey),
          amountMsat,
          signatureHex,
          mintPubkeyHex
        )
      : false
  }
  try {
    return verifyNoteSignatureDigest(
      noteSignatureDigest(k1, amountMsat),
      signatureHex,
      mintPubkeyHex
    )
  } catch {
    // A malformed stored k1 is unverifiable, never a render-time crash.
    return false
  }
}

// A sealed vault discloses h=sha256(k1), not k1. A bound-mint receipt signs
// that same note id, so the companion can authenticate it without asking the
// device to export the bearer secret.
export const verifyNoteSignatureHash = (
  h: string,
  amountMsat: number,
  signatureHex: string,
  mintPubkeyHex: string
): boolean => {
  try {
    return verifyNoteSignatureDigest(
      noteSignatureDigestForHash(h, amountMsat),
      signatureHex,
      mintPubkeyHex
    )
  } catch {
    return false
  }
}

// ---- LUD-25 Part 2: wallet-side ownership proof (ck1) ----
//
// The one signing function in this file - everything above only verifies.
// Signs a FIXED message (the same for every note, every request, unlike
// noteSignatureDigest's per-note/per-amount one above) - a cp1 note's
// bearer secret IS this signature; SERVICE recovers the note's own pubkey
// from it (ecrecover) exactly like verifyNoteSignatureDigest above
// recovers against a known mintPubkey, just checking for existence in its
// note table instead of string-equality against one pinned key.
const NOTE_OWNERSHIP_MESSAGE = utf8ToBytes('LNURLcash')

const noteOwnershipDigest = (): Uint8Array =>
  sha256(
    sha256(
      new Uint8Array([
        ...LIGHTNING_SIGNED_MESSAGE_PREFIX,
        ...NOTE_OWNERSHIP_MESSAGE
      ])
    )
  )

// returns the raw 65-byte r‖s‖recovery-id signature - callers bech32m-encode
// it as ck1 (see src/lib/recoverableNotes.ts's encodeCk1) for the wire. Takes and
// returns raw bytes rather than hex: unlike a k1 preimage, this secret is a
// genuine secp256k1 scalar (see src/lib/recoverableNotes.ts's
// deriveNoteSecretKey), never text.
export const signNoteOwnership = (secretKey: Uint8Array): Uint8Array => {
  // noble's 'recovered' format is empirically recovery-id-first (rec || r
  // || s) - the wire format (and this codebase's own signAsMint test
  // helper, which this mirrors) is r || s || recovery-id, so reorder.
  // prehash:false: the digest here is already the final double-sha256 a
  // real signer signs directly - the default prehash:true would hash it
  // again, producing a signature SERVICE could never recover against this
  // note's own pubkey
  const libSig = secp256k1.sign(noteOwnershipDigest(), secretKey, {
    format: 'recovered',
    prehash: false
  })
  return new Uint8Array([...libSig.subarray(1), libSig[0]])
}

// the inverse of signNoteOwnership: recovers the x-only pubkey a ck1 this
// wallet itself produced belongs to, WITHOUT contacting SERVICE - lets a
// cp1 note's own bearer secret (its ck1) be looked up by public commitment
// (p=cp1<pk>, see request.ts's fetchNoteInfo) instead of by the secret
// itself, the same privacy reasoning hashK1 already gives legacy notes.
// Unlike verifyNoteSignatureDigest above (which tolerates either byte
// order because it verifies signatures OTHER implementations produced),
// this only ever recovers a signature signNoteOwnership itself just made,
// which is always wire format (r||s||recovery-id, trailing) - one
// ordering, no need to guess. Returns null rather than throwing on a
// malformed signature (mirrors verifyNoteSignature*'s own "unverifiable,
// not a crash" convention).
export const recoverNoteOwnershipPubkey = (
  signature: Uint8Array
): Uint8Array | null => {
  if (signature.length !== 65) return null
  try {
    const recidLeading = new Uint8Array([
      signature[64]!,
      ...signature.subarray(0, 64)
    ])
    const recovered = secp256k1.recoverPublicKey(
      recidLeading,
      noteOwnershipDigest(),
      {prehash: false}
    )
    return recovered.subarray(1) // x-only: drop the 02/03 compressed prefix
  } catch {
    return null
  }
}

// the public commitment a wallet-generated ck1 secret names, computed
// purely locally (no SERVICE round trip) - lets a caller that only has a
// note's bearer secret (e.g. a wallet-initiated Part 2 mint, before the
// note even exists yet) get the exact same cp1 value the mint's own
// dispatch-by-shape comment handling expects, without separately tracking
// which branch/index it came from. Null (never throws) on anything that
// isn't actually a ck1, mirroring recoverNoteOwnershipPubkey's own
// "unverifiable, not a crash" convention.
export const cp1FromCk1 = (ck1: string): string | null => {
  const signature = decodeCk1(ck1)
  const pubkey = signature ? recoverNoteOwnershipPubkey(signature) : null
  return pubkey ? encodeCp1(pubkey) : null
}

// LUD-25 Part 2: a cp1 output's sig/sig2 comes back as cs1<...> (bech32m)
// instead of plain hex - decoded to hex here, at the one choke point every
// mutation's signature passes through, so every downstream consumer
// (stored on the bearer's own url, verifyNoteSignatureHash) keeps working
// against plain hex regardless of which way SERVICE actually encoded it.
export const requireMutationSignature = (
  body: any,
  field: 'sig' | 'sig2'
): string => {
  const signature = body?.[field]
  if (typeof signature === 'string') {
    if (NOTE_SIGNATURE_PATTERN.test(signature)) {
      return signature.toLowerCase()
    }
    const decoded = decodeCs1(signature)
    if (decoded) return bytesToHex(decoded)
  }
  // The SERVICE has already answered OK, so callers must preserve the fresh
  // output secret even though the response is non-conformant.  Reuse the
  // ambiguous-result path which carries or commits those secrets safely -
  // request.ts's rotateNote/splitNote/mergeNotes catch AmbiguousMintError
  // specifically and re-throw it as an AmbiguousMutationError carrying the
  // fresh secret(s), so this must stay an AmbiguousMintError and not a
  // plain Error, or that fund-safety path silently stops firing.
  throw new AmbiguousMintError(
    `SERVICE confirmed the mutation without a valid ${field} signature.`
  )
}
