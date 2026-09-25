// Pure math behind the betlocker addon: lock one of your notes to the
// outcome of a real-world event via a Discreet Log Contract oracle (see
// the sibling `dlc` addon for the oracle cryptography itself, and
// timelock.ts's own top comment for the general "cp1/cw1 note lock" shape
// this reuses byte-for-byte).
//
// Genuinely different from the sibling timelocker addon in one structural
// way: timelocker can sign its own cw1 at lock time, because it holds a
// throwaway key for its own leaf. Nobody holds a key for a DLC outcome
// leaf until the oracle actually attests - the discrete log simply doesn't
// exist yet - so this is a real two-step flow:
//
//   1. LOCK (planBet) - pick a note, name an oracle's announcement (its
//      pubkey, its per-event nonce, every possible outcome), and lock the
//      note to a taproot output with one leaf per outcome - each leaf is
//      <outcome point> CHECKSIG, the sibling dlc addon's own
//      outcomePoint() plugged into the existing `pk` template, same as
//      that addon's own playground already shows. betReceiptUrl then
//      builds the one thing that needs to survive until redemption: a
//      link carrying the mint's own host/path/certificate PLUS the full
//      announcement (nothing secret - every field here is already public
//      the moment the oracle published its announcement).
//   2. REDEEM (buildRedeemCw1) - once the oracle attests to whichever
//      outcome actually happened, its signature reveals a real private
//      key for exactly that one leaf (dlc.ts's attestationScalar). Sign
//      the canonical spend (signScriptPathSpend, shared with timelocker)
//      and the result is an ordinary, complete cw1 k1 - ready for the
//      normal withdraw flow, no different from any other note from here.
//
// Race-to-claim by default (a leaf is just <outcome point> CHECKSIG, no
// combination with a specific winner's own key) - but a staker can
// optionally name a counterparty's pubkey at lock time (resolved from a
// Lightning Address/cx1/cp1/username via the shared note.resolveAddressPubkey
// verb, same as the musig2 addon's own "add external pubkey" flow), which
// builds a real 2-of-2 leaf instead (the taproot addon's own `multisig2`
// template - BIP342's CHECKSIGADD idiom, real Tapscript, already verified
// against the real lnurlcashkernel in spendInterop.test.ts): <outcome point>
// CHECKSIG <counterparty pubkey> CHECKSIGADD 2 NUMEQUAL. Spendable only by
// whoever holds BOTH the oracle's attestation AND that counterparty's own
// private key - see buildRedeemCw1's own comment on the exact witness
// order this requires (signatures go in REVERSE of the leaf's own pubkey
// order, per BIP342/spendInterop.test.ts's own convention).
//
// Every bet also carries a MANDATORY refund leaf - <refund pubkey>
// CHECKLOCKTIMEVERIFY DROP CHECKSIG (the taproot addon's own `cltv`
// template, byte-for-byte the sibling timelocker addon's own leaf shape),
// with a throwaway key generated and eagerly signed at LOCK time, same
// pattern as timelocker's own planTimelock - nobody, including the
// staker, can spend it before its own locktime, but unlike an outcome
// leaf its key is known immediately, so there's no reason to defer
// signing it. This is what keeps a bet from being locked forever if the
// oracle simply never resolves: the ORIGINAL staker can always reclaim
// after the deadline they picked, racing against whoever might still
// redeem an outcome leaf the normal way. refundCw1 is the one genuinely
// SECRET output of planBet - see its own doc comment on why it must never
// end up in a shareable receipt.
//
// Everything here is synchronous (see taproot.ts's own note on why a
// helper bound to a live Text/set must not return a Promise).
import {schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {bech32m} from '@scure/base'
import {encodeCw1} from '../../lib/recoverableNotes'
import {withNewK1, withoutK1} from '../../lnurlcash'
import {
  compileLeaf,
  generateKeypair,
  NUMS_INTERNAL_KEY_HEX,
  scriptPathProofs,
  signScriptPathSpend,
  tweakPubkey,
  verifyScriptPath
} from '../taproot/taproot'
import {outcomePoint, verifyAttestation, attestationScalar} from '../dlc/dlc'
import type {Attestation} from '../dlc/dlc'
import {
  dateProblem,
  dateToLocktime,
  TIMELOCK_SEQUENCE
} from '../timelocker/timelock'
export {
  dateProblem as refundDateProblem,
  formatUnlock
} from '../timelocker/timelock'

const MIN_OUTCOMES = 2

// self-contained, like the sibling timelocker addon's own TimelockPlan -
// echoes back the announcement it was built from, rather than making
// betReceiptUrl's caller re-supply oracle/nonce/outcomes a second time
// from separate state fields that could in principle have changed since.
// oracleServiceUrl/eventId are pure discovery metadata, never load-bearing
// for the crypto: buildRedeemCw1 verifies an attestation entirely against
// oraclePubkeyHex/nonceHex/outcomes, the same way whether or not these two
// are present. They only let a receipt built FROM a real oracle's own
// /events/{id}/announcement (see oracleClient.ts) carry along "where to
// automatically fetch the attestation from later", so Redeem doesn't force
// a manual outcome/signature paste. Absent when a bet was built from a
// hand-typed or pasted announcement instead - that receipt still redeems
// exactly the same way, just without the auto-fetch convenience.
export type BetPlan = {
  outputKeyHex: string
  oraclePubkeyHex: string
  nonceHex: string
  outcomes: string[]
  oracleServiceUrl?: string
  eventId?: string
  // optional counterparty binding (see this file's own top comment) -
  // absent means today's plain race-to-claim <outcome point> CHECKSIG leaf
  counterpartyPubkeyHex?: string
  // the mandatory refund leaf (see this file's own top comment) - PUBLIC,
  // needed by anyone reconstructing this bet's own leaf tree
  refundPubkeyHex: string
  refundLocktime: number
  // SECRET - a fully-signed, ready-to-claim cw1 for the refund leaf alone,
  // using the throwaway key generated for it. Must be added to the
  // STAKER's OWN wallet right after locking (see manifest.ts's own "Add
  // refund note to wallet" step) and NEVER included in betReceiptUrl's
  // output - unlike everything else on this type, this one field alone
  // would let anyone who saw it claim the refund the moment it matures,
  // regardless of who actually staked the note or who's named to redeem
  // an outcome leaf.
  refundCw1: string
}

const isPositiveInt = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n > 0

const isU32 = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 0xffffffff

const normalizedOutcomes = (outcomes: unknown): string[] => {
  if (!Array.isArray(outcomes)) return []
  const trimmed = outcomes
    .map(o => String(o ?? '').trim())
    .filter(o => o !== '')
  return [...new Set(trimmed)]
}

// every outcome's own leaf, in a fixed order (the SAME order every call
// with the same inputs produces) - both planBet and buildRedeemCw1 need
// the FULL set to build the right merkle structure, even though only one
// leaf ever ends up spendable. counterpartyPubkeyHex present -> every leaf
// is a multisig2 (outcome point + that pubkey, both required); absent ->
// today's plain pk leaf (outcome point alone).
const leafScriptsFor = (
  oraclePubkeyHex: string,
  nonceHex: string,
  outcomes: string[],
  counterpartyPubkeyHex?: string
): Uint8Array[] =>
  outcomes.map(outcome => {
    const pubkeyHex = outcomePoint(oraclePubkeyHex, nonceHex, outcome)
    const compiled = counterpartyPubkeyHex
      ? compileLeaf('multisig2', {
          pubkeyHex,
          pubkey2Hex: counterpartyPubkeyHex,
          hashHex: '',
          locktime: 0
        })
      : compileLeaf('pk', {
          pubkeyHex,
          pubkey2Hex: '',
          hashHex: '',
          locktime: 0
        })
    if (!compiled) throw new Error(`Could not compile a leaf for "${outcome}".`)
    return hexToBytes(compiled.scriptHex)
  })

const refundLeafFor = (
  refundPubkeyHex: string,
  refundLocktime: number
): Uint8Array => {
  const compiled = compileLeaf('cltv', {
    pubkeyHex: refundPubkeyHex,
    pubkey2Hex: '',
    hashHex: '',
    locktime: refundLocktime
  })
  if (!compiled) throw new Error('Could not compile the refund leaf.')
  return hexToBytes(compiled.scriptHex)
}

// the FULL tree behind a bet: every outcome leaf, plus the refund leaf
// LAST - both planBet (building it) and buildRedeemCw1 (reconstructing it
// to redeem an OUTCOME leaf) need the exact same set, or their merkle
// proofs won't match what was actually locked. refundPubkeyHex/
// refundLocktime are conditionally included: absent for a receipt built
// by a wallet version that predates the mandatory refund leaf (redeems
// exactly as it always did, no refund leaf in its tree at all), present
// for every bet locked since.
const allLeavesFor = (
  oraclePubkeyHex: string,
  nonceHex: string,
  outcomes: string[],
  counterpartyPubkeyHex: string | undefined,
  refundPubkeyHex: string | undefined,
  refundLocktime: number | undefined
): Uint8Array[] => {
  const leaves = leafScriptsFor(
    oraclePubkeyHex,
    nonceHex,
    outcomes,
    counterpartyPubkeyHex
  )
  if (refundPubkeyHex && refundLocktime) {
    leaves.push(refundLeafFor(refundPubkeyHex, refundLocktime))
  }
  return leaves
}

// '' when (oracle, nonce, outcomes) are usable, else the reason they
// aren't - the live validation message shown before "Prepare bet" enables
export const betProblem = (
  oraclePubkeyHex: unknown,
  nonceHex: unknown,
  outcomes: unknown
): string => {
  if (!/^[0-9a-f]{64}$/i.test(String(oraclePubkeyHex ?? '').trim())) {
    return 'Enter the oracle’s own pubkey first.'
  }
  if (!/^[0-9a-f]{64}$/i.test(String(nonceHex ?? '').trim())) {
    return 'Enter the oracle’s own nonce for this event first.'
  }
  const list = normalizedOutcomes(outcomes)
  if (list.length < MIN_OUTCOMES) {
    return `Add at least ${MIN_OUTCOMES} possible outcomes.`
  }
  return ''
}

// '' when counterpartyPubkeyHex is empty (optional - fine) or a valid
// x-only pubkey, else the reason it isn't - the live validation message
// next to the "let someone else redeem" field
export const counterpartyProblem = (counterpartyPubkeyHex: unknown): string => {
  const trimmed = String(counterpartyPubkeyHex ?? '').trim()
  if (!trimmed) return ''
  return /^[0-9a-f]{64}$/i.test(trimmed)
    ? ''
    : 'Not a valid 32-byte x-only pubkey - resolve it from an address first.'
}

// Deliberately NOT idempotent, unlike this function's own earlier shape -
// every call draws a fresh refund keypair and a fresh signature (see this
// file's own top comment), so - same rule as timelocker's own
// planTimelock - it must only ever run from a one-shot `set` action (a
// Button), never from a live Text binding that re-evaluates on every
// render. amountMsat is the note being staked's own amount (needed to
// eagerly sign the refund spend); refundDate is a raw
// <input type="datetime-local"> value, same shape planTimelock's own
// `value` param takes (see dateToLocktime/dateProblem, re-exported from
// timelocker/timelock.ts). oracleServiceUrl/eventId are optional discovery
// metadata (see BetPlan's own doc comment) - omit both for a hand-typed/
// pasted announcement, pass both when the announcement came from a real
// oracle's own fetchOracleAnnouncement (oracleClient.ts).
// counterpartyPubkeyHex is the optional redemption binding (see this
// file's own top comment) - omit or pass '' for today's plain
// race-to-claim leaf.
export const planBet = (
  oraclePubkeyHex: unknown,
  nonceHex: unknown,
  outcomes: unknown,
  amountMsat: unknown,
  refundDate: unknown,
  mint: unknown,
  oracleServiceUrl?: unknown,
  eventId?: unknown,
  counterpartyPubkeyHex?: unknown
): BetPlan => {
  const problem = betProblem(oraclePubkeyHex, nonceHex, outcomes)
  if (problem) throw new Error(problem)
  const cpProblem = counterpartyProblem(counterpartyPubkeyHex)
  if (cpProblem) throw new Error(cpProblem)
  if (!isPositiveInt(amountMsat) || typeof mint !== 'string' || !mint) {
    throw new Error('Pick a note to stake first.')
  }
  const refundProblem = dateProblem(refundDate)
  if (refundProblem) throw new Error(refundProblem)
  const refundLocktime = dateToLocktime(refundDate)!

  const oracle = String(oraclePubkeyHex).trim().toLowerCase()
  const nonce = String(nonceHex).trim().toLowerCase()
  const list = normalizedOutcomes(outcomes)
  const counterparty = String(counterpartyPubkeyHex ?? '')
    .trim()
    .toLowerCase()

  const refundSecretKey = hexToBytes(generateKeypair().secretKeyHex)
  const refundPubkeyHex = bytesToHex(schnorr.getPublicKey(refundSecretKey))

  const leaves = allLeavesFor(
    oracle,
    nonce,
    list,
    counterparty || undefined,
    refundPubkeyHex,
    refundLocktime
  )
  const outputKeyHex = tweakPubkey(
    NUMS_INTERNAL_KEY_HEX,
    leaves
  ).tweakedPubkeyHex
  // refuse to hand out a plan unless every leaf demonstrably commits to
  // the key the note is about to be locked to - a burn is about to be
  // justified by this
  const proofs = scriptPathProofs(hexToBytes(NUMS_INTERNAL_KEY_HEX), leaves)
  for (const proof of proofs) {
    if (!verifyScriptPath(outputKeyHex, proof)) {
      throw new Error('Internal error: a leaf proof does not verify.')
    }
  }

  // eager-sign the refund leaf's own spend right now - unlike an outcome
  // leaf, its key is fully known already (see this file's own top
  // comment), same reasoning timelocker's own planTimelock already relies
  // on for its one and only leaf
  const refundScript = leaves[leaves.length - 1]!
  const refundProof = proofs[proofs.length - 1]!
  const refundSig = signScriptPathSpend(
    bytesToHex(refundSecretKey),
    NUMS_INTERNAL_KEY_HEX,
    leaves,
    refundScript,
    mint,
    refundLocktime,
    TIMELOCK_SEQUENCE
  )
  const refundCw1 = encodeCw1({
    locktime: refundLocktime,
    sequence: TIMELOCK_SEQUENCE,
    script: refundProof.script,
    controlBlock: refundProof.controlBlock,
    witness: [refundSig]
  })

  const service = String(oracleServiceUrl ?? '').trim()
  const event = String(eventId ?? '').trim()
  return {
    outputKeyHex,
    oraclePubkeyHex: oracle,
    nonceHex: nonce,
    outcomes: list,
    refundPubkeyHex,
    refundLocktime,
    refundCw1,
    ...(service && event ? {oracleServiceUrl: service, eventId: event} : {}),
    ...(counterparty ? {counterpartyPubkeyHex: counterparty} : {})
  }
}

// ---- cd1: this addon's own DLC-context envelope ----
//
// Packs everything betReceiptUrl used to spread across 8 loose query
// params (oracle/nonce/outcomes/oracleService/event/counterparty/
// refundPubkey/refundLocktime) into one compact bech32m value, same
// wire-format quality bar as src/lib/recoverableNotes.ts's own cp1/
// cw1/cs1/cx1/ck1 family (variable-length parts use that same file's cw1
// convention: u16 length prefix, then the bytes) - but deliberately kept
// addon-local, not added to that shared file: cp1/ck1/cw1/cs1/cx1 are
// all genuine LUD-25 wire types any LUD-25 peer needs to
// speak, while a DLC oracle's announcement shape is this addon's own
// application-layer construct, not a spec-level primitive - bundling it
// into the published @lnurlcash/kit package would leak betlocker-specific
// semantics into a library other LUD-25 wallets depend on for nothing
// related to bets.
//
// Wire layout, all integers big-endian:
//   32 bytes oraclePubkeyHex || 32 bytes nonceHex
//   || u16 count(outcomes) || (u16 len(utf8) || utf8)*
//   || u8 flags (bit0 discovery, bit1 counterparty, bit2 refund)
//   || [discovery: u16 len(oracleServiceUrl utf8) || utf8
//                  || u16 len(eventId utf8) || utf8]
//   || [counterparty: 32 bytes counterpartyPubkeyHex]
//   || [refund: 32 bytes refundPubkeyHex || u32 refundLocktime]
export type Cd1 = {
  oraclePubkeyHex: string
  nonceHex: string
  outcomes: string[]
  oracleServiceUrl?: string
  eventId?: string
  counterpartyPubkeyHex?: string
  refundPubkeyHex?: string
  refundLocktime?: number
}

const CD1_MAX_PART = 0xffff
const utf8Encode = (s: string): Uint8Array => new TextEncoder().encode(s)
const utf8Decode = (b: Uint8Array): string => new TextDecoder().decode(b)

const hex32 = (label: string, hex: string): Uint8Array => {
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(`cd1... ${label} must be 32 bytes of hex`)
  }
  return hexToBytes(hex.toLowerCase())
}

