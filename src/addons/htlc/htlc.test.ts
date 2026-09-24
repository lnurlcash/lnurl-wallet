import {describe, expect, it} from 'vitest'
import {hexToBytes} from '@noble/hashes/utils.js'
import {decodeCw1} from '../../lib/recoverableNotes'
import {generateKeypair, verifyScriptPath} from '../taproot/taproot'
import {
  buildClaimCw1,
  claimPubkeyProblem,
  generatePreimage,
  htlcProblem,
  htlcReceiptUrl,
  parseHtlcReceipt,
  planHtlc,
  preimageProblem,
  receiptProblem,
  refundNoteUrl
} from './htlc'

const NOW = 1_800_000_000
const MINT = 'mint.example.com'
const AMOUNT_MSAT = 20_000_000
const at = (seconds: number): string =>
  new Date(seconds * 1000)
    .toLocaleString('sv-SE', {hour12: false})
    .replace(' ', 'T')
    .slice(0, 16)

const claimant = generateKeypair()
const refundDate = at(NOW + 7 * 86400)

const lockedNoteFor = (outputKeyHex: string) => ({
  urlTemplate: `https://mint.example.com/w/cb?amount=${AMOUNT_MSAT}&sig=deadbeef`,
  amountMsat: AMOUNT_MSAT,
  signature: 'deadbeef',
  groupPubkeyHex: outputKeyHex
})

describe('generatePreimage', () => {
  it('produces a preimage whose sha256 is the hash', () => {
    const {preimageHex, hashHex} = generatePreimage()
    expect(preimageProblem(preimageHex, hashHex)).toBe('')
  })
  it('draws a fresh preimage every call', () => {
    const a = generatePreimage()
    const b = generatePreimage()
    expect(a.preimageHex).not.toBe(b.preimageHex)
  })
})

describe('htlcProblem / claimPubkeyProblem', () => {
  const {hashHex} = generatePreimage()

  it('requires a real hash', () => {
    expect(htlcProblem('', claimant.pubkeyHex)).not.toBe('')
    expect(htlcProblem('not-hex', claimant.pubkeyHex)).not.toBe('')
  })
  it('requires a real claimant pubkey', () => {
    expect(claimPubkeyProblem('')).not.toBe('')
    expect(claimPubkeyProblem('not-hex')).not.toBe('')
    expect(claimPubkeyProblem(claimant.pubkeyHex)).toBe('')
  })
  it('accepts a usable (hash, claimant) pair', () => {
    expect(htlcProblem(hashHex, claimant.pubkeyHex)).toBe('')
  })
})

describe('planHtlc', () => {
  const {hashHex} = generatePreimage()
  const plan = planHtlc(
    hashHex,
    claimant.pubkeyHex,
    AMOUNT_MSAT,
    refundDate,
    MINT,
    NOW
  )

  it('commits the refund cw1 to exactly the locked output key', () => {
    expect(plan.outputKeyHex).toMatch(/^[0-9a-f]{64}$/)
    const cw1 = decodeCw1(plan.refundCw1)!
    expect(
      verifyScriptPath(plan.outputKeyHex, {
        script: cw1.script,
        controlBlock: cw1.controlBlock
      })
    ).toBe(true)
  })

  it('draws a fresh refund key every time - never returns it', () => {
    const other = planHtlc(
      hashHex,
      claimant.pubkeyHex,
      AMOUNT_MSAT,
      refundDate,
      MINT,
      NOW
    )
    expect(other.refundCw1).not.toBe(plan.refundCw1)
    expect(other.outputKeyHex).not.toBe(plan.outputKeyHex)
    expect(Object.keys(plan).sort()).toEqual([
      'claimPubkeyHex',
      'hashHex',
      'outputKeyHex',
      'refundCw1',
      'refundLocktime',
      'refundPubkeyHex'
    ])
  })

  it('refuses to plan without a hash, a claimant, an amount, or a valid date', () => {
    expect(() =>
      planHtlc('', claimant.pubkeyHex, AMOUNT_MSAT, refundDate, MINT, NOW)
    ).toThrow()
    expect(() =>
      planHtlc(hashHex, '', AMOUNT_MSAT, refundDate, MINT, NOW)
    ).toThrow()
    expect(() =>
      planHtlc(hashHex, claimant.pubkeyHex, 0, refundDate, MINT, NOW)
    ).toThrow()
    expect(() =>
      planHtlc(hashHex, claimant.pubkeyHex, AMOUNT_MSAT, '', MINT, NOW)
    ).toThrow()
  })
})

