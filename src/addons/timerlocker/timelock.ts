// Pure math behind the timerlocker addon: a note locked to a ct1 whose ONLY
// spend path is one Tapscript leaf, the stock `cltv` template
//
//   <unix time> OP_CHECKLOCKTIMEVERIFY OP_DROP <pubkey> OP_CHECKSIG
//
// (lnurlcashkernel accepts a fixed set of leaf shapes - a keyless
// "<t> CLTV DROP 1" leaf is refused outright, see its README - so the lock
// needs a key, and redeeming needs a signature from it.)
//
// The lock's whole state is one *timelock secret*: 32 bytes of Schnorr secret
// key || 4 bytes big-endian unlock time, as 72 hex characters. Everything else
// (leaf, control block, output key Q) is derived from it, and the redeem-time
// cw1 (with its signature) is built from it. Whoever holds the secret can
// redeem once the mint's clock passes the time - a bearer note, like a k1.
//
// The taproot INTERNAL key is BIP341's NUMS point H (no known discrete log),
// so the key-path is provably unspendable: no early ck1 spend, by anyone, this
// wallet included. The leaf is the only way out, and the mint refuses it until
// its own clock passes `locktime` (a custodial policy, not a consensus proof).
//
// Everything here is synchronous (see taproot.ts's note on why a helper bound
// to a live Text/set must not return a Promise).
import {Transaction, p2tr} from '@scure/btc-signer'
import {schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {encodeCw1} from '../../lib/recoverableNotes'
import {
  generateKeypair,
  scriptPathProofs,
  scriptTemplateById,
  tweakPubkey,
  verifyScriptPath
} from '../taproot/taproot'

// BIP341's "nothing up my sleeve" internal key
export const NUMS_INTERNAL_KEY_HEX =
  '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0'

// BIP65: below this a CLTV number is a block height, at/above it a unix time
export const LOCKTIME_THRESHOLD = 500_000_000
const U32_MAX = 0xffffffff
// nSequence must not be final (0xffffffff) for CLTV to be enforceable
export const TIMELOCK_SEQUENCE = 0xfffffffe
// a lock that unlocks within a minute is a mistake, not a timelock
const MIN_LEAD_SECONDS = 60

export type TimelockPlan = {
  locktime: number
  outputKeyHex: string
  // 72 hex chars: secret key || u32 unlock time - the bearer secret
  secret: string
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

const encodeSecret = (secretKey: Uint8Array, locktime: number): string => {
  const tail = new Uint8Array(4)
  new DataView(tail.buffer).setUint32(0, locktime, false)
  return bytesToHex(secretKey) + bytesToHex(tail)
}

type Derived = {
  locktime: number
  secretKey: Uint8Array
  script: Uint8Array
  controlBlock: Uint8Array
  outputKeyHex: string
}

// everything a secret commits to, or null if it is malformed. Also proves the
// (script, control block) really commits to Q, so a caller never acts on a
// derivation that would lock funds to a key it can't open
const derive = (secretHex: unknown): Derived | null => {
  const text = String(secretHex ?? '')
    .trim()
    .toLowerCase()
  if (!/^[0-9a-f]{72}$/.test(text)) return null
  try {
    const secretKey = hexToBytes(text.slice(0, 64))
    const locktime = new DataView(hexToBytes(text.slice(64)).buffer).getUint32(
      0,
      false
    )
    if (locktime < LOCKTIME_THRESHOLD || locktime >= TIMELOCK_SEQUENCE) {
      return null
    }
    const script = scriptTemplateById('cltv')!.build({
      pubkeyHex: bytesToHex(schnorr.getPublicKey(secretKey)),
      pubkey2Hex: '',
      hashHex: '',
      locktime
    })
    const outputKeyHex = tweakPubkey(NUMS_INTERNAL_KEY_HEX, [
      script
    ]).tweakedPubkeyHex
    const [proof] = scriptPathProofs(hexToBytes(NUMS_INTERNAL_KEY_HEX), [
      script
    ])
    if (!proof || !verifyScriptPath(outputKeyHex, proof)) return null
    return {
      locktime,
      secretKey,
      script,
      controlBlock: proof.controlBlock,
      outputKeyHex
    }
  } catch {
    return null
  }
}

// Deliberately NOT idempotent: every call draws a fresh key, so it must only
// ever run from a one-shot `set` action (a Button), never from a live Text
// binding that re-evaluates on every render.
export const planTimelock = (
  value: unknown,
  nowSeconds = Math.floor(Date.now() / 1000)
): TimelockPlan => {
  const problem = dateProblem(value, nowSeconds)
  if (problem) throw new Error(problem)
  const locktime = dateToLocktime(value)!
  const secret = encodeSecret(
    hexToBytes(generateKeypair().secretKeyHex),
    locktime
  )
  const derived = derive(secret)
  if (!derived) throw new Error('Internal error: could not derive the lock.')
  return {locktime, outputKeyHex: derived.outputKeyHex, secret}
}

// the ct1 output key a secret locks to, null if malformed
export const outputKeyOfSecret = (secret: unknown): string | null =>
  derive(secret)?.outputKeyHex ?? null

// when a secret becomes redeemable, unix seconds, null if malformed
export const unlockTimeOfSecret = (secret: unknown): number | null =>
  derive(secret)?.locktime ?? null

// The cw1 that redeems a note of `amountMsat` (the mint's own figure): the
// leaf, its control block, the claimed locktime/sequence, and one Schnorr
// signature over the BIP341 sighash of lnurlcashkernel's canonical spend
// transaction - the amount is part of what is signed, so it must be the
// note's real value. Throws on a malformed secret.
export const buildRedeemCw1 = (secret: unknown, amountMsat: number): string => {
  const d = derive(secret)
  if (!d) throw new Error('That timelock secret is malformed.')
  const tree = p2tr(
    hexToBytes(NUMS_INTERNAL_KEY_HEX),
    [{script: d.script}],
    undefined,
    true
  )
  const tx = new Transaction({
    version: 2,
    lockTime: d.locktime,
    allowUnknownOutputs: true
  })
  tx.addInput({
    txid: new Uint8Array(32),
    index: 0,
    sequence: TIMELOCK_SEQUENCE,
    witnessUtxo: {script: tree.script, amount: BigInt(amountMsat)},
    tapLeafScript: tree.tapLeafScript
  })
  tx.addOutput({script: new Uint8Array(0), amount: 0n})
  tx.signIdx(d.secretKey, 0)
  const input = tx.getInput(0) as {
    tapScriptSig?: [{pubKey: Uint8Array}, Uint8Array][]
  }
  const pubkeyHex = bytesToHex(schnorr.getPublicKey(d.secretKey))
  const sig = (input.tapScriptSig ?? []).find(
    ([k]) => bytesToHex(k.pubKey) === pubkeyHex
  )?.[1]
  if (!sig) throw new Error('Could not sign the timelock spend.')
  return encodeCw1({
    locktime: d.locktime,
    sequence: TIMELOCK_SEQUENCE,
    script: d.script,
    controlBlock: d.controlBlock,
    witness: [sig]
  })
}

export const formatUnlock = (locktime: unknown): string => {
  const n = Number(locktime)
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toLocaleString() : '-'
}

// the secret out of a timelocked note link's `tl` query param, or ''
export const secretOfLink = (link: unknown): string => {
  try {
    return new URL(String(link ?? '').trim()).searchParams.get('tl') ?? ''
  } catch {
    return ''
  }
}