export const encodeCd1 = (fields: Cd1): string => {
  const oracle = hex32('oraclePubkeyHex', fields.oraclePubkeyHex)
  const nonce = hex32('nonceHex', fields.nonceHex)
  const outcomeParts = fields.outcomes.map(utf8Encode)
  const hasDiscovery = !!(fields.oracleServiceUrl && fields.eventId)
  const hasCounterparty = !!fields.counterpartyPubkeyHex
  const hasRefund = !!(fields.refundPubkeyHex && fields.refundLocktime)
  const discoveryParts = hasDiscovery
    ? [utf8Encode(fields.oracleServiceUrl!), utf8Encode(fields.eventId!)]
    : []
  const counterparty = hasCounterparty
    ? hex32('counterpartyPubkeyHex', fields.counterpartyPubkeyHex!)
    : null
  const refundPubkey = hasRefund
    ? hex32('refundPubkeyHex', fields.refundPubkeyHex!)
    : null
  if (hasRefund && !isU32(fields.refundLocktime!)) {
    throw new Error('cd1... refundLocktime must be a u32')
  }

  for (const part of [...outcomeParts, ...discoveryParts]) {
    if (part.length > CD1_MAX_PART) {
      throw new Error(`cd1... part must be at most ${CD1_MAX_PART} bytes`)
    }
  }
  if (outcomeParts.length > CD1_MAX_PART) {
    throw new Error('cd1... too many outcomes')
  }

  let total =
    32 + 32 + 2 + outcomeParts.reduce((sum, p) => sum + 2 + p.length, 0) + 1
  if (hasDiscovery)
    total += discoveryParts.reduce((sum, p) => sum + 2 + p.length, 0)
  if (hasCounterparty) total += 32
  if (hasRefund) total += 32 + 4

  const payload = new Uint8Array(total)
  const view = new DataView(payload.buffer)
  let offset = 0
  payload.set(oracle, offset)
  offset += 32
  payload.set(nonce, offset)
  offset += 32
  view.setUint16(offset, outcomeParts.length, false)
  offset += 2
  for (const part of outcomeParts) {
    view.setUint16(offset, part.length, false)
    offset += 2
    payload.set(part, offset)
    offset += part.length
  }
  payload[offset] =
    (hasDiscovery ? 1 : 0) | (hasCounterparty ? 2 : 0) | (hasRefund ? 4 : 0)
  offset += 1
  if (hasDiscovery) {
    for (const part of discoveryParts) {
      view.setUint16(offset, part.length, false)
      offset += 2
      payload.set(part, offset)
      offset += part.length
    }
  }
  if (hasCounterparty) {
    payload.set(counterparty!, offset)
    offset += 32
  }
  if (hasRefund) {
    payload.set(refundPubkey!, offset)
    offset += 32
    view.setUint32(offset, fields.refundLocktime!, false)
    offset += 4
  }
  return bech32m.encode('cd', bech32m.toWords(payload), false)
}