describe('htlcReceiptUrl / parseHtlcReceipt / refundNoteUrl', () => {
  const {hashHex} = generatePreimage()
  const plan = planHtlc(
    hashHex,
    claimant.pubkeyHex,
    AMOUNT_MSAT,
    refundDate,
    MINT,
    NOW
  )
  const lockedNote = lockedNoteFor(plan.outputKeyHex)

  it('round-trips through a receipt URL', () => {
    const url = htlcReceiptUrl(lockedNote, plan)!
    expect(url).toBeTruthy()
    const receipt = parseHtlcReceipt(url)!
    expect(receipt.hashHex).toBe(plan.hashHex)
    expect(receipt.claimPubkeyHex).toBe(plan.claimPubkeyHex)
    expect(receipt.refundPubkeyHex).toBe(plan.refundPubkeyHex)
    expect(receipt.refundLocktime).toBe(plan.refundLocktime)
    expect(receipt.amountMsat).toBe(AMOUNT_MSAT)
  })

  it('never includes the preimage or the refund cw1', () => {
    const url = htlcReceiptUrl(lockedNote, plan)!
    expect(url).not.toContain('refundCw1')
    expect(url.toLowerCase()).not.toContain(plan.refundCw1.toLowerCase())
  })

  it('returns null for a mismatched locked note', () => {
    expect(htlcReceiptUrl(lockedNoteFor('00'.repeat(32)), plan)).toBeNull()
  })

  it('builds a claimable refund note URL carrying the refund cw1 as k1', () => {
    const url = refundNoteUrl(lockedNote, plan)!
    expect(new URL(url).searchParams.get('k1')).toBe(plan.refundCw1)
  })

  it('receiptProblem accepts a real receipt and rejects garbage', () => {
    const url = htlcReceiptUrl(lockedNote, plan)!
    expect(receiptProblem(url)).toBe('')
    expect(receiptProblem('')).not.toBe('')
    expect(receiptProblem('https://example.com/not-a-receipt')).not.toBe('')
  })
})

describe('buildClaimCw1', () => {
  const {preimageHex, hashHex} = generatePreimage()
  const plan = planHtlc(
    hashHex,
    claimant.pubkeyHex,
    AMOUNT_MSAT,
    refundDate,
    MINT,
    NOW
  )
  const lockedNote = lockedNoteFor(plan.outputKeyHex)
  const receipt = parseHtlcReceipt(htlcReceiptUrl(lockedNote, plan)!)!

  it('produces a cw1 that verifies against the locked output key', () => {
    const cw1 = buildClaimCw1(receipt, preimageHex, claimant.secretKeyHex)
    const decoded = decodeCw1(cw1)!
    expect(decoded.witness).toHaveLength(2)
    expect(
      verifyScriptPath(plan.outputKeyHex, {
        script: decoded.script,
        controlBlock: decoded.controlBlock
      })
    ).toBe(true)
  })

  it('witness order is [signature, preimage]', () => {
    const cw1 = buildClaimCw1(receipt, preimageHex, claimant.secretKeyHex)
    const decoded = decodeCw1(cw1)!
    expect(decoded.witness[0]!.length).toBe(64) // schnorr signature
    expect(decoded.witness[1]!).toEqual(hexToBytes(preimageHex))
  })

  it('refuses a preimage that does not hash to the receipt', () => {
    expect(() =>
      buildClaimCw1(receipt, '11'.repeat(32), claimant.secretKeyHex)
    ).toThrow(/does not hash/)
  })

  it('refuses a secret key that does not match the named claimant', () => {
    const other = generateKeypair()
    expect(() =>
      buildClaimCw1(receipt, preimageHex, other.secretKeyHex)
    ).toThrow(/does not match/)
  })
})
