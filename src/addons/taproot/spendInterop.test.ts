// Cross-implementation interop vectors for LUD-25 spends (ck1 / cw1).
//
// Everything that reaches a vector comes from THIS wallet's own code - its
// script templates, tweakPubkey, scriptPathProofs, encodeCp1/encodeCw1,
// signNoteOwnership - with script-path signing delegated to
// @scure/btc-signer's own transaction code (a separate implementation of the
// canonical spend transaction from src/lib/spend.ts, and checked against it
// here). The vectors are then consumed by lnurlcashkernel, which hands them
// to Bitcoin Core's own script interpreter: wallet on one side, Core on the
// other, nothing shared between them but the wire format.
//
// Regenerate the kernel-side fixture with:
//   SPEND_VECTORS_OUT=../lnurlcashkernel/tests/vectors/wallet_spend_vectors.json \
//     npx vitest run src/addons/taproot/spendInterop.test.ts
import {describe, expect, it} from 'vitest'
import {writeFileSync} from 'node:fs'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {schnorr} from '@noble/curves/secp256k1.js'
import {Transaction, p2tr} from '@scure/btc-signer'

import {
  encodeCp1,
  encodeCk1,
  encodeCw1,
  decodeCw1
} from '../../lib/recoverableNotes'
import {scriptPathSighash, spendPrevout} from '../../lib/spend'
import {signNoteOwnership} from '../../lib/signature'
import {
  scriptTemplateById,
  scriptPathProofs,
  tweakPubkey,
  verifyScriptPath,
  type ScriptTemplateId
} from './taproot'
import {attest} from '../dlc/dlc'
import {
  planBet,
  betReceiptUrl,
  parseBetReceipt,
  buildRedeemCw1
} from '../betlocker/betlock'
import {genesisState, planSealLock, redeemCurrentStateCw1} from '../seals/seals'

const AMOUNT_MSAT = 20_000_000
// every signature below is bound to this mint (see src/lib/spend.ts)
const DOMAIN = 'mint.example.com'
const LOCK = 1_800_000_000
const LOCKED_AT = 1_700_000_000
const CSV_SEQUENCE = (1 << 22) | 4 // BIP68 time-based, 4 * 512 s

const internalSk = hexToBytes('11'.repeat(32))
const ownerSk = hexToBytes('22'.repeat(32))
const otherSk = hexToBytes('33'.repeat(32))
const internalHex = bytesToHex(schnorr.getPublicKey(internalSk))
const ownerHex = bytesToHex(schnorr.getPublicKey(ownerSk))
const otherHex = bytesToHex(schnorr.getPublicKey(otherSk))
const PREIMAGE = new TextEncoder().encode('correct horse battery staple')

type Case = {
  name: string
  template: ScriptTemplateId
  params: {locktime: number}
  locktime: number
  sequence: number
  signers: Uint8Array[]
  // extra witness items sitting ABOVE the signatures
  extra: Uint8Array[]
  // what the mint's clock must be for this spend to be honoured
  now: number
  expectKind: string
}

const CASES: Case[] = [
  {
    name: 'pk',
    template: 'pk',
    params: {locktime: 0},
    locktime: 0,
    sequence: 0xfffffffe,
    signers: [ownerSk],
    extra: [],
    now: LOCKED_AT,
    expectKind: 'pk'
  },
  {
    name: 'cltv',
    template: 'cltv',
    params: {locktime: LOCK},
    locktime: LOCK,
    sequence: 0xfffffffe,
    signers: [ownerSk],
    extra: [],
    now: LOCK + 1,
    expectKind: 'cltv'
  },
  {
    name: 'csv',
    template: 'csv',
    params: {locktime: CSV_SEQUENCE},
    locktime: 0,
    sequence: CSV_SEQUENCE,
    signers: [ownerSk],
    extra: [],
    now: LOCKED_AT + 2048,
    expectKind: 'csv'
  },
  {
    name: 'hashlock',
    template: 'hashlock',
    params: {locktime: 0},
    locktime: 0,
    sequence: 0xfffffffe,
    signers: [ownerSk],
    extra: [PREIMAGE],
    now: LOCKED_AT,
    expectKind: 'hashlock'
  },
  {
    name: 'multisig2',
    template: 'multisig2',
    params: {locktime: 0},
    locktime: 0,
    sequence: 0xfffffffe,
    signers: [ownerSk, otherSk],
    extra: [],
    now: LOCKED_AT,
    expectKind: 'multisig2'
  }
]

