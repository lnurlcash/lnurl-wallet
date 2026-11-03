// Pure math behind the Seals addon: prove and transfer ownership of an
// off-chain, non-fungible "asset" using an LNURLcash note as its bearer
// anchor - the same core idea RGB and Taproot Assets use (state lives
// off-chain; a taproot commitment binds it to something spendable; each
// holder validates the WHOLE history client-side before trusting a
// transfer) adapted to bearer notes instead of real on-chain UTXOs.
//
// Why not literal Ordinals/"ordinal theory"? That needs a real, walkable
// on-chain transaction graph to assign sat provenance across - LNURLcash
// notes aren't on one (lnurlcashkernel verifies a witness as a pure
// function; nothing here is ever broadcast). The OTHER half of these
// protocols - commit to state in a taproot leaf, transfer the seal by
// burning-and-relocking, hand the recipient a self-contained proof they
// verify themselves rather than trusting the sender - maps cleanly, and
// is what this file implements.
//
// A "seal" is one continuously-transferred taproot note. Its identity
// (assetId/name/description) is fixed at genesis and never changes; its
// CURRENT state (owner pubkey, a state index, and a hash chaining back to
// the state before it) changes on every transfer. State is committed into
// the note's own leaf via the taproot addon's EXISTING `hashlock`
// template - SHA256 <state hash> EQUALVERIFY <owner pubkey> CHECKSIG - the
// exact shape spendInterop.test.ts already verifies against the real
// lnurlcashkernel. No new script template; this is a new use of an
// already-proven one.
//
//   ISSUE: pick a name/description and a first owner, lock one of your
//   own notes DIRECTLY to that first state's own leaf (note.lockToPubkey -
//   the same verb Timelocker/Betlocker already use to lock a note to an
//   arbitrary taproot commitment). One step: transfers
//   always go to a NAMED recipient from the very start (see betlock.ts's
//   own counterparty precedent), so there's no separate "issuer holds it
//   first" step to model.
//
//   TRANSITION: the current owner reveals the CURRENT state (the
//   hashlock's own preimage - redeemCurrentStateCw1 below) and signs with
//   their own key, producing an ordinary cw1 - exactly like any other
//   script-path redemption in this wallet - then rotates DIRECTLY into a
//   NEW cp1 output committing to the next state (see verbs.ts's own
//   seal.transition, modeled on note.redeemBet's rotateNoteWithHash call,
//   just targeting a fresh cp1 instead of a plain secret hash).
//
//   CONSIGNMENT: what the current owner hands the next one - the mint's
//   own note url/amount, plus the full state history from genesis to now.
//   Nothing here is secret. The recipient (or anyone else) client-side
//   validates the whole thing themselves (sealChainProblem) - nobody has
//   to trust the sender, same posture RGB's own client-side validation
//   takes. The chain alone only proves the presented history is
//   internally self-consistent: anyone who knows a state can lock a note of
//   their own to a made-up next state, and an owner can split the note and
//   lock both halves to two different ones. So a consignment also carries
//   the mint's own rotation certificate (cr1, see lib/signature.ts) for
//   every transition: its signature that THIS state's note was burned into
//   exactly THAT state's note. A note is burned once, so a fully certified
//   history has no fork and no look-alike in it - checked offline
//   (sealCertificateProblem), against nothing but the mint's signing key.
//   A consignment from a mint that issues none stays valid, just
//   uncertified. Two things a certified history still does not say: that
//   its LAST note is unspent (only the mint knows), and who issued the
//   seal - certificates start at the first transition, so the genesis is
//   vouched for by nothing but its own owner key and the mint it sits at.
//
//   Encoded the same way this kit encodes every other wire value it
//   invents (see src/lib/recoverableNotes.ts's own top comment) - a single
//   bech32m string, not JSON stuffed into a URL's query string. The HRP is
//   `seal`, deliberately NOT a 2-letter `c*` prefix like cp1/ck1/cw1/
//   cs1/cx1: those are real, standardized LUD-25 wire types this wallet
//   and the mint both implement; a seal consignment is wholly addon-local
//   and non-standardized, and a short prefix that LOOKED like one of those
//   would misrepresent it as protocol-level. (`cs1` in particular is
//   already taken - a mint issuance certificate, unrelated to this.)
//
// Honest limitation, same one Betlocker's own receipt already carries: an
// unredeemed transition is a PROMISE, not a guarantee, until it actually
// lands at the mint - the underlying note can still only be redeemed
// once, so a current holder handing out two different "next state"
// transitions is exactly as real (and exactly as preventable - i.e. not
// at all, by design of a bearer system) as trying to spend the same note
// twice anywhere else in this wallet.
//
// Everything here is synchronous (see taproot.ts's own note on why a
// helper bound to a live Text/set must not return a Promise).
import {sha256} from '@noble/hashes/sha2.js'
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  utf8ToBytes
} from '@noble/hashes/utils.js'
import {schnorr} from '@noble/curves/secp256k1.js'
import {bech32m} from '@scure/base'
import {
  decodeCr1WithAmount,
  encodeCr1WithAmount,
  encodeCw1
} from '../../lib/recoverableNotes'
import {
  MINT_PUBKEY_PATTERN,
  verifyRotationCertificate
} from '../../lib/signature'
import {
  compileLeaf,
  NUMS_INTERNAL_KEY_HEX,
  scriptPathProofs,
  signScriptPathSpend,
  tweakPubkey,
  verifyScriptPath
} from '../taproot/taproot'

