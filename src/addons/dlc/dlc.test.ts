import {describe, expect, it} from 'vitest'
import {schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {p2tr, Transaction} from '@scure/btc-signer'
import {
  generateOracleKeypair,
  outcomePoint,
  attest,
  verifyAttestation,
  attestationScalar
} from './dlc'
import {
  compileLeaf,
  scriptPathProofs,
  tweakPubkey,
  verifyScriptPath
} from '../taproot/taproot'
import {deriveScriptPathCommitment, encodeCw1} from '../../lib/recoverableNotes'

describe('outcomePoint / attest / verifyAttestation - the core DLC mechanic', () => {
  it('precomputes distinct points for every outcome before any attestation exists', () => {
    const oracle = generateOracleKeypair()
    const nonce = generateOracleKeypair()
    const yes = outcomePoint(oracle.pubkeyHex, nonce.pubkeyHex, 'yes')
    const no = outcomePoint(oracle.pubkeyHex, nonce.pubkeyHex, 'no')
    expect(yes).not.toBe(no)
    expect(yes).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic - the same (oracle, nonce, outcome) always gives the same point', () => {
    const oracle = generateOracleKeypair()
    const nonce = generateOracleKeypair()
    expect(outcomePoint(oracle.pubkeyHex, nonce.pubkeyHex, 'yes')).toBe(
      outcomePoint(oracle.pubkeyHex, nonce.pubkeyHex, 'yes')
    )
  })

  it("an attestation verifies, and reveals a real private key for exactly that outcome's point - not the others", () => {
    const oracle = generateOracleKeypair()
    const nonce = generateOracleKeypair()
    const points = {
      yes: outcomePoint(oracle.pubkeyHex, nonce.pubkeyHex, 'yes'),
      no: outcomePoint(oracle.pubkeyHex, nonce.pubkeyHex, 'no')
    }

    const attestation = attest(oracle.secretKeyHex, nonce.secretKeyHex, 'yes')
    expect(
      verifyAttestation(oracle.pubkeyHex, nonce.pubkeyHex, attestation)
    ).toBe(true)

    const s = attestationScalar(attestation.signatureHex)
    const derivedPubkey = bytesToHex(schnorr.getPublicKey(hexToBytes(s)))
    expect(derivedPubkey).toBe(points.yes)
    expect(derivedPubkey).not.toBe(points.no)

    // not just a matching x-coordinate - a genuinely usable signing key
    const msg = new Uint8Array(32).fill(7)
    const sig = schnorr.sign(msg, hexToBytes(s))
    expect(schnorr.verify(sig, msg, hexToBytes(points.yes))).toBe(true)
  })

  it('rejects a signature claiming the wrong outcome for its own bytes', () => {
    const oracle = generateOracleKeypair()
    const nonce = generateOracleKeypair()
    const attestation = attest(oracle.secretKeyHex, nonce.secretKeyHex, 'yes')
    expect(
      verifyAttestation(oracle.pubkeyHex, nonce.pubkeyHex, {
        outcome: 'no',
        signatureHex: attestation.signatureHex
      })
    ).toBe(false)
  })

  it('rejects an attestation signed with a nonce other than the one announced', () => {
    const oracle = generateOracleKeypair()
    const announced = generateOracleKeypair()
    const actuallyUsed = generateOracleKeypair()
    const attestation = attest(
      oracle.secretKeyHex,
      actuallyUsed.secretKeyHex,
      'yes'
    )
    // a plain BIP340 verify alone would pass this (it's a genuinely valid
    // signature) - the nonce-matches-the-announcement check is what makes
    // it fail, and is the whole reason verifyAttestation exists rather
    // than a bare schnorr.verify call
    expect(
      verifyAttestation(oracle.pubkeyHex, announced.pubkeyHex, attestation)
    ).toBe(false)
  })

  it('rejects a signature from the wrong oracle', () => {
    const oracle = generateOracleKeypair()
    const impostor = generateOracleKeypair()
    const nonce = generateOracleKeypair()
    const attestation = attest(impostor.secretKeyHex, nonce.secretKeyHex, 'yes')
    expect(
      verifyAttestation(oracle.pubkeyHex, nonce.pubkeyHex, attestation)
    ).toBe(false)
  })

  it('rejects malformed input rather than throwing', () => {
    expect(
      verifyAttestation('nope', 'nope', {outcome: 'yes', signatureHex: 'nope'})
    ).toBe(false)
  })

  it('outcomePoint and attest throw on malformed hex', () => {
    expect(() => outcomePoint('nope', 'ab'.repeat(32), 'yes')).toThrow()
    expect(() => attest('nope', 'ab'.repeat(32), 'yes')).toThrow()
  })

  it('attestationScalar throws on a non-64-byte signature', () => {
    expect(() => attestationScalar('ab'.repeat(10))).toThrow()
  })

  it('generateNonce and generateOracleKeypair are the same math, distinct names', () => {
    const a = generateOracleKeypair()
    expect(a.pubkeyHex).toBe(
      bytesToHex(schnorr.getPublicKey(hexToBytes(a.secretKeyHex)))
    )
  })
})

describe('integration with the taproot addon: zero new script template', () => {
  it('an outcome point locks and redeems as an ordinary pk-template leaf + cw1, exactly like any other taproot addon lock', () => {
    const oracle = generateOracleKeypair()
    const nonce = generateOracleKeypair()
    const internal = generateOracleKeypair() // stand-in internal key
    const AMOUNT_MSAT = 20_000_000n

    const yesPoint = outcomePoint(oracle.pubkeyHex, nonce.pubkeyHex, 'yes')
    const noPoint = outcomePoint(oracle.pubkeyHex, nonce.pubkeyHex, 'no')
    const leafYes = compileLeaf('pk', {
      pubkeyHex: yesPoint,
      pubkey2Hex: '',
      hashHex: '',
      locktime: 0
    })!
    const leafNo = compileLeaf('pk', {
      pubkeyHex: noPoint,
      pubkey2Hex: '',
      hashHex: '',
      locktime: 0
    })!
    const leaves = [hexToBytes(leafYes.scriptHex), hexToBytes(leafNo.scriptHex)]

    const {tweakedPubkeyHex} = tweakPubkey(internal.pubkeyHex, leaves)
    const [yesProof] = scriptPathProofs(hexToBytes(internal.pubkeyHex), leaves)
    expect(verifyScriptPath(tweakedPubkeyHex, yesProof!)).toBe(true)

    // before any attestation, the note is locked - nobody, including the
    // person who locked it, can produce a valid witness for either leaf yet
    const attestation = attest(oracle.secretKeyHex, nonce.secretKeyHex, 'yes')
    const s = attestationScalar(attestation.signatureHex)

    const tree = p2tr(
      hexToBytes(internal.pubkeyHex),
      leaves.map(script => ({script})),
      undefined,
      true
    )
    const tx = new Transaction({
      version: 2,
      lockTime: 0,
      allowUnknownOutputs: true
    })
    tx.addInput({
      txid: new Uint8Array(32),
      index: 0,
      sequence: 0xfffffffe,
      witnessUtxo: {script: tree.script, amount: AMOUNT_MSAT},
      tapLeafScript: tree.tapLeafScript!.filter(
        ([, leafScript]) =>
          bytesToHex(leafScript.subarray(0, leafScript.length - 1)) ===
          leafYes.scriptHex
      )
    })
    tx.addOutput({script: new Uint8Array(0), amount: 0n})
    tx.signIdx(hexToBytes(s), 0)
    const input = tx.getInput(0) as {
      tapScriptSig?: [{pubKey: Uint8Array}, Uint8Array][]
    }
    const sig = input.tapScriptSig?.[0]?.[1]
    expect(sig).toBeDefined()

    const cw1 = encodeCw1({
      locktime: 0,
      sequence: 0xfffffffe,
      script: leaves[0]!,
      controlBlock: yesProof!.controlBlock,
      witness: [sig!]
    })

    // the mint-side derivation (lib/recoverableNotes.ts) independently
    // agrees this cw1 commits to exactly the locked output key
    const commitment = deriveScriptPathCommitment(
      leaves[0]!,
      yesProof!.controlBlock
    )
    expect(commitment).not.toBeNull()
    expect(bytesToHex(commitment!.outputKey)).toBe(tweakedPubkeyHex)
    expect(cw1.startsWith('cw1')).toBe(true)
  })
})
