import {sha256} from '@noble/hashes/sha2.js'
import {secp256k1} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {AmbiguousMintError} from './errors'

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

export const requireMutationSignature = (
  body: any,
  field: 'sig' | 'sig2'
): string => {
  const signature = body?.[field]
  if (typeof signature === 'string' && NOTE_SIGNATURE_PATTERN.test(signature)) {
    return signature.toLowerCase()
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