const buildVector = (c: Case) => {
  const leaf = scriptTemplateById(c.template)!.build({
    pubkeyHex: ownerHex,
    pubkey2Hex: otherHex,
    hashHex: bytesToHex(sha256(PREIMAGE)),
    locktime: c.params.locktime
  })

  // wallet-side: output key, proof, and wire values
  const {tweakedPubkeyHex} = tweakPubkey(internalHex, [leaf])
  const [proof] = scriptPathProofs(hexToBytes(internalHex), [leaf])
  expect(verifyScriptPath(tweakedPubkeyHex, proof!)).toBe(true)

  // signing: btc-signer builds the CANONICAL spend transaction (see
  // lnurlcashkernel/verify.py) and signs the script path
  const tree = p2tr(
    schnorr.getPublicKey(internalSk),
    [{script: leaf}],
    undefined,
    true
  )
  expect(bytesToHex(tree.tweakedPubkey)).toBe(tweakedPubkeyHex)
  // the canonical spend transaction: prevout bound to the mint's domain
  // (btc-signer serializes a txid byte-reversed, so hand it the reverse),
  // spent output worth 0
  const tx = new Transaction({
    version: 2,
    lockTime: c.locktime,
    allowUnknownOutputs: true
  })
  tx.addInput({
    txid: spendPrevout(DOMAIN).slice().reverse(),
    index: 0,
    sequence: c.sequence,
    witnessUtxo: {script: tree.script, amount: 0n},
    tapLeafScript: tree.tapLeafScript
  })
  tx.addOutput({script: new Uint8Array(0), amount: 0n})
  for (const sk of c.signers) tx.signIdx(sk, 0)

  // The signatures come from btc-signer either way. Its finalizer only knows
  // some leaf shapes, so read the signatures back and assemble the witness
  // ourselves - the stack is bottom-to-top: signatures (the LAST key's first),
  // then leaf-specific items, which the script consumes first.
  const input = tx.getInput(0) as {
    tapScriptSig?: [{pubKey: Uint8Array}, Uint8Array][]
  }
  const sigByPubkey = new Map(
    (input.tapScriptSig ?? []).map(([k, sig]) => [bytesToHex(k.pubKey), sig])
  )
  const signerPubkeys = c.signers.map(sk =>
    bytesToHex(schnorr.getPublicKey(sk))
  )
  const sigs = signerPubkeys.map(pk => sigByPubkey.get(pk)!)
  expect(sigs.every(Boolean)).toBe(true)
  // btc-signer's sighash and the kit's own (src/lib/spend.ts) must agree
  const kitSighash = scriptPathSighash(
    hexToBytes(tweakedPubkeyHex),
    DOMAIN,
    leaf,
    c.locktime,
    c.sequence
  )
  signerPubkeys.forEach((pk, i) =>
    expect(schnorr.verify(sigs[i]!, kitSighash, hexToBytes(pk))).toBe(true)
  )
  const witness = [...[...sigs].reverse(), ...c.extra]

  const cw1 = encodeCw1({
    locktime: c.locktime,
    sequence: c.sequence,
    script: proof!.script,
    controlBlock: proof!.controlBlock,
    witness
  })
  expect(decodeCw1(cw1)).toEqual({
    locktime: c.locktime,
    sequence: c.sequence,
    script: proof!.script,
    controlBlock: proof!.controlBlock,
    witness
  })

  return {
    name: c.name,
    cp1: encodeCp1(hexToBytes(tweakedPubkeyHex)),
    output_key: tweakedPubkeyHex,
    leaf_script: bytesToHex(proof!.script),
    control_block: bytesToHex(proof!.controlBlock),
    witness: witness.map(bytesToHex),
    locktime: c.locktime,
    sequence: c.sequence,
    spend: cw1,
    domain: DOMAIN,
    locked_at: LOCKED_AT,
    now: c.now
  }
}

