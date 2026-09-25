import {sha256} from '@noble/hashes/sha2.js'
import {secp256k1, schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {AmbiguousMintError} from './errors'
import {
  decodeCs1WithAmount,
  isCs1WithAmount,
  isCk1,
  isCw1,
  decodeCk1,
  encodeCp1,
  outputKeyOfCw1
} from './recoverableNotes'
import type {DecodedCk1} from './recoverableNotes'
import {
  bearerNoteIdOfHash,
  bearerNoteIdOfPreimage,
  keyPathSighash,
  spendDomainOf
} from './spend'

// ---- offline verification ----

export const MINT_PUBKEY_PATTERN = /^0[23][0-9a-f]{64}$/i

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

// A note's cs1 certificate, signed the same way LUD-13 signs its auth seed
// phrase - the standard Lightning node `signmessage` wrapping:
//   message = "LNURLcash:" || amount_msat (decimal ASCII) || ":" || hex(Q)
//   digest  = sha256(sha256("Lightning Signed Message:" || message))
// Q is the note's taproot output key (25.md's Offline verification). For a
// bearer note that is the Q its hash h names (spend.ts's bearerNote).
const LIGHTNING_SIGNED_MESSAGE_PREFIX = utf8ToBytes('Lightning Signed Message:')

const noteSignatureDigestForId = (
  noteId: string,
  amountMsat: number
): Uint8Array => {
  if (!/^[0-9a-fA-F]{64}$/.test(noteId.trim())) {
    throw new Error('A note id must be 32 bytes of hex.')
  }
  const message = utf8ToBytes(
    `LNURLcash:${amountMsat}:${noteId.trim().toLowerCase()}`
  )
  return sha256(
    sha256(new Uint8Array([...LIGHTNING_SIGNED_MESSAGE_PREFIX, ...message]))
  )
}

// recovers the signer's pubkey from (note id, amountMsat, cs1) and checks
// it against `mintPubkey` - true only if both match. The cs1's 65 bytes are
// r || s || recovery-id (25.md's Encoding).
const normalizeSignatureHex = (
  signature: string,
  expectedAmountMsat: number
): string | null => {
  const current = decodeCs1WithAmount(signature)
  // The current wire carries the amount as well as signing it. Both claims
  // must agree; otherwise a copied payload under a different cs HRP would be
  // accepted while reporting an amount the signer never certified.
  if (current && current.amountMsat !== expectedAmountMsat) return null
  const decoded = current?.signature
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
  try {
    // `digest` is already the final double-sha256 per the spec/LUD-13 -
    // @noble/curves' recoverPublicKey otherwise defaults to `prehash:
    // true` and hashes it again internally, which would make this
    // recover against a value nothing ever actually signed and never
    // match a real signer's key
    const recidLeading = new Uint8Array([
      wireSig[64]!,
      ...wireSig.subarray(0, 64)
    ])
    const recovered = secp256k1.recoverPublicKey(recidLeading, digest, {
      prehash: false
    })
    return bytesToHex(recovered) === target
  } catch {
    return false
  }
}

const verifiesAgainstAnyId = (
  noteIds: string[],
  amountMsat: number,
  signatureHex: string,
  mintPubkeyHex: string
): boolean =>
  noteIds.some(noteId => {
    try {
      return verifyNoteSignatureDigest(
        noteSignatureDigestForId(noteId, amountMsat),
        signatureHex,
        mintPubkeyHex,
        amountMsat
      )
    } catch {
      return false
    }
  })

// The note ids a certificate for the note spent by `k1` may be signed over:
// its Q, read or derived locally from k1's own shape with no network - a
// ck1 carries it, a cw1's control block commits to it, a hex preimage's
// bearer note is built from it. Only the certificate is checked here, not
// whether k1 itself opens Q; for a ck1 that needs the note's domain, see
// recoverNoteOwnershipPubkey.
const noteIdsOfK1 = (k1: string): string[] => {
  if (isCk1(k1)) {
    const pubkey = ck1Pubkey(k1)
    return pubkey ? [bytesToHex(pubkey)] : []
  }
  if (isCw1(k1)) {
    const outputKeyHex = outputKeyOfCw1(k1)
    return outputKeyHex ? [outputKeyHex] : []
  }
  try {
    return [bearerNoteIdOfPreimage(k1)]
  } catch {
    return [] // a malformed stored k1 is unverifiable, never a crash
  }
}

export const verifyNoteSignature = (
  k1: string,
  amountMsat: number,
  signatureHex: string,
  mintPubkeyHex: string
): boolean =>
  verifiesAgainstAnyId(noteIdsOfK1(k1), amountMsat, signatureHex, mintPubkeyHex)

// A sealed vault discloses h=sha256(k1), not k1. A bound-mint receipt
// certifies the bearer note h names, so the companion can authenticate it
// without asking the device to export the bearer secret.
export const verifyNoteSignatureHash = (
  h: string,
  amountMsat: number,
  signatureHex: string,
  mintPubkeyHex: string
): boolean => {
  let noteIds: string[]
  try {
    noteIds = [bearerNoteIdOfHash(h)]
  } catch {
    return false
  }
  return verifiesAgainstAnyId(noteIds, amountMsat, signatureHex, mintPubkeyHex)
}

// A note's certificate, by its Q (hex) directly.
export const verifyNoteSignatureForKey = (
  outputKeyHex: string,
  amountMsat: number,
  signatureHex: string,
  mintPubkeyHex: string
): boolean =>
  verifiesAgainstAnyId([outputKeyHex], amountMsat, signatureHex, mintPubkeyHex)

// ---- LUD-25 key-path spends (ck1) ----
//
// A ck1 is Q || sig: a plain BIP-340 Schnorr signature by the note's own key
// over the canonical spend transaction's key-path sighash for the note's
// mint (spend.ts's keyPathSighash) - never a free-form message, so the
// mint can hand it to an off-the-shelf taproot verifier (Bitcoin Core's own,
// via lnurlcashkernel), and a signature one mint has seen can never be
// replayed at another. Q travels alongside the signature, since a Schnorr
// signature does not reveal its key.

// BIP-340's own aux_rand exists to harden a HARDWARE signer against fault/
// side-channel attacks across repeated signings - it is not what makes a
// single signature secure. 25.md asks for the opposite here: a key has one
// signature per mint, and a note recovered again later (address-branch
// rescan, this wallet's own addressRecovery.ts) must re-derive the
// identical ck1 byte-for-byte, or a plain string-equality "already held"
// check would treat the same note as a brand new one every scan. A fixed,
// all-zero aux_rand makes the signature a pure function of (secretKey,
// sighash) - and the sighash of (Q, domain).
const ZERO_AUX_RAND = new Uint8Array(32)

// The one note-signing function in this file - everything else only
// verifies. `domain` is the note's mint: its withdraw URL, server URL, or
// bare host (see spend.ts's spendDomainOf). Returns the note's x-only
// pubkey (its Q) alongside the 64-byte signature; callers bech32m-encode
// both together as ck1 (see recoverableNotes.ts's encodeCk1).
export const signNoteOwnership = (
  secretKey: Uint8Array,
  domain: string
): {pubkeyXOnly: Uint8Array; signature: Uint8Array} => {
  const pubkeyXOnly = schnorr.getPublicKey(secretKey)
  return {
    pubkeyXOnly,
    signature: schnorr.sign(
      keyPathSighash(pubkeyXOnly, spendDomainOf(domain)),
      secretKey,
      ZERO_AUX_RAND
    )
  }
}

export type NoteOwnershipPubkey = {pubkeyXOnly: Uint8Array}

// The note's Q a ck1 names, decoded only - nothing verified. What a lookup
// (p=cp1<Q>) or an output disclosure needs: SERVICE verifies the spend
// itself before honouring it.
export const ck1Pubkey = (ck1: string): Uint8Array | null =>
  decodeCk1(ck1)?.pubkeyXOnly ?? null

// Verifies a ck1 opens its note at `domain` (a note or mint URL, or a bare
// host), WITHOUT contacting SERVICE, and returns that note's Q. The current
// shape is verified directly - Verify(Q, keyPathSighash(Q, domain), sig) -
// so an unverified Q paired with a garbage signature never passes the way
// ECDSA recovery could never fail to produce *some* key.
export const recoverNoteOwnershipPubkey = (
  ck1: string,
  domain: string
): NoteOwnershipPubkey | null => {
  const decoded: DecodedCk1 | null = decodeCk1(ck1)
  if (!decoded) return null
  try {
    const sighash = keyPathSighash(decoded.pubkeyXOnly, spendDomainOf(domain))
    return schnorr.verify(decoded.signature, sighash, decoded.pubkeyXOnly)
      ? {pubkeyXOnly: decoded.pubkeyXOnly}
      : null
  } catch {
    return null
  }
}

// ---- LUD-25: un-/registering a Lightning Address (Seed & derivation) ----
//
// Proof that SERVICE requires before overwriting an already-claimed
// username, or before unregistering one at all (25.md: "Registering, or
// later unregistering, a username against a cx1 MUST always be proven,
// never merely asserted"). Same BIP-340 Schnorr construction as
// signNoteOwnership above, over a per-action,
// per-domain, per-username message instead of one fixed value -
// domain-separated so a signature captured for one action/username can
// never be replayed as the other, against a different username sharing the
// same branch, OR (2026-09-18, luds#cx1-domain-replay) against a different
// SERVICE: a bare cx1 (P/chaincode) carries no proof of which domain's hash
// a WALLET derived it under - that derivation is entirely WALLET-side and
// invisible to a verifier - so without `domain` folded into the signed
// message itself, any SERVICE that ever legitimately received one register/
// unregister proof from this wallet could replay it verbatim against every
// other SERVICE's own /p/{username}. `domain` here is addressProofUrl's own
// `server` reduced to a bare hostname (addresses.ts) - matching exactly what
// a SERVICE verifies against (lnurl-mint's router.py resolves this from its
// OWN configured base_url/onion_url, never a request's Host header), never
// the full origin cashAddressBranch/cashAddressSecretAtIndex derive under
// (that string is a WALLET-internal derivation choice a SERVICE never
// re-derives or checks, so it has no need to match this one). Hashed to a
// 32-byte digest before signing: `domain`/`username` are variable-length, so
// the raw message would otherwise only rarely land on the 32 bytes most
// Schnorr signers require.
// Signed with the branch's own index-0 secret key (cashSecrets.ts's
// cashAddressSecretAtIndex(domain, 0) - "the first secret" a WALLET would
// derive on this branch regardless, the same one a wallet-initiated
// mint/transfer would claim first), never a fresh per-request key. Unlike
// ck1, the pubkey never needs to travel alongside the signature: SERVICE
// already derives pk_0 from the cx1 on file (or the one being submitted, on
// a fresh claim) itself, so only the raw signature is ever sent.
export type AddressProofAction = 'register' | 'unregister'

const addressProofMessage = (
  action: AddressProofAction,
  domain: string,
  username: string
): Uint8Array => utf8ToBytes(`LNURLcash:${action}:${domain}:${username}`)

const addressProofDigest = (
  action: AddressProofAction,
  domain: string,
  username: string
): Uint8Array => sha256(addressProofMessage(action, domain, username))

// returns the raw 64-byte Schnorr signature - callers hex-encode it for the
// wire (SERVICE's `sig` query param), not bech32m: unlike ck1/cs1 this
// value is never a note's own bearer secret or disclosed as part of a
// withdraw response, only ever a one-off proof.
export const signAddressProof = (
  branchIndexZeroSecretKey: Uint8Array,
  action: AddressProofAction,
  domain: string,
  username: string
): Uint8Array =>
  // deterministic aux_rand - see signNoteOwnership's own ZERO_AUX_RAND
  // comment for why (a retried request should resend the exact same proof,
  // not a fresh-but-equally-valid one)
  schnorr.sign(
    addressProofDigest(action, domain, username),
    branchIndexZeroSecretKey,
    ZERO_AUX_RAND
  )

// the public commitment a wallet-generated ck1 secret names, computed
// purely locally (no SERVICE round trip) - lets a caller that only has a
// note's bearer secret (e.g. a wallet-initiated key-path mint, before the
// note even exists yet) get the exact same cp1 value the mint's own
// dispatch-by-shape comment handling expects, without separately tracking
// which branch/index it came from. Null (never throws) on anything that
// isn't actually a ck1, mirroring recoverNoteOwnershipPubkey's own
// "unverifiable, not a crash" convention.
// Whether a held k1 is a ck1 spending the note Q (x-only) - by Q, never by
// the ck1 string itself: the same note has a different ck1 per mint domain
// it was signed for, so a recovery scan must compare the Q.
export const k1SpendsNote = (k1: string | null, pubkeyXOnly: Uint8Array) => {
  const held = k1 ? ck1Pubkey(k1) : null
  return held !== null && bytesToHex(held) === bytesToHex(pubkeyXOnly)
}

export const cp1FromCk1 = (ck1: string): string | null => {
  const pubkey = ck1Pubkey(ck1)
  return pubkey ? encodeCp1(pubkey) : null
}

// A rotate/split/merge's sig/sig2: a cs1, preserved exactly as SERVICE
// disclosed it, so the note's own stored URL/sig matches the wire value
// byte-for-byte. verifyNoteSignatureDigest (via normalizeSignatureHex) is
// the one place that needs raw bytes.
export const requireMutationSignature = (
  body: any,
  field: 'sig' | 'sig2'
): string => {
  const signature = body?.[field]
  if (typeof signature === 'string' && isCs1WithAmount(signature)) {
    return signature.trim()
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