const isPositiveInt = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n > 0

const isHex32 = (v: unknown): v is string =>
  /^[0-9a-f]{64}$/i.test(String(v ?? ''))

export type SealState = {
  assetId: string
  name: string
  description: string
  stateIndex: number
  ownerPubkeyHex: string
  // '' at genesis
  prevStateHash: string
}

// A fixed-order, length-prefixed byte encoding - deterministic and
// unambiguous, unlike JSON (whose key order/whitespace aren't canonical).
// The domain-separation tag is baked into the bytes THEMSELVES, not a
// BIP340 tagged hash - the leaf script checks this with a plain
// OP_SHA256, not BIP340's own double-hash construction, so the preimage
// this wraps has to be exactly what OP_SHA256 will be run against.
const DOMAIN_TAG = utf8ToBytes('LNURLcash/seal/state/v0')

const lengthPrefixed = (text: string): Uint8Array => {
  const bytes = utf8ToBytes(text)
  if (bytes.length > 0xffff) throw new Error('That text is too long.')
  return concatBytes(
    Uint8Array.of((bytes.length >> 8) & 0xff, bytes.length & 0xff),
    bytes
  )
}

const encodeStateIndex = (n: number): Uint8Array =>
  Uint8Array.of(
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff
  )

const encodeSealState = (state: SealState): Uint8Array =>
  concatBytes(
    DOMAIN_TAG,
    hexToBytes(state.assetId),
    lengthPrefixed(state.name),
    lengthPrefixed(state.description),
    encodeStateIndex(state.stateIndex),
    hexToBytes(state.ownerPubkeyHex),
    state.prevStateHash ? hexToBytes(state.prevStateHash) : new Uint8Array(32)
  )

// reads one lengthPrefixed(text) field back out at `offset`, returning
// where the NEXT field starts - the read-side counterpart every
// length-prefixed write below needs. Throws on a truncated prefix or body
// (an offset that runs past the end of `bytes`); every caller here already
// wraps its own top-level decode in try/catch, the same "never throws to
// the caller, just null" posture decodeCw1 takes in recoverableNotes.ts.
const decodeLengthPrefixed = (
  bytes: Uint8Array,
  offset: number
): {text: string; next: number} => {
  if (offset + 2 > bytes.length) throw new Error('Truncated length prefix.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const length = view.getUint16(offset, false)
  const start = offset + 2
  if (start + length > bytes.length) throw new Error('Truncated text.')
  return {
    text: new TextDecoder().decode(bytes.slice(start, start + length)),
    next: start + length
  }
}

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i])