export const decodeCd1 = (value: string): Cd1 | null => {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed.startsWith('cd1')) return null
  let bytes: Uint8Array
  try {
    const decoded = bech32m.decode(trimmed as `${string}1${string}`, false)
    if (decoded.prefix !== 'cd') return null
    bytes = bech32m.fromWords(decoded.words)
  } catch {
    return null
  }
  if (bytes.length < 32 + 32 + 2 + 1) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0
  const oraclePubkeyHex = bytesToHex(bytes.slice(offset, offset + 32))
  offset += 32
  const nonceHex = bytesToHex(bytes.slice(offset, offset + 32))
  offset += 32
  const outcomeCount = view.getUint16(offset, false)
  offset += 2
  const outcomes: string[] = []
  for (let i = 0; i < outcomeCount; i++) {
    if (offset + 2 > bytes.length) return null
    const len = view.getUint16(offset, false)
    offset += 2
    if (offset + len > bytes.length) return null
    outcomes.push(utf8Decode(bytes.slice(offset, offset + len)))
    offset += len
  }
  if (offset + 1 > bytes.length) return null
  const flags = bytes[offset]!
  offset += 1
  const hasDiscovery = (flags & 1) !== 0
  const hasCounterparty = (flags & 2) !== 0
  const hasRefund = (flags & 4) !== 0

  let oracleServiceUrl: string | undefined
  let eventId: string | undefined
  if (hasDiscovery) {
    if (offset + 2 > bytes.length) return null
    const len1 = view.getUint16(offset, false)
    offset += 2
    if (offset + len1 > bytes.length) return null
    oracleServiceUrl = utf8Decode(bytes.slice(offset, offset + len1))
    offset += len1
    if (offset + 2 > bytes.length) return null
    const len2 = view.getUint16(offset, false)
    offset += 2
    if (offset + len2 > bytes.length) return null
    eventId = utf8Decode(bytes.slice(offset, offset + len2))
    offset += len2
  }

  let counterpartyPubkeyHex: string | undefined
  if (hasCounterparty) {
    if (offset + 32 > bytes.length) return null
    counterpartyPubkeyHex = bytesToHex(bytes.slice(offset, offset + 32))
    offset += 32
  }

  let refundPubkeyHex: string | undefined
  let refundLocktime: number | undefined
  if (hasRefund) {
    if (offset + 32 + 4 > bytes.length) return null
    refundPubkeyHex = bytesToHex(bytes.slice(offset, offset + 32))
    offset += 32
    refundLocktime = view.getUint32(offset, false)
    offset += 4
    if (refundLocktime === 0) return null
  }

  return {
    oraclePubkeyHex,
    nonceHex,
    outcomes,
    ...(oracleServiceUrl && eventId ? {oracleServiceUrl, eventId} : {}),
    ...(counterpartyPubkeyHex ? {counterpartyPubkeyHex} : {}),
    ...(refundPubkeyHex && refundLocktime
      ? {refundPubkeyHex, refundLocktime}
      : {})
  }
}

