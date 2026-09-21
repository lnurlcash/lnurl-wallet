// Cross-implementation interop vectors for ct1/cw1.
//
// Everything that reaches a vector comes from THIS wallet's own code - its
// script templates, tweakPubkey, scriptPathProofs, encodeCt1/encodeCw1 - with
// only the Schnorr signing delegated to @scure/btc-signer (a separate
// implementation from anything in the mint-side library). The vectors are then
// consumed by lnurlcashkernel, which hands them to Bitcoin Core's own script
// interpreter: wallet on one side, Core on the other, nothing shared between
// them but the wire format.
//
// Regenerate the mint-side fixture with:
//   CT1_VECTORS_OUT=../lnurlcashkernel/tests/vectors/wallet_ct1_vectors.json \
//     npx vitest run src/addons/taproot/ct1Interop.test.ts
import {describe, expect, it} from 'vitest'
import {writeFileSync} from 'node:fs'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {schnorr} from '@noble/curves/secp256k1.js'
import {Transaction, p2tr} from '@scure/btc-signer'

import {encodeCt1, encodeCw1, decodeCw1} from '../../lib/recoverableNotes'
import {
  scriptTemplateById,
  scriptPathProofs,
  tweakPubkey,
  verifyScriptPath,
  type ScriptTemplateId
} from './taproot'

const AMOUNT_MSAT = 20_000_000
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
  const tx = new Transaction({
    version: 2,
    lockTime: c.locktime,
    allowUnknownOutputs: true
  })
  tx.addInput({
    txid: new Uint8Array(32),
    index: 0,
    sequence: c.sequence,
    witnessUtxo: {script: tree.script, amount: BigInt(AMOUNT_MSAT)},
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
    ct1: encodeCt1(hexToBytes(tweakedPubkeyHex)),
    output_key: tweakedPubkeyHex,
    amount_msat: AMOUNT_MSAT,
    leaf_script: bytesToHex(proof!.script),
    control_block: bytesToHex(proof!.controlBlock),
    witness: witness.map(bytesToHex),
    locktime: c.locktime,
    sequence: c.sequence,
    cw1,
    locked_at: LOCKED_AT,
    now: c.now,
    expect_kind: c.expectKind
  }
}

describe('ct1/cw1 interop vectors (wallet -> lnurlcashkernel -> Bitcoin Core)', () => {
  const vectors = CASES.map(buildVector)

  it('builds a vector for every supported leaf shape', () => {
    expect(vectors.map(v => v.name)).toEqual(CASES.map(c => c.name))
    for (const v of vectors) {
      expect(v.ct1.startsWith('ct1')).toBe(true)
      expect(v.cw1.startsWith('cw1')).toBe(true)
    }
  })

  it('writes them out when CT1_VECTORS_OUT is set', () => {
    const out = process.env.CT1_VECTORS_OUT
    if (!out) return
    writeFileSync(
      out,
      JSON.stringify(
        {
          note: 'Generated by lnurl-wallet src/addons/taproot/ct1Interop.test.ts - do not edit by hand.',
          vectors
        },
        null,
        2
      ) + '\n'
    )
  })
})
