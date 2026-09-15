import {sha256} from '@noble/hashes/sha2.js'
import {secp256k1, schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {AmbiguousMintError} from './errors'
import {
  decodeCs1,
  decodeCs1WithAmount,
  isAnyCs1,
  isCk1,
  decodeCk1,
  encodeCp1
} from './recoverableNotes'
import type {DecodedCk1} from './recoverableNotes'

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
// `signature` may be plain hex OR a cs1-encoded certificate - SERVICE's
// own choice at disclosure time (see requireMutationSignature, which now
// preserves whichever one it actually sent rather than normalizing it
// away), dispatched by shape here at the one place that actually needs
// raw bytes, same convention as every other dual-mode field in this kit.
const normalizeSignatureHex = (
  signature: string,
  expectedAmountMsat: number
): string | null => {
  if (NOTE_SIGNATURE_PATTERN.test(signature)) return signature.toLowerCase()
  const current = decodeCs1WithAmount(signature)
  // The current wire carries the amount as well as signing it. Both claims
  // must agree; otherwise a copied payload under a different cs HRP would be
  // accepted while reporting an amount the signer never certified.
  if (current && current.amountMsat !== expectedAmountMsat) return null
  const decoded = current?.signature ?? decodeCs1(signature)
  return decoded ? bytesToHex(decoded) : null
}

const verifyNoteSignatureDigest = (
  digest: Uint8Array,
  signature: string,
  mintPubkeyHex: string,
  expectedAmountMsat: number
): boolean => {
  const signatureHex = normalizeSignatureHex(signature, expectedAmountMsat)
  if (!signatureHex) return false
  let wireSig: Uint8Array
  try {
    wireSig = hexToBytes(signatureHex)
  } catch {
    return false
  }
  if (wireSig.length !== 65) return false
  const target = mintPubkeyHex.toLowerCase()
  const trailing = new Uint8Array([wireSig[64]!, ...wireSig.subarray(0, 64)])
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
    const owner = recoverNoteOwnershipPubkey(k1)
    return owner
      ? verifyNoteSignatureHash(
          bytesToHex(owner.pubkeyXOnly),
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
      mintPubkeyHex,
      amountMsat
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
      mintPubkeyHex,
      amountMsat
    )
  } catch {
    return false
  }
}

// ---- LUD-25 Part 2: wallet-side ownership proof (ck1) ----
//
// CURRENT scheme (2026-09-16, luds#ck1): a plain BIP-340 Schnorr signature
// over the FIXED message "LNURLcash" (the same for every note, every
// request, unlike noteSignatureDigest's per-note/per-amount one above) -
// signed directly, no Lightning-signmessage digest wrapping (BIP-340's own
// `sign` already tagged-hashes the message internally). A cp1 note's bearer
// secret IS this (pubkey, signature) pair; the pubkey now travels alongside
// the signature explicitly (see encodeCk1) rather than being ecrecover'd
// back out of it, so verification is a direct Verify(pk, msg, sig) instead
// of a recovery-then-compare.
const NOTE_OWNERSHIP_MESSAGE = utf8ToBytes('LNURLcash')

// TODO(deprecated): the OLD scheme's digest - a Lightning-signmessage-style
// double-sha256 over the same fixed message, signed with recoverable ECDSA
// (see legacyRecoverNoteOwnershipPubkey below). Kept only to read a ck1
// minted before this scheme changed; WALLET never signs with this anymore.
const legacyNoteOwnershipDigest = (): Uint8Array =>
  sha256(
    sha256(
      new Uint8Array([
        ...LIGHTNING_SIGNED_MESSAGE_PREFIX,
        ...NOTE_OWNERSHIP_MESSAGE
      ])
    )
  )