// Betlocker's own counterparty-bound leaf (optional pubkey binding - see
// betlock.ts's own top comment) - a multisig2 leaf built the same way the
// generic CASES above are, but through betlock.ts's REAL functions
// (planBet -> betReceiptUrl -> parseBetReceipt -> buildRedeemCw1) end to
// end, not the low-level template directly, so this actually exercises
// this addon's own witness-ordering wiring, not just multisig2 the
// template in isolation (already covered by the 'multisig2' case above).
const asKeypair = (secretKeyHex: string) => ({
  secretKeyHex,
  pubkeyHex: bytesToHex(schnorr.getPublicKey(hexToBytes(secretKeyHex)))
})

const buildBetlockerCounterpartyVector = () => {
  // fixed, deterministic keys (same convention as internalSk/ownerSk/
  // otherSk above) - a reproducible, reviewable committed fixture, not a
  // fresh random vector on every regeneration
  const oracle = asKeypair('44'.repeat(32))
  const nonce = asKeypair('55'.repeat(32))
  const counterparty = asKeypair('66'.repeat(32))
  const outcomes = ['yes', 'no']

  // a fixed, far-future, UTC-suffixed date string - dateToLocktime just
  // needs anything Date-parseable, and the explicit 'Z' keeps this
  // reproducible regardless of the test runner's own local timezone
  // (unlike a real <input type="datetime-local"> value, which never has
  // one - fine here, since only the resulting unix time matters)
  const plan = planBet(
    oracle.pubkeyHex,
    nonce.pubkeyHex,
    outcomes,
    AMOUNT_MSAT,
    '2030-01-01T00:00:00Z',
    DOMAIN,
    undefined,
    undefined,
    counterparty.pubkeyHex
  )
  const lockedNote = {
    urlTemplate: `https://${DOMAIN}/w`,
    amountMsat: AMOUNT_MSAT,
    signature: 'deadbeef'.repeat(16),
    groupPubkeyHex: plan.outputKeyHex
  }
  const receiptUrl = betReceiptUrl(lockedNote, plan)!
  const receipt = parseBetReceipt(receiptUrl)!
  expect(receipt.counterpartyPubkeyHex).toBe(counterparty.pubkeyHex)

  const attestation = attest(oracle.secretKeyHex, nonce.secretKeyHex, 'yes')
  const cw1 = buildRedeemCw1(receipt, attestation, counterparty.secretKeyHex)
  const decoded = decodeCw1(cw1)!
  expect(decoded.witness).toHaveLength(2) // both signatures present

  return {
    name: 'betlocker-counterparty-multisig2',
    cp1: encodeCp1(hexToBytes(plan.outputKeyHex)),
    output_key: plan.outputKeyHex,
    leaf_script: bytesToHex(decoded.script),
    control_block: bytesToHex(decoded.controlBlock),
    witness: decoded.witness.map(bytesToHex),
    locktime: decoded.locktime,
    sequence: decoded.sequence,
    spend: cw1,
    domain: DOMAIN,
    locked_at: LOCKED_AT,
    now: LOCKED_AT
  }
}

// Betlocker's own MANDATORY refund leaf (see betlock.ts's own top comment)
// - planBet eagerly signs this one itself (the throwaway key IS known
// immediately, unlike an outcome leaf), so this vector's own "redemption"
// is just decoding plan.refundCw1 straight out, same as timelocker's own
// single-leaf cw1. `now` is deliberately set just PAST its own locktime -
// the positive case the generic parametrized mint tests already cover;
// CLTV's own "refused before locktime" mechanics are independently proven
// by the standalone 'cltv' case above, not re-proven per addon here.
const buildBetlockerRefundVector = () => {
  const oracle = asKeypair('77'.repeat(32))
  const nonce = asKeypair('88'.repeat(32))
  const refundDate = '2031-06-15T00:00:00Z'

  const plan = planBet(
    oracle.pubkeyHex,
    nonce.pubkeyHex,
    ['yes', 'no'],
    AMOUNT_MSAT,
    refundDate,
    DOMAIN
  )
  const decoded = decodeCw1(plan.refundCw1)!
  expect(decoded.witness).toHaveLength(1)
  expect(
    verifyScriptPath(plan.outputKeyHex, {
      script: decoded.script,
      controlBlock: decoded.controlBlock
    })
  ).toBe(true)

  return {
    name: 'betlocker-refund-cltv',
    cp1: encodeCp1(hexToBytes(plan.outputKeyHex)),
    output_key: plan.outputKeyHex,
    leaf_script: bytesToHex(decoded.script),
    control_block: bytesToHex(decoded.controlBlock),
    witness: decoded.witness.map(bytesToHex),
    locktime: decoded.locktime,
    sequence: decoded.sequence,
    spend: plan.refundCw1,
    domain: DOMAIN,
    locked_at: LOCKED_AT,
    now: decoded.locktime + 1
  }
}

