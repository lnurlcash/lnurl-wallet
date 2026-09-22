// Pure math behind the betlocker addon: lock one of your notes to the
// outcome of a real-world event via a Discreet Log Contract oracle (see
// the sibling `dlc` addon for the oracle cryptography itself, and
// timelock.ts's own top comment for the general "ct1/cw1 note lock" shape
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
// Deliberately race-to-claim, not counterparty-bound (no MuSig2
// combination with a specific winner's own key) - see this addon's own
// docs panel. Hand the lock's own receipt only to whoever should be able
// to claim it.
//
// Everything here is synchronous (see taproot.ts's own note on why a
// helper bound to a live Text/set must not return a Promise).
import {hexToBytes} from '@noble/hashes/utils.js'
import {encodeCw1} from '../../lib/recoverableNotes'
import {withoutK1} from '../../lnurlcash'
import {
  compileLeaf,
  NUMS_INTERNAL_KEY_HEX,
  scriptPathProofs,
  signScriptPathSpend,
  tweakPubkey,
  verifyScriptPath
} from '../taproot/taproot'
import {outcomePoint, verifyAttestation, attestationScalar} from '../dlc/dlc'
import type {Attestation} from '../dlc/dlc'

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
}

const isPositiveInt = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n > 0

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
// leaf ever ends up spendable
const leafScriptsFor = (
  oraclePubkeyHex: string,
  nonceHex: string,
  outcomes: string[]
): Uint8Array[] =>
  outcomes.map(outcome => {
    const pubkeyHex = outcomePoint(oraclePubkeyHex, nonceHex, outcome)
    const compiled = compileLeaf('pk', {
      pubkeyHex,
      pubkey2Hex: '',
      hashHex: '',
      locktime: 0
    })
    if (!compiled) throw new Error(`Could not compile a leaf for "${outcome}".`)
    return hexToBytes(compiled.scriptHex)
  })

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

// Deliberately idempotent, unlike timelocker's own planTimelock - there is
// no secret key to draw here at all, just a deterministic tweak of public
// data. Safe to call from a live binding, not just a one-shot Button.
// oracleServiceUrl/eventId are optional discovery metadata (see BetPlan's
// own doc comment) - omit both for a hand-typed/pasted announcement, pass
// both when the announcement came from a real oracle's own
// fetchOracleAnnouncement (oracleClient.ts).
export const planBet = (
  oraclePubkeyHex: unknown,
  nonceHex: unknown,
  outcomes: unknown,
  oracleServiceUrl?: unknown,
  eventId?: unknown
): BetPlan => {
  const problem = betProblem(oraclePubkeyHex, nonceHex, outcomes)
  if (problem) throw new Error(problem)
  const oracle = String(oraclePubkeyHex).trim().toLowerCase()
  const nonce = String(nonceHex).trim().toLowerCase()
  const list = normalizedOutcomes(outcomes)

  const leaves = leafScriptsFor(oracle, nonce, list)
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
  const service = String(oracleServiceUrl ?? '').trim()
  const event = String(eventId ?? '').trim()
  return {
    outputKeyHex,
    oraclePubkeyHex: oracle,
    nonceHex: nonce,
    outcomes: list,
    ...(service && event ? {oracleServiceUrl: service, eventId: event} : {})
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
    url.searchParams.set('oracle', p.oraclePubkeyHex)
    url.searchParams.set('nonce', p.nonceHex)
    url.searchParams.set('outcomes', JSON.stringify(p.outcomes))
    // discovery metadata only (see BetPlan's own doc comment) - omitted
    // entirely for a plan that wasn't built from a real oracle's own
    // announcement, so an old-shape receipt is indistinguishable from one
    // built by a wallet version that predates this
    if (p.oracleServiceUrl && p.eventId) {
      url.searchParams.set('oracleService', p.oracleServiceUrl)
      url.searchParams.set('event', p.eventId)
    }
    return url.toString()
  } catch {
    return null
  }
}

export type BetReceipt = {
  urlTemplate: string
  amountMsat: number
  signature: string
  oraclePubkeyHex: string
  nonceHex: string
  outcomes: string[]
  // discovery metadata only, both-or-neither (see BetPlan's own doc
  // comment) - buildRedeemCw1 never reads these, they only let the Redeem
  // UI auto-fetch an attestation instead of requiring a manual paste
  oracleServiceUrl?: string
  eventId?: string
}

// the read side of betReceiptUrl - null for anything that isn't a
// well-formed receipt (never throws)
export const parseBetReceipt = (value: unknown): BetReceipt | null => {
  try {
    const url = new URL(String(value ?? '').trim())
    const amountRaw = url.searchParams.get('amount')
    const signature = url.searchParams.get('sig')
    const oraclePubkeyHex = url.searchParams.get('oracle')
    const nonceHex = url.searchParams.get('nonce')
    const outcomesRaw = url.searchParams.get('outcomes')
    if (
      !amountRaw ||
      !signature ||
      !oraclePubkeyHex ||
      !nonceHex ||
      !outcomesRaw
    ) {
      return null
    }
    const amountMsat = Number(amountRaw)
    if (!isPositiveInt(amountMsat)) return null
    const outcomes = normalizedOutcomes(JSON.parse(outcomesRaw))
    if (outcomes.length < MIN_OUTCOMES) return null
    const oracleServiceUrl = url.searchParams.get('oracleService') ?? ''
    const eventId = url.searchParams.get('event') ?? ''
    url.searchParams.delete('amount')
    url.searchParams.delete('sig')
    url.searchParams.delete('oracle')
    url.searchParams.delete('nonce')
    url.searchParams.delete('outcomes')
    url.searchParams.delete('oracleService')
    url.searchParams.delete('event')
    return {
      urlTemplate: url.toString(),
      amountMsat,
      signature,
      oraclePubkeyHex: oraclePubkeyHex.toLowerCase(),
      nonceHex: nonceHex.toLowerCase(),
      outcomes,
      // both-or-neither, same convention betReceiptUrl writes them with
      ...(oracleServiceUrl && eventId ? {oracleServiceUrl, eventId} : {})
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
export const buildRedeemCw1 = (
  receipt: BetReceipt,
  attestation: Attestation
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
  const leaves = leafScriptsFor(
    receipt.oraclePubkeyHex,
    receipt.nonceHex,
    receipt.outcomes
  )
  const winningIndex = receipt.outcomes.indexOf(attestation.outcome)
  const targetScript = leaves[winningIndex]!
  const proofs = scriptPathProofs(hexToBytes(NUMS_INTERNAL_KEY_HEX), leaves)
  const proof = proofs[winningIndex]
  if (!proof)
    throw new Error('Internal error: no proof for the winning outcome.')

  const s = attestationScalar(attestation.signatureHex)
  const sig = signScriptPathSpend(
    s,
    NUMS_INTERNAL_KEY_HEX,
    leaves,
    targetScript,
    receipt.amountMsat,
    0,
    0xfffffffe
  )
  return encodeCw1({
    locktime: 0,
    sequence: 0xfffffffe,
    script: proof.script,
    controlBlock: proof.controlBlock,
    witness: [sig]
  })
}