// BIP-340's own aux_rand exists to harden a HARDWARE signer against fault/
// side-channel attacks across repeated signings - it is not what makes a
// single signature secure (the nonce is still a tagged hash of aux_rand,
// the secret key, and the message either way). 25.md requires the OPPOSITE
// property here: "WALLET computes this once per key and reuses the exact
// same (pk, sig) pair everywhere ck1 is needed" - a note recovered again
// later (address-branch rescan, this wallet's own addressRecovery.ts) must
// re-derive the identical ck1 byte-for-byte, or a plain string-equality
// "already held" check would treat the same note as a brand new one every
// scan. A fixed, all-zero aux_rand makes this signature pure function of
// (secretKey, message), matching secp256k1.sign's own RFC6979-deterministic
// default that the OLD recoverable-ECDSA ck1 got "for free".
const ZERO_AUX_RAND = new Uint8Array(32)

// The one signing function in this file - everything else only verifies.
// Returns the note's x-only pubkey alongside its 64-byte Schnorr signature;
// callers bech32m-encode both together as ck1 (see
// src/lib/recoverableNotes.ts's encodeCk1) for the wire. Takes and returns
// raw bytes rather than hex: unlike a k1 preimage, this secret is a genuine
// secp256k1 scalar (see src/lib/recoverableNotes.ts's deriveNoteSecretKey),
// never text.
export const signNoteOwnership = (
  secretKey: Uint8Array
): {pubkeyXOnly: Uint8Array; signature: Uint8Array} => ({
  pubkeyXOnly: schnorr.getPublicKey(secretKey),
  signature: schnorr.sign(NOTE_OWNERSHIP_MESSAGE, secretKey, ZERO_AUX_RAND)
})

// TODO(deprecated): recovers the x-only pubkey an OLD-style (bare
// recoverable-ECDSA, no embedded pk) ck1 signature belongs to. Only reached
// via recoverNoteOwnershipPubkey's legacy branch below, for a note minted
// before this scheme changed - never for a signature this wallet itself
// still produces (see signNoteOwnership above). Returns null rather than
// throwing on a malformed signature.
const legacyRecoverNoteOwnershipPubkey = (
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
      legacyNoteOwnershipDigest(),
      {prehash: false}
    )
    return recovered.subarray(1) // x-only: drop the 02/03 compressed prefix
  } catch {
    return null
  }
}

export type NoteOwnershipPubkey = {
  pubkeyXOnly: Uint8Array
  // TODO(deprecated): true iff this came from the OLD bare
  // recoverable-ECDSA ck1 shape rather than the current pk||sig one. A
  // caller holding a note whose owner resolved with legacy:true should
  // warn the holder and prompt them to rotate the note (closing the
  // exposure and re-issuing it under the current scheme) - see
  // BearerCard.tsx's deprecation badge.
  legacy: boolean
}

// the inverse of signNoteOwnership: reads/recovers the x-only pubkey a ck1
// belongs to, WITHOUT contacting SERVICE - lets a cp1 note's own bearer
// secret (its ck1) be looked up by public commitment (p=cp1<pk>, see
// request.ts's fetchNoteInfo) instead of by the secret itself, the same
// privacy reasoning hashK1 already gives legacy notes. Dispatches on the
// decoded ck1's own shape: the current one carries its pubkey explicitly
// and is verified directly (Verify(pk, "LNURLcash", sig)) rather than
// merely decoded - an unverified pk paired with a garbage sig must not
// silently "recover" as valid the way ECDSA recovery never could fail to
// produce *some* pubkey. TODO(deprecated): the legacy shape has no embedded
// pk at all, so it falls back to ecrecover instead - see
// legacyRecoverNoteOwnershipPubkey.
export const recoverNoteOwnershipPubkey = (
  ck1: string
): NoteOwnershipPubkey | null => {
  const decoded: DecodedCk1 | null = decodeCk1(ck1)
  if (!decoded) return null
  if (decoded.legacy === false) {
    let valid: boolean
    try {
      valid = schnorr.verify(
        decoded.signature,
        NOTE_OWNERSHIP_MESSAGE,
        decoded.pubkeyXOnly
      )
    } catch {
      valid = false
    }
    return valid ? {pubkeyXOnly: decoded.pubkeyXOnly, legacy: false} : null
  }
  const pubkeyXOnly = legacyRecoverNoteOwnershipPubkey(decoded.signature)
  return pubkeyXOnly ? {pubkeyXOnly, legacy: true} : null
}