// the true inverse of encodeSealState above - reads DataView fields
// explicitly rather than manual bit-shifting (JS's `<<`/`>>>` treat their
// operands as SIGNED 32-bit integers, which is the wrong tool for reading
// an arbitrary unsigned length back out). Never throws: a malformed or
// tampered blob (wrong domain tag, truncated field, trailing garbage past
// the last field) is simply null - the same "don't trust a pasted value"
// posture every other parse function in this file already takes.
const decodeSealState = (bytes: Uint8Array): SealState | null => {
  try {
    if (bytes.length < DOMAIN_TAG.length) return null
    if (!bytesEqual(bytes.slice(0, DOMAIN_TAG.length), DOMAIN_TAG)) return null
    let offset = DOMAIN_TAG.length
    if (offset + 32 > bytes.length) return null
    const assetId = bytesToHex(bytes.slice(offset, offset + 32))
    offset += 32
    const name = decodeLengthPrefixed(bytes, offset)
    offset = name.next
    const description = decodeLengthPrefixed(bytes, offset)
    offset = description.next
    if (offset + 4 > bytes.length) return null
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const stateIndex = view.getUint32(offset, false)
    offset += 4
    if (offset + 32 > bytes.length) return null
    const ownerPubkeyHex = bytesToHex(bytes.slice(offset, offset + 32))
    offset += 32
    if (offset + 32 > bytes.length) return null
    const prevStateBytes = bytes.slice(offset, offset + 32)
    offset += 32
    if (offset !== bytes.length) return null // trailing garbage
    const prevStateHash = prevStateBytes.every(b => b === 0)
      ? ''
      : bytesToHex(prevStateBytes)
    return {
      assetId,
      name: name.text,
      description: description.text,
      stateIndex,
      ownerPubkeyHex,
      prevStateHash
    }
  } catch {
    return null
  }
}

// The hashlock leaf's own commitment - anyone can compute this from a
// state alone, which is exactly what makes client-side validation work:
// no secret, no network call, just arithmetic.
export const sealStateHash = (state: SealState): string =>
  bytesToHex(sha256(encodeSealState(state)))

// `assetIdHex` is what the asset IS, when there is something it can be the
// hash of - a picture seal passes its picture's own sha256 (see
// picture.ts), so anyone holding the file can check it against the seal.
// Left out, the id is 32 random bytes: unique, and about nothing.
export const genesisState = (
  name: unknown,
  description: unknown,
  ownerPubkeyHex: unknown,
  assetIdHex?: unknown
): SealState => {
  const trimmedName = String(name ?? '').trim()
  const trimmedDescription = String(description ?? '').trim()
  const owner = String(ownerPubkeyHex ?? '')
    .trim()
    .toLowerCase()
  if (!trimmedName) throw new Error('Name this asset first.')
  if (!isHex32(owner))
    throw new Error('Resolve the first owner’s pubkey first.')
  const given = String(assetIdHex ?? '')
    .trim()
    .toLowerCase()
  if (given && !isHex32(given)) {
    throw new Error('An asset id is 32 bytes of hex.')
  }
  return {
    assetId: given || bytesToHex(schnorr.utils.randomSecretKey()),
    name: trimmedName,
    description: trimmedDescription,
    stateIndex: 0,
    ownerPubkeyHex: owner,
    prevStateHash: ''
  }
}

// The next link in the chain - assetId/name/description are an asset's
// own fixed identity, never editable past genesis; only who owns it (and
// the bookkeeping that chains back to prove it) changes.
export const nextState = (
  current: SealState,
  nextOwnerPubkeyHex: unknown
): SealState => {
  const owner = String(nextOwnerPubkeyHex ?? '')
    .trim()
    .toLowerCase()
  if (!isHex32(owner)) throw new Error('Resolve the next owner’s pubkey first.')
  return {
    assetId: current.assetId,
    name: current.name,
    description: current.description,
    stateIndex: current.stateIndex + 1,
    ownerPubkeyHex: owner,
    prevStateHash: sealStateHash(current)
  }
}