// The shareable "bet receipt" - the mint's own note URL (host, path,
// certificate for Q, amount), plus the full announcement (oracle pubkey,
// nonce, every outcome). Nothing here is secret: an announcement is
// public information the moment the oracle publishes it, and the receipt
// alone cannot redeem anything - only an actual attestation, published
// later, can. Only ever built for the very plan that was locked.
export const betReceiptUrl = (
  lockedNote: unknown,
  plan: unknown
): string | null => {
  const locked = lockedNote as {
    urlTemplate: string
    amountMsat: number
    signature: string
    groupPubkeyHex: string
  } | null
  const p = plan as BetPlan | null
  if (!locked || !p || locked.groupPubkeyHex !== p.outputKeyHex) return null
  try {
    const url = new URL(
      withoutK1(locked.urlTemplate, locked.amountMsat, locked.signature)
    )
    // one compact envelope instead of 8 loose params - see this file's own
    // cd1 section for the exact wire layout and why it lives here rather
    // than in the shared lib. Nothing in it is secret: an announcement is
    // public information the moment the oracle publishes it, the
    // counterparty/refund pubkeys are just pubkeys, and refundCw1 itself
    // (the actual secret) never goes anywhere near this receipt - see
    // BetPlan's own doc comment on why.
    url.searchParams.set(
      'dlc',
      encodeCd1({
        oraclePubkeyHex: p.oraclePubkeyHex,
        nonceHex: p.nonceHex,
        outcomes: p.outcomes,
        // discovery metadata only (see BetPlan's own doc comment) - omitted
        // entirely for a plan that wasn't built from a real oracle's own
        // announcement, so an old-shape receipt is indistinguishable from
        // one built by a wallet version that predates this
        ...(p.oracleServiceUrl && p.eventId
          ? {oracleServiceUrl: p.oracleServiceUrl, eventId: p.eventId}
          : {}),
        // load-bearing when present, unlike the discovery metadata above:
        // a redeemer reconstructing this bet's own leaf tree
        // (buildRedeemCw1) needs to know a counterparty leaf was used at
        // all, and which pubkey, or its own merkle proof won't match what
        // was actually locked
        ...(p.counterpartyPubkeyHex
          ? {counterpartyPubkeyHex: p.counterpartyPubkeyHex}
          : {}),
        // also load-bearing for the same reason - the refund leaf is part
        // of the SAME tree every outcome leaf's merkle proof is computed
        // against
        ...(p.refundPubkeyHex && p.refundLocktime
          ? {
              refundPubkeyHex: p.refundPubkeyHex,
              refundLocktime: p.refundLocktime
            }
          : {})
      })
    )
    return url.toString()
  } catch {
    return null
  }
}

