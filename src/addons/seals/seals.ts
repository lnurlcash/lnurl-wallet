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
// exact shape ct1Interop.test.ts already verifies against the real
// lnurlcashkernel. No new script template; this is a new use of an
// already-proven one.
//
//   ISSUE: pick a name/description and a first owner, lock one of your
//   own notes DIRECTLY to that first state's own leaf (note.lockToPubkey,
//   kind: 'ct1' - the same verb Timelocker/Betlocker already use to lock
//   a note to an arbitrary taproot commitment). One step: transfers
//   always go to a NAMED recipient from the very start (see betlock.ts's
//   own counterparty precedent), so there's no separate "issuer holds it
//   first" step to model.
//
//   TRANSITION: the current owner reveals the CURRENT state (the
//   hashlock's own preimage - redeemCurrentStateCw1 below) and signs with
//   their own key, producing an ordinary cw1 - exactly like any other
//   script-path redemption in this wallet - then rotates DIRECTLY into a
//   NEW ct1 output committing to the next state (see verbs.ts's own
//   seal.transition, modeled on note.redeemBet's rotateNoteWithHash call,
//   just targeting a fresh ct1 instead of a plain secret hash).
//
//   CONSIGNMENT: what the current owner hands the next one - the mint's
//   own note url/amount, plus the full state history from genesis to now.
//   Nothing here is secret. The recipient (or anyone else) client-side
//   validates the whole thing themselves (sealChainProblem) - nobody has
//   to trust the sender, same posture RGB's own client-side validation
//   takes. NOT YET included: per-transition mint certification signatures
//   (so today this proves the presented history is internally
//   self-consistent - one unbroken, unforked chain - not yet that every
//   step was independently confirmed by the mint; a real gap, flagged
//   rather than glossed over).
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
import {encodeCw1} from '../../lib/recoverableNotes'
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

// The hashlock leaf's own commitment - anyone can compute this from a
// state alone, which is exactly what makes client-side validation work:
// no secret, no network call, just arithmetic.
export const sealStateHash = (state: SealState): string =>
  bytesToHex(sha256(encodeSealState(state)))

export const genesisState = (
  name: unknown,
  description: unknown,
  ownerPubkeyHex: unknown
): SealState => {
  const trimmedName = String(name ?? '').trim()
  const trimmedDescription = String(description ?? '').trim()
  const owner = String(ownerPubkeyHex ?? '')
    .trim()
    .toLowerCase()
  if (!trimmedName) throw new Error('Name this asset first.')
  if (!isHex32(owner))
    throw new Error('Resolve the first owner’s pubkey first.')
  return {
    assetId: bytesToHex(schnorr.utils.randomSecretKey()),
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
  amountMsat: unknown
): string => {
  const secret = String(ownerSecretKeyHex ?? '')
    .trim()
    .toLowerCase()
  if (!isHex32(secret)) throw new Error('Not a valid 32-byte secret key.')
  if (!isPositiveInt(amountMsat)) {
    throw new Error('Missing this seal’s own amount.')
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
    Number(amountMsat),
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

export type SealConsignment = {
  urlTemplate: string
  amountMsat: number
  // genesis .. current, in order
  states: SealState[]
}

// The shareable consignment - the mint's own note url/amount, plus the
// full state history. Only ever built for the very states that were
// actually locked (see manifest.ts's own call sites, which always pass
// the exact states array this wallet just finished locking/transitioning
// to).
export const sealConsignmentUrl = (
  lockedNote: unknown,
  states: unknown
): string | null => {
  const locked = lockedNote as {urlTemplate: string; amountMsat: number} | null
  if (!locked || !Array.isArray(states) || states.length === 0) return null
  try {
    const url = new URL(locked.urlTemplate)
    url.searchParams.delete('k1')
    url.searchParams.delete('sig')
    url.searchParams.set('amount', String(locked.amountMsat))
    url.searchParams.set('states', JSON.stringify(states))
    return url.toString()
  } catch {
    return null
  }
}

const isSealStateShaped = (v: unknown): v is SealState => {
  if (!v || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  return (
    isHex32(s.assetId) &&
    typeof s.name === 'string' &&
    typeof s.description === 'string' &&
    Number.isInteger(s.stateIndex) &&
    isHex32(s.ownerPubkeyHex) &&
    typeof s.prevStateHash === 'string'
  )
}

// the read side of sealConsignmentUrl - null for anything that isn't a
// well-formed consignment (never throws). Validates the SHAPE of every
// state entry defensively before ever trusting it as a SealState -
// nothing here assumes a pasted value is honest.
export const parseSealConsignment = (
  value: unknown
): SealConsignment | null => {
  try {
    const url = new URL(String(value ?? '').trim())
    const amountRaw = url.searchParams.get('amount')
    const statesRaw = url.searchParams.get('states')
    if (!amountRaw || !statesRaw) return null
    const amountMsat = Number(amountRaw)
    if (!isPositiveInt(amountMsat)) return null
    const parsed: unknown = JSON.parse(statesRaw)
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    if (!parsed.every(isSealStateShaped)) return null
    url.searchParams.delete('amount')
    url.searchParams.delete('states')
    return {urlTemplate: url.toString(), amountMsat, states: parsed}
  } catch {
    return null
  }
}

// what a pasted consignment says about itself, live while typing/pasting
// - '' when usable (shape AND chain both check out), else why not
export const consignmentProblem = (value: unknown): string => {
  const text = String(value ?? '').trim()
  if (!text) return 'Paste a consignment first.'
  const parsed = parseSealConsignment(text)
  if (!parsed) return 'That doesn’t look like a valid seal consignment.'
  return sealChainProblem(parsed.states)
}