export type SealLock = {outputKeyHex: string}

const leafFor = (state: SealState): Uint8Array => {
  const compiled = compileLeaf('hashlock', {
    pubkeyHex: state.ownerPubkeyHex,
    pubkey2Hex: '',
    hashHex: sealStateHash(state),
    locktime: 0
  })
  if (!compiled) throw new Error('Could not compile this state’s own leaf.')
  return hexToBytes(compiled.scriptHex)
}

// The taproot output a given state locks to - deterministic, pure, same
// "verify the proof before handing it out" discipline every other
// addon's own planX function already follows.
export const planSealLock = (state: SealState): SealLock => {
  const leaf = leafFor(state)
  const outputKeyHex = tweakPubkey(NUMS_INTERNAL_KEY_HEX, [
    leaf
  ]).tweakedPubkeyHex
  const [proof] = scriptPathProofs(hexToBytes(NUMS_INTERNAL_KEY_HEX), [leaf])
  if (!proof || !verifyScriptPath(outputKeyHex, proof)) {
    throw new Error('Internal error: this state’s own proof does not verify.')
  }
  return {outputKeyHex}
}

// The current owner's own redemption witness for THIS state's leaf -
// reveals the state (the hashlock preimage) and signs with the owner's
// own key. This alone is already a complete, ordinary cw1 k1 - paste it
// into any receive flow to cash out the underlying value instead of
// transitioning it. See verbs.ts's own seal.transition for rotating it
// into a NEW state instead.
export const redeemCurrentStateCw1 = (
  state: SealState,
  ownerSecretKeyHex: unknown,
  mint: unknown
): string => {
  const secret = String(ownerSecretKeyHex ?? '')
    .trim()
    .toLowerCase()
  if (!isHex32(secret)) throw new Error('Not a valid 32-byte secret key.')
  if (typeof mint !== 'string' || !mint.trim()) {
    throw new Error('Missing this seal’s own mint.')
  }
  const derivedPubkeyHex = bytesToHex(schnorr.getPublicKey(hexToBytes(secret)))
  if (derivedPubkeyHex !== state.ownerPubkeyHex) {
    throw new Error(
      'That secret key does not match this state’s own owner pubkey.'
    )
  }
  const leaf = leafFor(state)
  const [proof] = scriptPathProofs(hexToBytes(NUMS_INTERNAL_KEY_HEX), [leaf])
  if (!proof) throw new Error('Internal error: no proof for this state.')
  const sig = signScriptPathSpend(
    secret,
    NUMS_INTERNAL_KEY_HEX,
    [leaf],
    leaf,
    mint,
    0,
    0xfffffffe
  )
  return encodeCw1({
    locktime: 0,
    sequence: 0xfffffffe,
    script: proof.script,
    controlBlock: proof.controlBlock,
    witness: [sig, encodeSealState(state)]
  })
}

