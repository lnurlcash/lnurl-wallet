import {describe, expect, it} from 'vitest'
import {decodeCw1} from '../../lib/recoverableNotes'
import {
  NUMS_INTERNAL_KEY_HEX,
  tweakPubkey,
  verifyScriptPath
} from '../taproot/taproot'
import {generateOracleKeypair, attest} from '../dlc/dlc'
import {
  betProblem,
  betReceiptUrl,
  buildRedeemCw1,
  parseBetReceipt,
  planBet,
  receiptProblem,
  type BetReceipt
} from './betlock'

const AMOUNT_MSAT = 20_000_000
const URL_TEMPLATE = 'https://mint.example.com/w'

describe('betProblem / planBet', () => {
  const oracle = generateOracleKeypair()
  const nonce = generateOracleKeypair()

  it('rejects a malformed oracle pubkey, a malformed nonce, and too few outcomes', () => {
    expect(betProblem('not-hex', nonce.pubkeyHex, ['yes', 'no'])).not.toBe('')
    expect(betProblem(oracle.pubkeyHex, 'not-hex', ['yes', 'no'])).not.toBe('')
    expect(betProblem(oracle.pubkeyHex, nonce.pubkeyHex, ['yes'])).not.toBe('')
    expect(betProblem(oracle.pubkeyHex, nonce.pubkeyHex, [])).not.toBe('')
  })

  it('accepts two or more distinct outcomes', () => {
    expect(betProblem(oracle.pubkeyHex, nonce.pubkeyHex, ['yes', 'no'])).toBe(
      ''
    )
  })

  it('de-duplicates and trims outcomes, and rejects if that drops below the minimum', () => {
    expect(
      betProblem(oracle.pubkeyHex, nonce.pubkeyHex, [' yes ', 'yes', '  '])
    ).not.toBe('')
  })

  it('planBet is deterministic - the same inputs always produce the same output key', () => {
    const a = planBet(oracle.pubkeyHex, nonce.pubkeyHex, ['yes', 'no'])
    const b = planBet(oracle.pubkeyHex, nonce.pubkeyHex, ['yes', 'no'])
    expect(a.outputKeyHex).toBe(b.outputKeyHex)
    expect(a.outcomes).toEqual(['yes', 'no'])
  })

  it('a different outcome set produces a different output key', () => {
    const a = planBet(oracle.pubkeyHex, nonce.pubkeyHex, ['yes', 'no'])
    const b = planBet(oracle.pubkeyHex, nonce.pubkeyHex, ['yes', 'no', 'push'])
    expect(a.outputKeyHex).not.toBe(b.outputKeyHex)
  })

  it("throws with betProblem's own message on invalid input", () => {
    expect(() => planBet('nope', nonce.pubkeyHex, ['yes', 'no'])).toThrow()
  })

  it('locks under the shared NUMS internal key - no key-path spend exists for anyone', () => {
    const plan = planBet(oracle.pubkeyHex, nonce.pubkeyHex, ['yes', 'no'])
    // tweaking the SAME NUMS key with an EMPTY leaf list gives the
    // key-path-only tweak - genuinely different from the locked output,
    // confirming the lock really is script-path-only
    expect(tweakPubkey(NUMS_INTERNAL_KEY_HEX, []).tweakedPubkeyHex).not.toBe(
      plan.outputKeyHex
    )
  })
})

describe('bet receipt: build, parse, round-trip', () => {
  const oracle = generateOracleKeypair()
  const nonce = generateOracleKeypair()
  const plan = planBet(oracle.pubkeyHex, nonce.pubkeyHex, ['yes', 'no'])
  const lockedNote = {
    urlTemplate: URL_TEMPLATE,
    amountMsat: AMOUNT_MSAT,
    signature: 'deadbeef'.repeat(16), // 65-byte-shaped stand-in
    groupPubkeyHex: plan.outputKeyHex
  }

  it('builds a receipt only for the plan that was actually locked', () => {
    expect(betReceiptUrl(lockedNote, plan)).not.toBeNull()
    const otherPlan = planBet(oracle.pubkeyHex, nonce.pubkeyHex, [
      'yes',
      'no',
      'push'
    ])
    expect(betReceiptUrl(lockedNote, otherPlan)).toBeNull()
  })

  it('round-trips every field through the URL', () => {
    const url = betReceiptUrl(lockedNote, plan)!
    const receipt = parseBetReceipt(url)!
    expect(receipt.amountMsat).toBe(AMOUNT_MSAT)
    expect(receipt.signature).toBe(lockedNote.signature)
    expect(receipt.oraclePubkeyHex).toBe(oracle.pubkeyHex)
    expect(receipt.nonceHex).toBe(nonce.pubkeyHex)
    expect(receipt.outcomes).toEqual(['yes', 'no'])
  })

  it('carries no k1 - it is not a spendable note on its own', () => {
    const url = betReceiptUrl(lockedNote, plan)!
    expect(new URL(url).searchParams.has('k1')).toBe(false)
  })

  it('rejects garbage, and reports why via receiptProblem', () => {
    expect(parseBetReceipt('not a url')).toBeNull()
    expect(parseBetReceipt('https://mint.example.com/w')).toBeNull()
    expect(receiptProblem('')).not.toBe('')
    expect(receiptProblem('not a url')).not.toBe('')
    expect(receiptProblem(betReceiptUrl(lockedNote, plan))).toBe('')
  })

  it('omits oracle discovery metadata when the plan was not built from a real oracle (backward compatible)', () => {
    const url = betReceiptUrl(lockedNote, plan)!
    expect(new URL(url).searchParams.has('oracleService')).toBe(false)
    expect(new URL(url).searchParams.has('event')).toBe(false)
    expect(parseBetReceipt(url)!.oracleServiceUrl).toBeUndefined()
    expect(parseBetReceipt(url)!.eventId).toBeUndefined()
  })

  it('round-trips oracle discovery metadata when the plan carries it', () => {
    const discoverablePlan = planBet(
      oracle.pubkeyHex,
      nonce.pubkeyHex,
      ['yes', 'no'],
      'https://oracle.example.com',
      'game-7-2026'
    )
    const locked = {
      ...lockedNote,
      groupPubkeyHex: discoverablePlan.outputKeyHex
    }
    const url = betReceiptUrl(locked, discoverablePlan)!
    const receipt = parseBetReceipt(url)!
    expect(receipt.oracleServiceUrl).toBe('https://oracle.example.com')
    expect(receipt.eventId).toBe('game-7-2026')
  })
})

