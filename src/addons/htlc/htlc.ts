// Pure math behind the HTLC addon: a note locked to a note with two leaves -
// a hashlock CLAIM leaf (spendable by whoever can produce the sha256
// preimage of a hash AND sign with a named claimant's own key) and a
// mandatory cltv REFUND leaf (spendable by the original locker after a
// deadline) - see timelock.ts's own top comment for the general "cp1/cw1
// note lock" shape this reuses byte-for-byte, and the sibling betlocker
// addon for the closest existing two-leaf-tree precedent (outcome leaf +
// mandatory refund leaf).
//
// This is the standalone Hash-Time-Locked Contract SHAPE (the taproot
// addon's own `hashlock` template docstring: "the shape an HTLC leaf
// takes") - not a Lightning CHANNEL's in-flight HTLC, which lnurlcash has
// no equivalent of at all (this wallet never holds a commitment
// transaction; see the research write-up this addon follows from). The
// preimage/hash pair here plays the same role a real cross-hop payment's
// preimage does: whoever first reveals it (by claiming) proves they were
// meant to, and revealing it is the entire point of building one of these
// at all - e.g. linking this note's release to some OTHER condition that
// also reveals the same preimage (a submarine swap's onchain leg, another
// HTLC elsewhere), or simply handing the secret to a specific counterparty
// out of band once some condition is met.
//
// Two-step flow, same shape as betlocker's own LOCK/REDEEM split:
//   1. LOCK (planHtlc) - pick a note, generate (or paste) a preimage/hash
//      pair, name a claimant's real pubkey (resolved via the shared
//      note.resolveAddressPubkey verb, same as betlocker's counterparty
//      flow - NOT optional here, unlike betlocker's race-to-claim default,
//      since a bare hashlock-only leaf with no key would be a public
//      bearer secret the instant it's shared, same as a plain Part-1
//      preimage note - the whole point of pairing it with CHECKSIG is
//      restricting redemption to one named party who ALSO needs the
//      secret). htlcReceiptUrl then builds the shareable link - hash and
//      claim pubkey are both public the moment the leaf is locked (they're
//      committed into the taproot output key itself), so neither needs
//      hiding; the PREIMAGE is deliberately never included and must reach
//      the claimant some other way.
//   2. CLAIM (buildClaimCw1) - the claimant supplies the preimage (however
//      they came to hold it) and their own secret key, matching both
//      against what the receipt committed to, and signs the canonical
//      spend (signScriptPathSpend, shared with timelocker/betlocker).
//
// Every lock also carries the same mandatory refund leaf betlocker/
// timelocker already use - a throwaway key generated and eagerly signed at
// LOCK time, so the original locker can always reclaim after their own
// deadline if the claimant never produces the preimage. refundCw1 is the
// one genuinely SECRET output of planHtlc - see HtlcPlan's own doc comment.
//
// Everything here is synchronous (see taproot.ts's own note on why a
// helper bound to a live Text/set must not return a Promise).
import {schnorr} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, randomBytes} from '@noble/hashes/utils.js'
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
import {
  dateProblem,
  dateToLocktime,
  TIMELOCK_SEQUENCE
} from '../timelocker/timelock'
export {
  dateProblem as refundDateProblem,
  formatUnlock
} from '../timelocker/timelock'

const isPositiveInt = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n > 0

const isU32 = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 0xffffffff

const isHex32 = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v.trim())

// a fresh 32-byte secret and its sha256 hash, for the "generate one up
// front" flow - a holder can also paste in a hash/preimage pair produced
// elsewhere (e.g. one already committed onchain by a counterparty)
export const generatePreimage = (): {preimageHex: string; hashHex: string} => {
  const preimage = randomBytes(32)
  return {
    preimageHex: bytesToHex(preimage),
    hashHex: bytesToHex(sha256(preimage))
  }
}

// '' when claimPubkeyHex is a usable 32-byte x-only pubkey, else why not -
// mandatory here (see this file's own top comment), unlike betlocker's
// optional counterpartyProblem
export const claimPubkeyProblem = (claimPubkeyHex: unknown): string => {
  const trimmed = String(claimPubkeyHex ?? '').trim()
  if (!trimmed) return 'Name who can claim this once they have the preimage.'
  return isHex32(trimmed)
    ? ''
    : 'Not a valid 32-byte x-only pubkey - resolve it from an address first.'
}

// '' when (hashHex, claimPubkeyHex) are usable, else the reason they
// aren't - the live validation message shown before "Prepare lock" enables
export const htlcProblem = (
  hashHex: unknown,
  claimPubkeyHex: unknown
): string => {
  if (!isHex32(hashHex)) return 'Generate or paste a hash first.'
  return claimPubkeyProblem(claimPubkeyHex)
}

const claimLeafFor = (hashHex: string, claimPubkeyHex: string): Uint8Array => {
  const compiled = compileLeaf('hashlock', {
    pubkeyHex: claimPubkeyHex,
    pubkey2Hex: '',
    hashHex,
    locktime: 0
  })
  if (!compiled) throw new Error('Could not compile the claim leaf.')
  return hexToBytes(compiled.scriptHex)
}

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