// '' when the WHOLE chain is self-consistent, else the reason it isn't -
// the real "client-side validation" this whole design is built around.
// Pure and offline: assetId/name/description never change past genesis,
// each state index increases by exactly one, and each state's own
// prevStateHash really does equal sealStateHash of the state before it.
export const sealChainProblem = (states: unknown): string => {
  if (!Array.isArray(states) || states.length === 0) {
    return 'No states to verify.'
  }
  const list = states as SealState[]
  const genesis = list[0]!
  if (genesis.stateIndex !== 0) return 'Genesis must be state index 0.'
  if (genesis.prevStateHash) return 'Genesis must have no previous state.'
  if (!isHex32(genesis.assetId)) return 'Genesis has an invalid asset id.'
  if (!genesis.name?.trim()) return 'Genesis has no name.'
  if (!isHex32(genesis.ownerPubkeyHex))
    return 'Genesis has an invalid owner pubkey.'
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1]!
    const cur = list[i]!
    if (cur.assetId !== genesis.assetId) {
      return `State ${i}: a different asset id - not the same asset.`
    }
    if (cur.name !== genesis.name || cur.description !== genesis.description) {
      return `State ${i}: name/description changed - an asset's own identity is fixed at genesis.`
    }
    if (cur.stateIndex !== prev.stateIndex + 1) {
      return `State ${i}: state index must increase by exactly 1.`
    }
    if (cur.prevStateHash !== sealStateHash(prev)) {
      return `State ${i}: does not chain to the state before it.`
    }
    if (!isHex32(cur.ownerPubkeyHex)) return `State ${i}: invalid owner pubkey.`
  }
  return ''
}

// The mint's own certificate for one transition: the cr1 it answered the
// rotate with that burned state `stateIndex - 1`'s note into state
// `stateIndex`'s (so 1 for the first transfer - genesis itself has none).
export type SealCertificate = {stateIndex: number; cr1: string}

export type SealConsignment = {
  urlTemplate: string
  amountMsat: number
  // genesis .. current, in order
  states: SealState[]
  // at most one per transition, in no particular order; empty for a
  // consignment nobody certified
  certificates: SealCertificate[]
}

// A certificate's own domain tag - what tells it apart from a state in the
// run of length-prefixed parts below, the same way DOMAIN_TAG marks a
// state. Followed by the state index it leads into and the cr1's raw 65
// signature bytes: its amount is the consignment's own, never repeated.
const CERTIFICATE_TAG = utf8ToBytes('LNURLcash/seal/cert/v0')

const encodeSealCertificate = (
  certificate: SealCertificate,
  amountMsat: number
): Uint8Array => {
  const decoded = decodeCr1WithAmount(String(certificate?.cr1 ?? ''))
  if (!decoded || decoded.amountMsat !== amountMsat) {
    throw new Error('A certificate is not a cr1 for this seal’s own amount.')
  }
  if (!isPositiveInt(certificate.stateIndex)) {
    throw new Error('A certificate names no transition.')
  }
  return concatBytes(
    CERTIFICATE_TAG,
    encodeStateIndex(certificate.stateIndex),
    decoded.signature
  )
}

const decodeSealCertificate = (
  bytes: Uint8Array,
  amountMsat: number
): SealCertificate | null => {
  const tagLength = CERTIFICATE_TAG.length
  if (bytes.length !== tagLength + 4 + 65) return null
  if (!bytesEqual(bytes.slice(0, tagLength), CERTIFICATE_TAG)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const stateIndex = view.getUint32(tagLength, false)
  if (stateIndex === 0) return null
  try {
    return {
      stateIndex,
      cr1: encodeCr1WithAmount(amountMsat, bytes.slice(tagLength + 4))
    }
  } catch {
    return null
  }
}

// Wire layout, all integers big-endian (mirrors recoverableNotes.ts's own
// cw1 - a header, then a run of length-prefixed parts):
//   u64 amountMsat
//   || u16 len(urlTemplate) || urlTemplate (utf8)
//   || (u16 len(state_i) || encodeSealState(state_i))*   [genesis..current]
//   || (u16 len(cert) || CERTIFICATE_TAG || u32 stateIndex || sig(65))*
//
// Certificates come after every state and are optional, so a consignment
// with none is byte-for-byte what it was before they existed. The other
// direction does not hold: a wallet from before certificates reads a
// certificate as a malformed state and rejects the whole consignment.
//
// u64, not u32 like cw1's own locktime/sequence fields: amountMsat isn't
// Bitcoin-consensus-bounded the way those are, and u32's ~4.29 billion
// msat ceiling (~0.043 BTC) is a real amount a locked note could exceed.
// Kept a JS-safe-integer in practice (encodeAmountMsat/decode below both
// enforce Number.isSafeInteger) since nothing here needs true 64-bit
// range, just headroom past u32.
const encodeAmountMsat = (amountMsat: number): Uint8Array => {
  if (!isPositiveInt(amountMsat) || !Number.isSafeInteger(amountMsat)) {
    throw new Error('Invalid amount.')
  }
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(amountMsat), false)
  return bytes
}