// ---- LUD-25 Part 2: un-/registering a Lightning Address (Seed & derivation) ----
//
// Proof that SERVICE requires before overwriting an already-claimed
// username, or before unregistering one at all (25.md: "Registering, or
// later unregistering, a username against a cx1 MUST always be proven,
// never merely asserted"). Same BIP-340 Schnorr construction as
// signNoteOwnership above (2026-09-16, luds#ck1 - this used to be a
// recoverable-ECDSA signature too; see the deprecated ck1 path in
// recoverNoteOwnershipPubkey for that older shape), over a per-action,
// per-username message instead of one fixed value - domain-separated so a
// signature captured for one action/username can never be replayed as the
// other, or against a different username sharing the same branch. Signed
// with the branch's own index-0 secret key (cashSecrets.ts's
// cashAddressSecretAtIndex(domain, 0) - "the first secret" a WALLET would
// derive on this branch regardless, the same one a wallet-initiated
// mint/transfer would claim first), never a fresh per-request key. Unlike
// ck1, the pubkey never needs to travel alongside the signature: SERVICE
// already derives pk_0 from the cx1 on file (or the one being submitted, on
// a fresh claim) itself, so only the raw signature is ever sent.
export type AddressProofAction = 'register' | 'unregister'

const addressProofMessage = (
  action: AddressProofAction,
  username: string
): Uint8Array => utf8ToBytes(`LNURLcash:${action}:${username}`)

// returns the raw 64-byte Schnorr signature - callers hex-encode it for the
// wire (SERVICE's `sig` query param), same as any other plain-hex signature
// in this kit (see NOTE_SIGNATURE_PATTERN), not bech32m: unlike ck1/cs1 this
// value is never a note's own bearer secret or disclosed as part of a
// withdraw response, only ever a one-off proof.
export const signAddressProof = (
  branchIndexZeroSecretKey: Uint8Array,
  action: AddressProofAction,
  username: string
): Uint8Array =>
  // deterministic aux_rand - see signNoteOwnership's own ZERO_AUX_RAND
  // comment for why (a retried request should resend the exact same proof,
  // not a fresh-but-equally-valid one)
  schnorr.sign(
    addressProofMessage(action, username),
    branchIndexZeroSecretKey,
    ZERO_AUX_RAND
  )

// the public commitment a wallet-generated ck1 secret names, computed
// purely locally (no SERVICE round trip) - lets a caller that only has a
// note's bearer secret (e.g. a wallet-initiated Part 2 mint, before the
// note even exists yet) get the exact same cp1 value the mint's own
// dispatch-by-shape comment handling expects, without separately tracking
// which branch/index it came from. Null (never throws) on anything that
// isn't actually a ck1, mirroring recoverNoteOwnershipPubkey's own
// "unverifiable, not a crash" convention.
export const cp1FromCk1 = (ck1: string): string | null => {
  const owner = recoverNoteOwnershipPubkey(ck1)
  return owner ? encodeCp1(owner.pubkeyXOnly) : null
}

// LUD-25 Part 2: a cp1 output's sig/sig2 may come back as cs1<...>
// (bech32m) instead of plain hex - preserved exactly as SERVICE disclosed
// it (never normalized to hex here), so the note's own stored URL/sig
// matches the wire value byte-for-byte, same "keep the original shape"
// convention every other dual-mode field in this kit already follows.
// verifyNoteSignatureDigest (via normalizeSignatureHex) is the one place
// that actually needs raw bytes, and accepts either shape transparently.
export const requireMutationSignature = (
  body: any,
  field: 'sig' | 'sig2'
): string => {
  const signature = body?.[field]
  if (typeof signature === 'string') {
    if (NOTE_SIGNATURE_PATTERN.test(signature)) {
      return signature.toLowerCase()
    }
    if (isAnyCs1(signature)) return signature.trim()
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
