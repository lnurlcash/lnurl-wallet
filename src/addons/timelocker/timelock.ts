// Pure math behind the timelocker addon: a note locked to a note whose ONLY
// spend path is one Tapscript leaf, the stock `cltv` template
//
//   <unix time> OP_CHECKLOCKTIMEVERIFY OP_DROP <pubkey> OP_CHECKSIG
//
// (lnurlcashkernel accepts a fixed set of leaf shapes - a keyless
// "<t> CLTV DROP 1" leaf is refused outright, see its README - so the lock
// needs a key, and opening it needs a signature from it.)
//
// Unlike the musig2 addon's lock flow, there is no separate "redeem" step:
// the note being locked already has a known amount (the bearer note picked
// to lock), and a tapscript CHECKSIG signature commits to that amount, the
// locktime and the sequence - all fixed the moment a lock is planned. So
// planTimelock builds and signs the FULL cw1 script-path spend right away,
// using a throwaway keypair generated and discarded on the spot (never
// returned - the taproot INTERNAL key is BIP341's NUMS point H besides, so
// no key-path spend exists for anyone, ever). The result IS the note's k1 -
// an ordinary, complete, self-contained bearer secret plugged straight into
// `?k1=`, exactly like a plain preimage or a ck1 (see lnurl-mint's
// router.py:_note_id_from_k1, which dispatches a `cw1` the same way).
// Nothing further needs to happen at "redeem" time - a note built this way
// is spendable the instant the mint's own clock passes its locktime, by
// whoever holds the link, through the ordinary withdraw flow.
//
// Everything here is synchronous (see taproot.ts's note on why a helper
// bound to a live Text/set must not return a Promise).
import {schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {encodeCw1} from '../../lib/recoverableNotes'
import {
  generateKeypair,
  NUMS_INTERNAL_KEY_HEX,
  scriptPathProofs,
  scriptTemplateById,
  signScriptPathSpend,
  tweakPubkey,
  verifyScriptPath
} from '../taproot/taproot'
// re-exported for existing importers of this module (e.g. this addon's
// own tests) - the constant itself now lives in taproot.ts, shared with
// the sibling betlocker addon, which has an identical "no key-path spend
// should exist for anyone" reason to want it
export {NUMS_INTERNAL_KEY_HEX}

// BIP65: below this a CLTV number is a block height, at/above it a unix time
export const LOCKTIME_THRESHOLD = 500_000_000
// nSequence must not be final (0xffffffff) for CLTV to be enforceable
export const TIMELOCK_SEQUENCE = 0xfffffffe
// a lock that unlocks within a minute is a mistake, not a timelock
const MIN_LEAD_SECONDS = 60

export type TimelockPlan = {
  locktime: number
  outputKeyHex: string
  // the complete, ready-to-spend k1 - a script-path proof plus a signature
  // over this exact amount, locktime and sequence. Nothing else is needed
  // to redeem it once the unlock time has passed.
  cw1: string
}

// a <input type="datetime-local"> value ("2027-01-31T14:30", local time) ->
// unix seconds, or null when empty/unparseable
export const dateToLocktime = (value: unknown): number | null => {
  const text = String(value ?? '').trim()
  if (!text) return null
  const ms = new Date(text).getTime()
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

// '' when the date is a usable unlock time, else the reason it isn't
export const dateProblem = (
  value: unknown,
  nowSeconds = Math.floor(Date.now() / 1000)
): string => {
  const locktime = dateToLocktime(value)
  if (locktime === null) return 'Pick a date and time first.'
  if (locktime < LOCKTIME_THRESHOLD) return 'That date is too far in the past.'
  if (locktime < nowSeconds + MIN_LEAD_SECONDS) {
    return 'Pick a time at least a minute in the future.'
  }
  if (locktime >= TIMELOCK_SEQUENCE) return 'That date is too far ahead.'
  return ''
}

const isPositiveInt = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n > 0

// Deliberately NOT idempotent: every call draws a fresh key and a fresh
// signature, so it must only ever run from a one-shot `set` action (a
// Button), never from a live Text binding that re-evaluates on every render.
export const planTimelock = (
  value: unknown,
  amountMsat: unknown,
  mint: unknown,
  nowSeconds = Math.floor(Date.now() / 1000)
): TimelockPlan => {
  const problem = dateProblem(value, nowSeconds)
  if (problem) throw new Error(problem)
  if (!isPositiveInt(amountMsat) || typeof mint !== 'string' || !mint) {
    throw new Error('Pick a note to lock first.')
  }
  const locktime = dateToLocktime(value)!

  const secretKey = hexToBytes(generateKeypair().secretKeyHex)
  const pubkeyHex = bytesToHex(schnorr.getPublicKey(secretKey))
  const script = scriptTemplateById('cltv')!.build({
    pubkeyHex,
    pubkey2Hex: '',
    hashHex: '',
    locktime
  })
  const outputKeyHex = tweakPubkey(NUMS_INTERNAL_KEY_HEX, [
    script
  ]).tweakedPubkeyHex
  const [proof] = scriptPathProofs(hexToBytes(NUMS_INTERNAL_KEY_HEX), [script])
  // refuse to hand out a plan unless it demonstrably commits to the key the
  // note is about to be locked to - a burn is about to be justified by this
  if (!proof || !verifyScriptPath(outputKeyHex, proof)) {
    throw new Error('Internal error: the timelock proof does not verify.')
  }

  // sign LUD-25's canonical spend transaction (src/lib/spend.ts) - this
  // leaf's Q as the spent output, this note's mint as the domain, this exact
  // locktime/sequence
  const sig = signScriptPathSpend(
    bytesToHex(secretKey),
    NUMS_INTERNAL_KEY_HEX,
    [script],
    script,
    mint,
    locktime,
    TIMELOCK_SEQUENCE
  )

  const cw1 = encodeCw1({
    locktime,
    sequence: TIMELOCK_SEQUENCE,
    script: proof.script,
    controlBlock: proof.controlBlock,
    witness: [sig]
  })
  return {locktime, outputKeyHex, cw1}
}

export const formatUnlock = (locktime: unknown): string => {
  const n = Number(locktime)
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toLocaleString() : '-'
}