// The shareable consignment - the mint's own note url/amount, plus the
// full state history - as a single bech32m string (HRP `seal`), the same
// convention every other wire value in this kit already uses (see this
// file's top comment for why `seal`, not a 2-letter `c*` prefix). Only
// ever built for the very states that were actually locked (see
// manifest.ts's own call sites, which always pass the exact states array
// this wallet just finished locking/transitioning to).
export const encodeSealConsignment = (
  lockedNote: unknown,
  states: unknown,
  certificates?: unknown
): string | null => {
  const locked = lockedNote as {urlTemplate: string; amountMsat: number} | null
  if (!locked || !Array.isArray(states) || states.length === 0) return null
  try {
    // k1/sig are this ONE claim's own one-time secrets, not part of the
    // reusable redeem-callback template a consignment should carry -
    // stripped the same way sealConsignmentUrl always did before this
    // encoding existed
    let urlTemplate = locked.urlTemplate
    try {
      const url = new URL(urlTemplate)
      url.searchParams.delete('k1')
      url.searchParams.delete('c')
      urlTemplate = url.toString()
    } catch {
      // not a URL at all - pass it through untouched rather than fail the
      // whole encode over an unrelated field
    }
    const amountBytes = encodeAmountMsat(locked.amountMsat)
    const urlBytes = lengthPrefixed(urlTemplate)
    const stateParts = (states as SealState[]).map(s => {
      const encoded = encodeSealState(s)
      if (encoded.length > 0xffff) {
        throw new Error('A state is too large to encode.')
      }
      return encoded
    })
    // a certificate that is malformed, for another amount, or for a
    // transition this history doesn't have fails the whole encode: handing
    // out a consignment that silently dropped one would look certified to
    // its sender and uncertified to everyone else
    const seen = new Set<number>()
    const certificateParts = (
      Array.isArray(certificates) ? (certificates as SealCertificate[]) : []
    ).map(certificate => {
      const part = encodeSealCertificate(certificate, locked.amountMsat)
      const index = certificate.stateIndex
      if (index >= stateParts.length || seen.has(index)) {
        throw new Error('A certificate names a transition this seal lacks.')
      }
      seen.add(index)
      return part
    })
    const parts = [...stateParts, ...certificateParts]
    let total = amountBytes.length + urlBytes.length
    for (const part of parts) total += 2 + part.length
    const payload = new Uint8Array(total)
    payload.set(amountBytes, 0)
    payload.set(urlBytes, amountBytes.length)
    const view = new DataView(payload.buffer)
    let offset = amountBytes.length + urlBytes.length
    for (const part of parts) {
      view.setUint16(offset, part.length, false)
      payload.set(part, offset + 2)
      offset += 2 + part.length
    }
    return bech32m.encode('seal', bech32m.toWords(payload), false)
  } catch {
    return null
  }
}

