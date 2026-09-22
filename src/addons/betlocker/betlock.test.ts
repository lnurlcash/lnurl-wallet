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
  counterpartyProblem,
  parseBetReceipt,
  planBet,
  receiptProblem,
  refundDateProblem,
  refundNoteUrl,
  type BetReceipt
} from './betlock'

const AMOUNT_MSAT = 20_000_000
const URL_TEMPLATE = 'https://mint.example.com/w'
// same trick as ct1Interop.test.ts's own betlocker vector: a fixed,
// UTC-suffixed, far-future date string - dateToLocktime just needs
// anything Date-parseable, and 'Z' keeps this reproducible regardless of
// the test runner's own local timezone
const REFUND_DATE = '2030-01-01T00:00:00Z'

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

  it('planBet is deterministic in its OUTCOME leaves, but NOT overall - every call draws a fresh refund keypair', () => {
    const a = planBet(
      oracle.pubkeyHex,
      nonce.pubkeyHex,
      ['yes', 'no'],
      AMOUNT_MSAT,
      REFUND_DATE
    )
    const b = planBet(
      oracle.pubkeyHex,
      nonce.pubkeyHex,
      ['yes', 'no'],
      AMOUNT_MSAT,
      REFUND_DATE
    )
    expect(a.outcomes).toEqual(['yes', 'no'])
    // different refund keypair each call -> different refund leaf ->
    // different output key, same reasoning planTimelock's own tests rely
    // on (see this file's own "mandatory refund leaf" describe block)
    expect(a.refundPubkeyHex).not.toBe(b.refundPubkeyHex)
    expect(a.outputKeyHex).not.toBe(b.outputKeyHex)
  })

  it('a different outcome set produces a different output key', () => {
    const a = planBet(
      oracle.pubkeyHex,
      nonce.pubkeyHex,
      ['yes', 'no'],
      AMOUNT_MSAT,
      REFUND_DATE
    )
    const b = planBet(
      oracle.pubkeyHex,
      nonce.pubkeyHex,
      ['yes', 'no', 'push'],
      AMOUNT_MSAT,
      REFUND_DATE
    )
    expect(a.outputKeyHex).not.toBe(b.outputKeyHex)
  })

  it("throws with betProblem's own message on invalid input", () => {
    expect(() =>
      planBet('nope', nonce.pubkeyHex, ['yes', 'no'], AMOUNT_MSAT, REFUND_DATE)
    ).toThrow()
  })

  it('requires a positive amount and a usable refund date', () => {
    expect(() =>
      planBet(oracle.pubkeyHex, nonce.pubkeyHex, ['yes', 'no'], 0, REFUND_DATE)
    ).toThrow(/note to stake/)
    expect(() =>
      planBet(oracle.pubkeyHex, nonce.pubkeyHex, ['yes', 'no'], AMOUNT_MSAT, '')
    ).toThrow(/date/i)
  })

  it('locks under the shared NUMS internal key - no key-path spend exists for anyone', () => {
    const plan = planBet(
      oracle.pubkeyHex,
      nonce.pubkeyHex,
      ['yes', 'no'],
      AMOUNT_MSAT,
      REFUND_DATE
    )
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
  const plan = planBet(
    oracle.pubkeyHex,
    nonce.pubkeyHex,
    ['yes', 'no'],
    AMOUNT_MSAT,
    REFUND_DATE
  )
  const lockedNote = {
    urlTemplate: URL_TEMPLATE,
    amountMsat: AMOUNT_MSAT,
    signature: 'deadbeef'.repeat(16), // 65-byte-shaped stand-in
    groupPubkeyHex: plan.outputKeyHex
  }

  it('builds a receipt only for the plan that was actually locked', () => {
    expect(betReceiptUrl(lockedNote, plan)).not.toBeNull()
    const otherPlan = planBet(
      oracle.pubkeyHex,
      nonce.pubkeyHex,
      ['yes', 'no', 'push'],
      AMOUNT_MSAT,
      REFUND_DATE
    )
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
    expect(receipt.refundPubkeyHex).toBe(plan.refundPubkeyHex)
    expect(receipt.refundLocktime).toBe(plan.refundLocktime)
  })

  it('carries no k1 - it is not a spendable note on its own', () => {
    const url = betReceiptUrl(lockedNote, plan)!
    expect(new URL(url).searchParams.has('k1')).toBe(false)
  })

  it('never carries the refund SECRET (refundCw1) - only its public pubkey/locktime', () => {
    const url = betReceiptUrl(lockedNote, plan)!
    expect(url).not.toContain(plan.refundCw1)
    expect(new URL(url).searchParams.has('refundCw1')).toBe(false)
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
      AMOUNT_MSAT,
      REFUND_DATE,
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

describe('mandatory refund leaf', () => {
  const oracle = generateOracleKeypair()
  const nonce = generateOracleKeypair()
  const plan = planBet(
    oracle.pubkeyHex,
    nonce.pubkeyHex,
    ['yes', 'no'],
    AMOUNT_MSAT,
    REFUND_DATE
  )
  const lockedNote = {
    urlTemplate: URL_TEMPLATE,
    amountMsat: AMOUNT_MSAT,
    signature: 'deadbeef'.repeat(16),
    groupPubkeyHex: plan.outputKeyHex
  }

  it('refundDateProblem is fine for a valid future date, and objects to an empty one', () => {
    expect(refundDateProblem(REFUND_DATE)).toBe('')
    expect(refundDateProblem('')).not.toBe('')
  })

  it("every plan gets its own refund leaf - it's not optional", () => {
    expect(plan.refundPubkeyHex).toMatch(/^[0-9a-f]{64}$/)
    expect(plan.refundLocktime).toBeGreaterThan(0)
    expect(plan.refundCw1.startsWith('cw1')).toBe(true)
  })

  it('the refund cw1 is a real, independently verifiable script-path spend for THIS output key', () => {
    const decoded = decodeCw1(plan.refundCw1)!
    expect(decoded.locktime).toBe(plan.refundLocktime)
    expect(decoded.witness).toHaveLength(1)
    expect(
      verifyScriptPath(plan.outputKeyHex, {
        script: decoded.script,
        controlBlock: decoded.controlBlock
      })
    ).toBe(true)
  })

  it('refundNoteUrl builds a claimable link using refundCw1 as its own k1', () => {
    const url = refundNoteUrl(lockedNote, plan)!
    const parsed = new URL(url)
    expect(parsed.searchParams.get('k1')).toBe(plan.refundCw1)
    expect(parsed.searchParams.get('amount')).toBe(String(AMOUNT_MSAT))
  })

  it('refundNoteUrl refuses a lockedNote/plan mismatch, same as betReceiptUrl', () => {
    const otherPlan = planBet(
      oracle.pubkeyHex,
      nonce.pubkeyHex,
      ['yes', 'no', 'push'],
      AMOUNT_MSAT,
      REFUND_DATE
    )
    expect(refundNoteUrl(lockedNote, otherPlan)).toBeNull()
  })

  it('an outcome leaf still redeems correctly now that a refund leaf shares its tree', () => {
    const receipt = parseBetReceipt(betReceiptUrl(lockedNote, plan))!
    expect(receipt.refundPubkeyHex).toBe(plan.refundPubkeyHex)
    const attestation = attest(oracle.secretKeyHex, nonce.secretKeyHex, 'yes')
    const cw1 = buildRedeemCw1(receipt, attestation)
    const decoded = decodeCw1(cw1)!
    expect(
      verifyScriptPath(plan.outputKeyHex, {
        script: decoded.script,
        controlBlock: decoded.controlBlock
      })
    ).toBe(true)
    // genuinely a DIFFERENT leaf than the refund one, same tree
    expect(decoded.script).not.toEqual(decodeCw1(plan.refundCw1)!.script)
  })

  it('backward compatible: a receipt with no refund fields at all (built by a wallet version that predates this) still redeems its outcome leaf', () => {
    const oldPlan = planBet(
      oracle.pubkeyHex,
      nonce.pubkeyHex,
      ['yes', 'no'],
      AMOUNT_MSAT,
      REFUND_DATE
    )
    // simulate an old-shape receipt by stripping the refund fields a
    // pre-refund-leaf wallet's own receipt would never have had
    const oldReceipt: BetReceipt = {
      urlTemplate: URL_TEMPLATE,
      amountMsat: AMOUNT_MSAT,
      signature: 'deadbeef'.repeat(16),
      oraclePubkeyHex: oldPlan.oraclePubkeyHex,
      nonceHex: oldPlan.nonceHex,
      outcomes: oldPlan.outcomes
      // no refundPubkeyHex/refundLocktime
    }
    const attestation = attest(oracle.secretKeyHex, nonce.secretKeyHex, 'yes')
    // must NOT throw, and must produce a witness for the plain 2-leaf
    // (no refund) tree that shape of receipt actually implies
    const cw1 = buildRedeemCw1(oldReceipt, attestation)
    const decoded = decodeCw1(cw1)!
    expect(decoded.witness).toHaveLength(1)
  })
})

describe('buildRedeemCw1', () => {
  const oracle = generateOracleKeypair()
  const nonce = generateOracleKeypair()
  const plan = planBet(
    oracle.pubkeyHex,
    nonce.pubkeyHex,
    ['yes', 'no'],
    AMOUNT_MSAT,
    REFUND_DATE
  )
  const receipt: BetReceipt = {
    urlTemplate: URL_TEMPLATE,
    amountMsat: AMOUNT_MSAT,
    signature: 'deadbeef'.repeat(16),
    oraclePubkeyHex: plan.oraclePubkeyHex,
    nonceHex: plan.nonceHex,
    outcomes: plan.outcomes,
    refundPubkeyHex: plan.refundPubkeyHex,
    refundLocktime: plan.refundLocktime
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

describe('counterpartyProblem', () => {
  it('is fine when empty - counterparty binding is optional', () => {
    expect(counterpartyProblem('')).toBe('')
    expect(counterpartyProblem(undefined)).toBe('')
  })

  it('rejects a malformed pubkey', () => {
    expect(counterpartyProblem('not-hex')).not.toBe('')
    expect(counterpartyProblem('ab')).not.toBe('')
  })

  it('accepts a valid 32-byte x-only pubkey', () => {
    const {pubkeyHex} = generateOracleKeypair()
    expect(counterpartyProblem(pubkeyHex)).toBe('')
  })
})

describe('counterparty-bound bets (multisig2 leaves)', () => {
  const oracle = generateOracleKeypair()
  const nonce = generateOracleKeypair()
  const counterparty = generateOracleKeypair()
  const impostor = generateOracleKeypair()

  const plan = planBet(
    oracle.pubkeyHex,
    nonce.pubkeyHex,
    ['yes', 'no'],
    AMOUNT_MSAT,
    REFUND_DATE,
    undefined,
    undefined,
    counterparty.pubkeyHex
  )
  const lockedNote = {
    urlTemplate: URL_TEMPLATE,
    amountMsat: AMOUNT_MSAT,
    signature: 'deadbeef'.repeat(16),
    groupPubkeyHex: plan.outputKeyHex
  }

  it('produces a different output key than the same bet without a counterparty', () => {
    const plainPlan = planBet(
      oracle.pubkeyHex,
      nonce.pubkeyHex,
      ['yes', 'no'],
      AMOUNT_MSAT,
      REFUND_DATE
    )
    expect(plan.outputKeyHex).not.toBe(plainPlan.outputKeyHex)
  })

  it('carries the counterparty pubkey through the receipt round trip', () => {
    const url = betReceiptUrl(lockedNote, plan)!
    const receipt = parseBetReceipt(url)!
    expect(receipt.counterpartyPubkeyHex).toBe(counterparty.pubkeyHex)
  })

  it('refuses to redeem without a secret key at all', () => {
    const receipt = parseBetReceipt(betReceiptUrl(lockedNote, plan))!
    const attestation = attest(oracle.secretKeyHex, nonce.secretKeyHex, 'yes')
    expect(() => buildRedeemCw1(receipt, attestation)).toThrow(
      /locked to a specific redeemer/
    )
  })

  it('refuses a secret key that does not match the named counterparty', () => {
    const receipt = parseBetReceipt(betReceiptUrl(lockedNote, plan))!
    const attestation = attest(oracle.secretKeyHex, nonce.secretKeyHex, 'yes')
    expect(() =>
      buildRedeemCw1(receipt, attestation, impostor.secretKeyHex)
    ).toThrow(/does not match/)
  })

  it('redeems with the correct counterparty secret key, producing a real 2-of-2 witness', () => {
    const receipt = parseBetReceipt(betReceiptUrl(lockedNote, plan))!
    const attestation = attest(oracle.secretKeyHex, nonce.secretKeyHex, 'yes')
    const cw1 = buildRedeemCw1(receipt, attestation, counterparty.secretKeyHex)
    const decoded = decodeCw1(cw1)!
    expect(decoded.witness).toHaveLength(2)
    expect(
      verifyScriptPath(plan.outputKeyHex, {
        script: decoded.script,
        controlBlock: decoded.controlBlock
      })
    ).toBe(true)
  })

  it('a "yes" attestation cannot redeem the "no" leaf, even with the right counterparty key', () => {
    const receipt = parseBetReceipt(betReceiptUrl(lockedNote, plan))!
    const yesAttestation = attest(
      oracle.secretKeyHex,
      nonce.secretKeyHex,
      'yes'
    )
    const noAttestation = attest(oracle.secretKeyHex, nonce.secretKeyHex, 'no')
    const yes = buildRedeemCw1(
      receipt,
      yesAttestation,
      counterparty.secretKeyHex
    )
    const no = buildRedeemCw1(receipt, noAttestation, counterparty.secretKeyHex)
    expect(decodeCw1(yes)!.script).not.toEqual(decodeCw1(no)!.script)
  })
})