// the FULL two-leaf tree behind an HTLC lock - claim leaf first, refund
// leaf second, a fixed order both planHtlc (building it) and buildClaimCw1
// (reconstructing it to redeem the claim leaf) must agree on, or their
// merkle proofs won't match what was actually locked
const htlcLeavesFor = (
  hashHex: string,
  claimPubkeyHex: string,
  refundPubkeyHex: string,
  refundLocktime: number
): Uint8Array[] => [
  claimLeafFor(hashHex, claimPubkeyHex),
  refundLeafFor(refundPubkeyHex, refundLocktime)
]

// self-contained, like the sibling timelocker/betlocker addons' own plan
// types
export type HtlcPlan = {
  outputKeyHex: string
  hashHex: string
  claimPubkeyHex: string
  // the mandatory refund leaf - PUBLIC, needed by anyone reconstructing
  // this lock's own leaf tree
  refundPubkeyHex: string
  refundLocktime: number
  // SECRET - a fully-signed, ready-to-claim cw1 for the refund leaf alone
  // (see betlocker's BetPlan.refundCw1 for the identical reasoning): must
  // be added to the LOCKER's OWN wallet right after locking and never
  // included in htlcReceiptUrl's output
  refundCw1: string
}

// Deliberately NOT idempotent - every call draws a fresh refund keypair
// and a fresh signature, so (same rule as planTimelock/planBet) it must
// only ever run from a one-shot `set` action, never a live Text binding.
export const planHtlc = (
  hashHex: unknown,
  claimPubkeyHex: unknown,
  amountMsat: unknown,
  refundDate: unknown,
  mint: unknown,
  nowSeconds = Math.floor(Date.now() / 1000)
): HtlcPlan => {
  const problem = htlcProblem(hashHex, claimPubkeyHex)
  if (problem) throw new Error(problem)
  if (!isPositiveInt(amountMsat) || typeof mint !== 'string' || !mint) {
    throw new Error('Pick a note to lock first.')
  }
  const refundProblem = dateProblem(refundDate, nowSeconds)
  if (refundProblem) throw new Error(refundProblem)
  const refundLocktime = dateToLocktime(refundDate)!

  const hash = String(hashHex).trim().toLowerCase()
  const claimPubkey = String(claimPubkeyHex).trim().toLowerCase()

  const refundSecretKey = hexToBytes(generateKeypair().secretKeyHex)
  const refundPubkeyHex = bytesToHex(schnorr.getPublicKey(refundSecretKey))

  const leaves = htlcLeavesFor(
    hash,
    claimPubkey,
    refundPubkeyHex,
    refundLocktime
  )
  const outputKeyHex = tweakPubkey(
    NUMS_INTERNAL_KEY_HEX,
    leaves
  ).tweakedPubkeyHex
  const proofs = scriptPathProofs(hexToBytes(NUMS_INTERNAL_KEY_HEX), leaves)
  for (const proof of proofs) {
    if (!verifyScriptPath(outputKeyHex, proof)) {
      throw new Error('Internal error: a leaf proof does not verify.')
    }
  }

  const refundScript = leaves[1]!
  const refundProof = proofs[1]!
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

  return {
    outputKeyHex,
    hashHex: hash,
    claimPubkeyHex: claimPubkey,
    refundPubkeyHex,
    refundLocktime,
    refundCw1
  }
}

export const htlcReceiptUrl = (
  lockedNote: unknown,
  plan: unknown
): string | null => {
  const locked = lockedNote as {
    urlTemplate: string
    amountMsat: number
    signature: string
    groupPubkeyHex: string
  } | null
  const p = plan as HtlcPlan | null
  if (!locked || !p || locked.groupPubkeyHex !== p.outputKeyHex) return null
  try {
    const url = new URL(
      withoutK1(locked.urlTemplate, locked.amountMsat, locked.signature)
    )
    // plain query params, not a bech32m envelope like betlocker's cd1 -
    // this lock's field set is small and fixed (no variable-length
    // outcomes list to pack), so the extra codec would be pure overhead
    url.searchParams.set('hash', p.hashHex)
    url.searchParams.set('claim', p.claimPubkeyHex)
    url.searchParams.set('refundPubkey', p.refundPubkeyHex)
    url.searchParams.set('refundLocktime', String(p.refundLocktime))
    return url.toString()
  } catch {
    return null
  }
}

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
  const p = plan as HtlcPlan | null
  if (!locked || !p || locked.groupPubkeyHex !== p.outputKeyHex) return null
  try {
    return withNewK1(locked.urlTemplate, p.refundCw1, locked.amountMsat)
  } catch {
    return null
  }
}

export type HtlcReceipt = {
  urlTemplate: string
  amountMsat: number
  hashHex: string
  claimPubkeyHex: string
  refundPubkeyHex: string
  refundLocktime: number
}