// The refund note's own claimable URL - plan.refundCw1 as its k1, exactly
// like timelockNoteUrl builds the sibling timelocker addon's own note
// link. Unlike betReceiptUrl above, this is NOT for sharing - it's what
// the manifest's own "Add refund note to wallet" step feeds straight into
// note.claim, right after locking, so the STAKER's own wallet holds it
// (see BetPlan's own doc comment on refundCw1 for why this must never be
// handed to anyone else).
export const refundNoteUrl = (
  lockedNote: unknown,
  plan: unknown
): string | null => {
  const locked = lockedNote as {
    urlTemplate: string
    amountMsat: number
    signature: string
    groupPubkeyHex: string
  } | null
  const p = plan as BetPlan | null
  if (!locked || !p || locked.groupPubkeyHex !== p.outputKeyHex) return null
  try {
    return withNewK1(locked.urlTemplate, p.refundCw1, locked.amountMsat)
  } catch {
    return null
  }
}

export type BetReceipt = {
  urlTemplate: string
  amountMsat: number
  // absent whenever the underlying note has no offline-verification sig to
  // begin with (the mint never certified the lock - see the Lock UI's own
  // "could not verify the mint's certificate" warning) OR the staker
  // deliberately stripped it before sharing (see manifest.ts's own
  // stripOfflineSig toggle, src/lib/urls.ts's withoutSignature). Never
  // actually read by anything downstream (buildRedeemCw1 verifies the
  // attestation, not this) - requiring it here used to reject an otherwise
  // perfectly valid receipt outright, which is the bug this comment now
  // documents the fix for.
  signature?: string
  oraclePubkeyHex: string
  nonceHex: string
  outcomes: string[]
  // discovery metadata only, both-or-neither (see BetPlan's own doc
  // comment) - buildRedeemCw1 never reads these, they only let the Redeem
  // UI auto-fetch an attestation instead of requiring a manual paste
  oracleServiceUrl?: string
  eventId?: string
  // load-bearing when present (see betReceiptUrl's own comment) - absent
  // means today's plain race-to-claim leaf
  counterpartyPubkeyHex?: string
  // load-bearing when present, both-or-neither, same reasoning as
  // counterpartyPubkeyHex above - absent only for a receipt built by a
  // wallet version that predates the mandatory refund leaf (see
  // BetPlan's own doc comment); every bet locked since always has one.
  // Never the refund SECRET (refundCw1 stays wallet-local, never here).
  refundPubkeyHex?: string
  refundLocktime?: number
}

