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
// Race-to-claim by default (a leaf is just <outcome point> CHECKSIG, no
// combination with a specific winner's own key) - but a staker can
// optionally name a counterparty's pubkey at lock time (resolved from a
// Lightning Address/cx1/cp1/username via the shared note.resolveAddressPubkey
// verb, same as the musig2 addon's own "add external pubkey" flow), which
// builds a real 2-of-2 leaf instead (the taproot addon's own `multisig2`
// template - BIP342's CHECKSIGADD idiom, real Tapscript, already verified
// against the real lnurlcashkernel in ct1Interop.test.ts): <outcome point>
// CHECKSIG <counterparty pubkey> CHECKSIGADD 2 NUMEQUAL. Spendable only by
// whoever holds BOTH the oracle's attestation AND that counterparty's own
// private key - see buildRedeemCw1's own comment on the exact witness
// order this requires (signatures go in REVERSE of the leaf's own pubkey
// order, per BIP342/ct1Interop.test.ts's own convention).
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
  oracleServiceUrl?: unknown,
  eventId?: unknown,
  counterpartyPubkeyHex?: unknown
): BetPlan => {
  const problem = betProblem(oraclePubkeyHex, nonceHex, outcomes)
  if (problem) throw new Error(problem)
  const cpProblem = counterpartyProblem(counterpartyPubkeyHex)
  if (cpProblem) throw new Error(cpProblem)
  if (!isPositiveInt(amountMsat)) {
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
    Number(amountMsat),
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
    // PUBLIC (not secret - just a pubkey), but load-bearing, unlike the
    // discovery metadata above: a redeemer reconstructing this bet's own
    // leaf tree (buildRedeemCw1) needs to know a counterparty leaf was
    // used at all, and which pubkey, or its own merkle proof won't match
    // what was actually locked
    if (p.counterpartyPubkeyHex) {
      url.searchParams.set('counterparty', p.counterpartyPubkeyHex)
    }
    // ALSO public (a pubkey and a locktime, nothing secret) and equally
    // load-bearing for the same reason - the refund leaf is part of the
    // SAME tree every outcome leaf's merkle proof is computed against.
    // refundCw1 itself (the actual secret) never goes anywhere near this
    // receipt - see BetPlan's own doc comment on why.
    if (p.refundPubkeyHex && p.refundLocktime) {
      url.searchParams.set('refundPubkey', p.refundPubkeyHex)
      url.searchParams.set('refundLocktime', String(p.refundLocktime))
    }
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
  signature: string
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
    const counterpartyRaw = url.searchParams.get('counterparty') ?? ''
    // reject the whole receipt rather than silently drop a malformed
    // counterparty value - it's load-bearing (see BetReceipt's own doc
    // comment), so a garbled one must not be treated as "no counterparty"
    if (counterpartyRaw && !/^[0-9a-f]{64}$/i.test(counterpartyRaw)) return null
    const refundPubkeyRaw = url.searchParams.get('refundPubkey') ?? ''
    const refundLocktimeRaw = url.searchParams.get('refundLocktime') ?? ''
    // same reasoning as counterparty above - reject rather than silently
    // drop a garbled refund pubkey/locktime, since a receipt with one
    // present but bogus would otherwise redeem an outcome leaf against
    // the WRONG tree
    if (refundPubkeyRaw && !/^[0-9a-f]{64}$/i.test(refundPubkeyRaw)) return null
    const refundLocktime = refundLocktimeRaw ? Number(refundLocktimeRaw) : 0
    if (refundLocktimeRaw && !isPositiveInt(refundLocktime)) return null
    url.searchParams.delete('amount')
    url.searchParams.delete('sig')
    url.searchParams.delete('oracle')
    url.searchParams.delete('nonce')
    url.searchParams.delete('outcomes')
    url.searchParams.delete('oracleService')
    url.searchParams.delete('event')
    url.searchParams.delete('counterparty')
    url.searchParams.delete('refundPubkey')
    url.searchParams.delete('refundLocktime')
    return {
      urlTemplate: url.toString(),
      amountMsat,
      signature,
      oraclePubkeyHex: oraclePubkeyHex.toLowerCase(),
      nonceHex: nonceHex.toLowerCase(),
      outcomes,
      // both-or-neither, same convention betReceiptUrl writes them with
      ...(oracleServiceUrl && eventId ? {oracleServiceUrl, eventId} : {}),
      ...(counterpartyRaw
        ? {counterpartyPubkeyHex: counterpartyRaw.toLowerCase()}
        : {}),
      ...(refundPubkeyRaw && refundLocktime
        ? {refundPubkeyHex: refundPubkeyRaw.toLowerCase(), refundLocktime}
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
// ct1Interop.test.ts's own multisig2 case, reused here rather than
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
    receipt.amountMsat,
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
          receipt.amountMsat,
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