export const parseHtlcReceipt = (value: unknown): HtlcReceipt | null => {
  try {
    const url = new URL(String(value ?? '').trim())
    const amountRaw = url.searchParams.get('amount')
    const hashHex = url.searchParams.get('hash')?.toLowerCase() ?? ''
    const claimPubkeyHex = url.searchParams.get('claim')?.toLowerCase() ?? ''
    const refundPubkeyHex =
      url.searchParams.get('refundPubkey')?.toLowerCase() ?? ''
    const refundLocktimeRaw = url.searchParams.get('refundLocktime')
    if (
      !amountRaw ||
      !hashHex ||
      !claimPubkeyHex ||
      !refundPubkeyHex ||
      !refundLocktimeRaw
    ) {
      return null
    }
    const amountMsat = Number(amountRaw)
    const refundLocktime = Number(refundLocktimeRaw)
    if (!isPositiveInt(amountMsat)) return null
    if (
      !isHex32(hashHex) ||
      !isHex32(claimPubkeyHex) ||
      !isHex32(refundPubkeyHex)
    ) {
      return null
    }
    if (!isU32(refundLocktime)) return null
    url.searchParams.delete('amount')
    url.searchParams.delete('sig')
    url.searchParams.delete('hash')
    url.searchParams.delete('claim')
    url.searchParams.delete('refundPubkey')
    url.searchParams.delete('refundLocktime')
    return {
      urlTemplate: url.toString(),
      amountMsat,
      hashHex,
      claimPubkeyHex,
      refundPubkeyHex,
      refundLocktime
    }
  } catch {
    return null
  }
}

// what a receipt says about itself, live while typing/pasting - '' when
// usable, else why not
export const receiptProblem = (value: unknown): string => {
  const text = String(value ?? '').trim()
  if (!text) return 'Paste an HTLC receipt first.'
  return parseHtlcReceipt(text) ? '' : 'That doesn’t look like an HTLC receipt.'
}

// '' when preimageHex hashes to the receipt's own hash, else why not - the
// live validation message shown before "Claim" enables
export const preimageProblem = (
  preimageHex: unknown,
  hashHex: unknown
): string => {
  const trimmed = String(preimageHex ?? '')
    .trim()
    .toLowerCase()
  if (!isHex32(trimmed)) return 'Enter the 32-byte preimage first.'
  if (!isHex32(hashHex)) return 'No hash to check the preimage against.'
  const actual = bytesToHex(sha256(hexToBytes(trimmed)))
  return actual === String(hashHex).trim().toLowerCase()
    ? ''
    : 'That preimage does not hash to this lock’s own commitment.'
}

// Builds the note's real, ready-to-spend k1 from a receipt, a preimage,
// and the claimant's own secret key - the output of the whole flow. Throws
// with a specific, user-facing reason on anything that doesn't check out.
export const buildClaimCw1 = (
  receipt: HtlcReceipt,
  preimageHex: string,
  claimSecretKeyHex: string
): string => {
  const preimage = String(preimageHex ?? '')
    .trim()
    .toLowerCase()
  const problem = preimageProblem(preimage, receipt.hashHex)
  if (problem) throw new Error(problem)

  const claimSecret = String(claimSecretKeyHex ?? '')
    .trim()
    .toLowerCase()
  if (!isHex32(claimSecret)) {
    throw new Error('Enter the claimant’s own secret key to claim this.')
  }
  const derivedPubkeyHex = bytesToHex(
    schnorr.getPublicKey(hexToBytes(claimSecret))
  )
  if (derivedPubkeyHex !== receipt.claimPubkeyHex) {
    throw new Error(
      'That secret key does not match this lock’s own named claimant pubkey.'
    )
  }

  const leaves = htlcLeavesFor(
    receipt.hashHex,
    receipt.claimPubkeyHex,
    receipt.refundPubkeyHex,
    receipt.refundLocktime
  )
  const targetScript = leaves[0]!
  const proofs = scriptPathProofs(hexToBytes(NUMS_INTERNAL_KEY_HEX), leaves)
  const proof = proofs[0]
  if (!proof) throw new Error('Internal error: no proof for the claim leaf.')

  const sig = signScriptPathSpend(
    claimSecret,
    NUMS_INTERNAL_KEY_HEX,
    leaves,
    targetScript,
    receipt.urlTemplate,
    0,
    0xfffffffe
  )
  // [signature, preimage]: the claim leaf is `SHA256 <hash> EQUALVERIFY
  // <pubkey> CHECKSIG` - script execution consumes the TOP of the initial
  // witness stack first (SHA256's own input), so the preimage must be the
  // LAST witness item and the signature the one below it - see this file's
  // own header comment for why this differs from betlocker's multisig2
  // "reverse pubkey order" convention (a different script shape entirely)
  return encodeCw1({
    locktime: 0,
    sequence: 0xfffffffe,
    script: proof.script,
    controlBlock: proof.controlBlock,
    witness: [sig, hexToBytes(preimage)]
  })
}