// the read side of betReceiptUrl - null for anything that isn't a
// well-formed receipt (never throws)
export const parseBetReceipt = (value: unknown): BetReceipt | null => {
  try {
    const url = new URL(String(value ?? '').trim())
    const amountRaw = url.searchParams.get('amount')
    // optional - see BetReceipt.signature's own doc comment for why a
    // receipt with no offline-verification sig is still a perfectly valid
    // receipt, not a malformed one
    const signature = url.searchParams.get('c')
    const dlcRaw = url.searchParams.get('dlc')
    if (!amountRaw || !dlcRaw) return null
    const amountMsat = Number(amountRaw)
    if (!isPositiveInt(amountMsat)) return null
    // decodeCd1 already rejects malformed hex/truncated parts on its own -
    // nothing left to re-validate here beyond this addon's own outcome-
    // count floor, which is app policy, not a wire-format concern
    const dlc = decodeCd1(dlcRaw)
    if (!dlc) return null
    const outcomes = normalizedOutcomes(dlc.outcomes)
    if (outcomes.length < MIN_OUTCOMES) return null
    url.searchParams.delete('amount')
    url.searchParams.delete('c')
    url.searchParams.delete('dlc')
    return {
      urlTemplate: url.toString(),
      amountMsat,
      oraclePubkeyHex: dlc.oraclePubkeyHex,
      nonceHex: dlc.nonceHex,
      outcomes,
      ...(signature ? {signature} : {}),
      // both-or-neither, same convention betReceiptUrl writes them with
      ...(dlc.oracleServiceUrl && dlc.eventId
        ? {oracleServiceUrl: dlc.oracleServiceUrl, eventId: dlc.eventId}
        : {}),
      ...(dlc.counterpartyPubkeyHex
        ? {counterpartyPubkeyHex: dlc.counterpartyPubkeyHex}
        : {}),
      ...(dlc.refundPubkeyHex && dlc.refundLocktime
        ? {
            refundPubkeyHex: dlc.refundPubkeyHex,
            refundLocktime: dlc.refundLocktime
          }
        : {})
    }
  } catch {
    return null
  }
}