// The Seals addon's own genesis leaf - built through seals.ts's real
// functions end to end (genesisState -> planSealLock -> the taproot
// addon's own EXISTING `hashlock` template -> redeemCurrentStateCw1),
// proving Seals' own new code (its canonical state encoding in
// particular - encodeSealState is new, unlike the already-proven
// hashlock template itself) produces a witness Bitcoin Core genuinely
// accepts, not just one that looks right by analogy to the standalone
// 'hashlock' case above.
const buildSealsVector = () => {
  const owner = asKeypair('99'.repeat(32))
  const state = genesisState(
    'Provenance Test #1',
    'a real test asset',
    owner.pubkeyHex
  )
  const {outputKeyHex} = planSealLock(state)
  const cw1 = redeemCurrentStateCw1(state, owner.secretKeyHex, DOMAIN)
  const decoded = decodeCw1(cw1)!
  expect(decoded.witness).toHaveLength(2)
  expect(
    verifyScriptPath(outputKeyHex, {
      script: decoded.script,
      controlBlock: decoded.controlBlock
    })
  ).toBe(true)

  return {
    name: 'seals-genesis-hashlock',
    cp1: encodeCp1(hexToBytes(outputKeyHex)),
    output_key: outputKeyHex,
    leaf_script: bytesToHex(decoded.script),
    control_block: bytesToHex(decoded.controlBlock),
    witness: decoded.witness.map(bytesToHex),
    locktime: decoded.locktime,
    sequence: decoded.sequence,
    spend: cw1,
    domain: DOMAIN,
    locked_at: LOCKED_AT,
    now: LOCKED_AT
  }
}

// A key-path spend (ck1): the note's Q is the owner's own key, signed by
// this wallet's own signNoteOwnership over the key-path sighash.
const buildKeyPathVector = () => {
  const {pubkeyXOnly, signature} = signNoteOwnership(ownerSk, DOMAIN)
  return {
    name: 'key',
    cp1: encodeCp1(pubkeyXOnly),
    output_key: bytesToHex(pubkeyXOnly),
    spend: encodeCk1(pubkeyXOnly, signature),
    domain: DOMAIN,
    locked_at: LOCKED_AT,
    now: LOCKED_AT
  }
}

describe('spend interop vectors (wallet -> lnurlcashkernel -> Bitcoin Core)', () => {
  const vectors = [
    buildKeyPathVector(),
    ...CASES.map(buildVector),
    buildBetlockerCounterpartyVector(),
    buildBetlockerRefundVector(),
    buildSealsVector()
  ]

  it('builds a vector for every supported leaf shape', () => {
    expect(vectors.map(v => v.name)).toEqual([
      'key',
      ...CASES.map(c => c.name),
      'betlocker-counterparty-multisig2',
      'betlocker-refund-cltv',
      'seals-genesis-hashlock'
    ])
    for (const v of vectors) {
      expect(v.cp1.startsWith('cp1')).toBe(true)
      expect(v.spend.startsWith(v.name === 'key' ? 'ck1' : 'cw1')).toBe(true)
    }
  })

  it('writes them out when SPEND_VECTORS_OUT is set', () => {
    const out = process.env.SPEND_VECTORS_OUT
    if (!out) return
    writeFileSync(
      out,
      JSON.stringify(
        {
          note: 'Generated by lnurl-wallet src/addons/taproot/spendInterop.test.ts - do not edit by hand.',
          vectors
        },
        null,
        2
      ) + '\n'
    )
  })
})