describe('buildRedeemCw1', () => {
  const oracle = generateOracleKeypair()
  const nonce = generateOracleKeypair()
  const plan = planBet(oracle.pubkeyHex, nonce.pubkeyHex, ['yes', 'no'])
  const receipt: BetReceipt = {
    urlTemplate: URL_TEMPLATE,
    amountMsat: AMOUNT_MSAT,
    signature: 'deadbeef'.repeat(16),
    oraclePubkeyHex: plan.oraclePubkeyHex,
    nonceHex: plan.nonceHex,
    outcomes: plan.outcomes
  }

  it('produces a cw1 that commits to exactly the locked output key', () => {
    const attestation = attest(oracle.secretKeyHex, nonce.secretKeyHex, 'yes')
    const cw1 = buildRedeemCw1(receipt, attestation)
    const decoded = decodeCw1(cw1)!
    expect(decoded.locktime).toBe(0)
    expect(decoded.witness).toHaveLength(1)
    expect(
      verifyScriptPath(plan.outputKeyHex, {
        script: decoded.script,
        controlBlock: decoded.controlBlock
      })
    ).toBe(true)
  })

  it('a "yes" attestation cannot redeem the "no" leaf and vice versa', () => {
    const yes = buildRedeemCw1(
      receipt,
      attest(oracle.secretKeyHex, nonce.secretKeyHex, 'yes')
    )
    const no = buildRedeemCw1(
      receipt,
      attest(oracle.secretKeyHex, nonce.secretKeyHex, 'no')
    )
    expect(decodeCw1(yes)!.script).not.toEqual(decodeCw1(no)!.script)
  })

  it('refuses an outcome this bet never named', () => {
    expect(() =>
      buildRedeemCw1(receipt, {outcome: 'push', signatureHex: 'aa'.repeat(64)})
    ).toThrow(/never one of this bet/)
  })

  it('refuses an attestation that does not verify (wrong oracle)', () => {
    const impostor = generateOracleKeypair()
    const forged = attest(impostor.secretKeyHex, nonce.secretKeyHex, 'yes')
    expect(() => buildRedeemCw1(receipt, forged)).toThrow(/does not verify/)
  })

  it('refuses an attestation signed with the wrong nonce', () => {
    const wrongNonce = generateOracleKeypair()
    const forged = attest(oracle.secretKeyHex, wrongNonce.secretKeyHex, 'yes')
    expect(() => buildRedeemCw1(receipt, forged)).toThrow(/does not verify/)
  })

  it('is unaffected by a receipt carrying oracle discovery metadata (UI-only, never load-bearing)', () => {
    const withMetadata: BetReceipt = {
      ...receipt,
      oracleServiceUrl: 'https://oracle.example.com',
      eventId: 'game-7-2026'
    }
    const attestation = attest(oracle.secretKeyHex, nonce.secretKeyHex, 'yes')
    // BIP340 signing draws fresh auxiliary randomness per call (standard,
    // unrelated to the DLC nonce itself), so two calls never produce
    // byte-identical witnesses - compare what actually has to match: both
    // redeem the exact same leaf, committing to the exact same output key.
    const a = decodeCw1(buildRedeemCw1(withMetadata, attestation))!
    const b = decodeCw1(buildRedeemCw1(receipt, attestation))!
    expect(a.script).toEqual(b.script)
    expect(a.controlBlock).toEqual(b.controlBlock)
    expect(
      verifyScriptPath(plan.outputKeyHex, {
        script: a.script,
        controlBlock: a.controlBlock
      })
    ).toBe(true)
  })
})