// what a receipt says about itself, live while typing/pasting - '' when
// usable, else why not
export const receiptProblem = (value: unknown): string => {
  const text = String(value ?? '').trim()
  if (!text) return 'Paste a bet receipt first.'
  return parseBetReceipt(text) ? '' : 'That doesn’t look like a bet receipt.'
}

// Builds the note's real, ready-to-spend k1 from a receipt and a real
// attestation - the output of the whole flow. Throws with a specific,
// user-facing reason (never a generic one) on anything that doesn't check
// out: an attestation for the wrong event, an outcome this bet never
// named, or one that simply doesn't verify.
//
// redeemerSecretKeyHex is REQUIRED when receipt.counterpartyPubkeyHex is
// set (ignored otherwise) - the named counterparty's own secret key,
// checked against that pubkey before anything is signed, never
// transmitted anywhere. Producing this bet's real spend then needs TWO
// independent signatures over the exact same leaf: the attestation
// scalar's own (anyone who has the attestation can produce this) and the
// counterparty's own (only they can). Witness order matters and is NOT
// "outcome sig, then counterparty sig" - tapscript's CHECKSIGADD idiom
// consumes witness items in REVERSE of the leaf's own pubkey order (see
// multisig2's own build() in taproot.ts: pubkeyA CHECKSIG pubkeyB
// CHECKSIGADD), a convention verified against the real lnurlcashkernel in
// spendInterop.test.ts's own multisig2 case, reused here rather than
// re-derived.
export const buildRedeemCw1 = (
  receipt: BetReceipt,
  attestation: Attestation,
  redeemerSecretKeyHex?: string
): string => {
  if (!receipt.outcomes.includes(attestation.outcome)) {
    throw new Error(
      `"${attestation.outcome}" was never one of this bet's own outcomes.`
    )
  }
  if (
    !verifyAttestation(receipt.oraclePubkeyHex, receipt.nonceHex, attestation)
  ) {
    throw new Error(
      'That attestation does not verify against this bet’s own oracle and nonce.'
    )
  }
  let redeemerSecret = ''
  if (receipt.counterpartyPubkeyHex) {
    redeemerSecret = String(redeemerSecretKeyHex ?? '')
      .trim()
      .toLowerCase()
    if (!/^[0-9a-f]{64}$/i.test(redeemerSecret)) {
      throw new Error(
        'This bet is locked to a specific redeemer - enter that pubkey’s own secret key to redeem it.'
      )
    }
    const derivedPubkeyHex = bytesToHex(
      schnorr.getPublicKey(hexToBytes(redeemerSecret))
    )
    if (derivedPubkeyHex !== receipt.counterpartyPubkeyHex) {
      throw new Error(
        'That secret key does not match this bet’s own named redeemer pubkey.'
      )
    }
  }

  const leaves = allLeavesFor(
    receipt.oraclePubkeyHex,
    receipt.nonceHex,
    receipt.outcomes,
    receipt.counterpartyPubkeyHex,
    receipt.refundPubkeyHex,
    receipt.refundLocktime
  )
  const winningIndex = receipt.outcomes.indexOf(attestation.outcome)
  const targetScript = leaves[winningIndex]!
  const proofs = scriptPathProofs(hexToBytes(NUMS_INTERNAL_KEY_HEX), leaves)
  const proof = proofs[winningIndex]
  if (!proof)
    throw new Error('Internal error: no proof for the winning outcome.')

  const s = attestationScalar(attestation.signatureHex)
  const outcomeSig = signScriptPathSpend(
    s,
    NUMS_INTERNAL_KEY_HEX,
    leaves,
    targetScript,
    receipt.urlTemplate,
    0,
    0xfffffffe
  )
  const witness = receipt.counterpartyPubkeyHex
    ? [
        signScriptPathSpend(
          redeemerSecret,
          NUMS_INTERNAL_KEY_HEX,
          leaves,
          targetScript,
          receipt.urlTemplate,
          0,
          0xfffffffe
        ),
        outcomeSig
      ]
    : [outcomeSig]
  return encodeCw1({
    locktime: 0,
    sequence: 0xfffffffe,
    script: proof.script,
    controlBlock: proof.controlBlock,
    witness
  })
}