// the read side of encodeSealConsignment - null for anything that isn't a
// well-formed consignment (never throws). Every field is read back out
// with explicit bounds checks, and decodeSealState below independently
// validates the SHAPE of every state entry - nothing here assumes a
// pasted value is honest.
export const decodeSealConsignment = (
  value: unknown
): SealConsignment | null => {
  try {
    const trimmed = String(value ?? '')
      .trim()
      .toLowerCase()
    if (!trimmed.startsWith('seal1')) return null
    const decoded = bech32m.decode(trimmed as `${string}1${string}`, false)
    if (decoded.prefix !== 'seal') return null
    const bytes = bech32m.fromWords(decoded.words)
    if (bytes.length < 10) return null // 8-byte amount + a 2-byte length prefix, at minimum
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const amountBig = view.getBigUint64(0, false)
    if (amountBig <= 0n || amountBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null
    }
    const {text: urlTemplate, next} = decodeLengthPrefixed(bytes, 8)
    if (!urlTemplate) return null
    const amountMsat = Number(amountBig)
    let offset = next
    const states: SealState[] = []
    const certificates: SealCertificate[] = []
    while (offset < bytes.length) {
      if (offset + 2 > bytes.length) return null
      const length = view.getUint16(offset, false)
      offset += 2
      if (offset + length > bytes.length) return null
      const part = bytes.slice(offset, offset + length)
      offset += length
      const certificate = decodeSealCertificate(part, amountMsat)
      if (certificate) {
        certificates.push(certificate)
        continue
      }
      // every state comes before the first certificate
      if (certificates.length > 0) return null
      const state = decodeSealState(part)
      if (!state) return null
      states.push(state)
    }
    if (states.length === 0) return null
    const indexes = certificates.map(c => c.stateIndex)
    if (
      new Set(indexes).size !== indexes.length ||
      indexes.some(index => index >= states.length)
    ) {
      return null
    }
    return {urlTemplate, amountMsat, states, certificates}
  } catch {
    return null
  }
}

// '' when the mint whose signing key is `mintPubkeyHex` certified EVERY
// transition of this consignment, else the first reason it didn't. Pure
// and offline, like sealChainProblem, which it runs first: each state's
// own output key is recomputed from the state itself (planSealLock), and
// each certificate must be that mint's cr1 for exactly "the note of state
// i - 1 became the note of state i", for this consignment's amount.
//
// What '' proves, given the mint's key: no transition here is a note
// somebody minted on the side, and none is one half of a split - each
// note is the only one its predecessor was ever burned into. It does not
// say the LAST note is still unspent; only the mint knows that (see
// verbs.ts's seal.check). A genesis-only consignment has no transition
// and so nothing to certify.
export const sealCertificateProblem = (
  consignment: unknown,
  mintPubkeyHex: unknown
): string => {
  const parsed =
    typeof consignment === 'string'
      ? decodeSealConsignment(consignment)
      : (consignment as SealConsignment | null)
  if (!parsed || !Array.isArray(parsed.states)) {
    return 'That doesn’t look like a valid seal consignment.'
  }
  const chainProblem = sealChainProblem(parsed.states)
  if (chainProblem) return chainProblem
  const mintPubkey = String(mintPubkeyHex ?? '')
    .trim()
    .toLowerCase()
  if (!MINT_PUBKEY_PATTERN.test(mintPubkey)) {
    return 'Missing the mint’s own signing key.'
  }
  let outputKeys: string[]
  try {
    outputKeys = parsed.states.map(state => planSealLock(state).outputKeyHex)
  } catch {
    return 'A state does not lock to a valid output key.'
  }
  const certificates = Array.isArray(parsed.certificates)
    ? parsed.certificates
    : []
  for (let i = 1; i < parsed.states.length; i++) {
    const certificate = certificates.find(c => c.stateIndex === i)
    if (!certificate) {
      return `State ${i}: the mint did not certify this transition.`
    }
    if (
      !verifyRotationCertificate(
        outputKeys[i - 1]!,
        outputKeys[i]!,
        parsed.amountMsat,
        certificate.cr1,
        mintPubkey
      )
    ) {
      return `State ${i}: its certificate is not this mint’s, or not for this transition.`
    }
  }
  return ''
}

// what a pasted consignment says about itself, live while typing/pasting
// - '' when usable (shape AND chain both check out), else why not
export const consignmentProblem = (value: unknown): string => {
  const text = String(value ?? '').trim()
  if (!text) return 'Paste a consignment first.'
  const parsed = decodeSealConsignment(text)
  if (!parsed) return 'That doesn’t look like a valid seal consignment.'
  return sealChainProblem(parsed.states)
}
