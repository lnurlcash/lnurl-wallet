import {describe, expect, it} from 'vitest'
import {schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex} from '@noble/hashes/utils.js'
import {decodeCw1} from '../../lib/recoverableNotes'
import {verifyScriptPath} from '../taproot/taproot'
import {
  consignmentProblem,
  genesisState,
  nextState,
  parseSealConsignment,
  planSealLock,
  redeemCurrentStateCw1,
  sealChainProblem,
  sealConsignmentUrl,
  sealStateHash,
  type SealState
} from './seals'

const AMOUNT_MSAT = 20_000_000
const URL_TEMPLATE = 'https://mint.example.com/w'

const realKeypair = () => {
  const secretKey = schnorr.utils.randomSecretKey()
  return {
    secretKeyHex: bytesToHex(secretKey),
    pubkeyHex: bytesToHex(schnorr.getPublicKey(secretKey))
  }
}

describe('genesisState / nextState', () => {
  const owner = realKeypair()
  const buyer = realKeypair()

  it('rejects an empty name or an invalid owner pubkey', () => {
    expect(() => genesisState('', 'desc', owner.pubkeyHex)).toThrow(/name/i)
    expect(() => genesisState('Art', 'desc', 'not-hex')).toThrow(/pubkey/i)
  })

  it('genesis is state index 0 with no previous state', () => {
    const g = genesisState('Art #1', 'a description', owner.pubkeyHex)
    expect(g.stateIndex).toBe(0)
    expect(g.prevStateHash).toBe('')
    expect(g.ownerPubkeyHex).toBe(owner.pubkeyHex)
    expect(g.assetId).toMatch(/^[0-9a-f]{64}$/)
  })

  it('two genesis calls produce different asset ids - never colliding by accident', () => {
    const a = genesisState('Art #1', '', owner.pubkeyHex)
    const b = genesisState('Art #1', '', owner.pubkeyHex)
    expect(a.assetId).not.toBe(b.assetId)
  })

  it('nextState increments the index, chains the hash, and changes only the owner', () => {
    const g = genesisState('Art #1', 'a description', owner.pubkeyHex)
    const n = nextState(g, buyer.pubkeyHex)
    expect(n.stateIndex).toBe(1)
    expect(n.prevStateHash).toBe(sealStateHash(g))
    expect(n.ownerPubkeyHex).toBe(buyer.pubkeyHex)
    expect(n.assetId).toBe(g.assetId)
    expect(n.name).toBe(g.name)
    expect(n.description).toBe(g.description)
  })

  it('rejects an invalid next owner pubkey', () => {
    const g = genesisState('Art #1', '', owner.pubkeyHex)
    expect(() => nextState(g, 'not-hex')).toThrow(/pubkey/i)
  })
})

describe('sealStateHash', () => {
  const owner = realKeypair()

  it('is deterministic', () => {
    const g = genesisState('Art #1', 'desc', owner.pubkeyHex)
    expect(sealStateHash(g)).toBe(sealStateHash({...g}))
  })

  it('is sensitive to every field that is allowed to change', () => {
    const g = genesisState('Art #1', 'desc', owner.pubkeyHex)
    const buyer = realKeypair()
    const differentOwner = {...g, ownerPubkeyHex: buyer.pubkeyHex}
    const differentIndex = {...g, stateIndex: 1}
    const differentPrev = {...g, prevStateHash: '11'.repeat(32)}
    expect(sealStateHash(differentOwner)).not.toBe(sealStateHash(g))
    expect(sealStateHash(differentIndex)).not.toBe(sealStateHash(g))
    expect(sealStateHash(differentPrev)).not.toBe(sealStateHash(g))
  })

  it('is sensitive to the asset identity fields too - no cross-asset collisions', () => {
    const g = genesisState('Art #1', 'desc', owner.pubkeyHex)
    const differentName = {...g, name: 'Art #2'}
    const differentDescription = {...g, description: 'other'}
    expect(sealStateHash(differentName)).not.toBe(sealStateHash(g))
    expect(sealStateHash(differentDescription)).not.toBe(sealStateHash(g))
  })
})

describe('planSealLock', () => {
  it('produces a real, independently verifiable taproot commitment', () => {
    const owner = realKeypair()
    const g = genesisState('Art #1', 'desc', owner.pubkeyHex)
    const {outputKeyHex} = planSealLock(g)
    expect(outputKeyHex).toMatch(/^[0-9a-f]{64}$/)
  })

  it('two different states lock to two different output keys', () => {
    const owner = realKeypair()
    const a = genesisState('Art #1', '', owner.pubkeyHex)
    const b = genesisState('Art #2', '', owner.pubkeyHex)
    expect(planSealLock(a).outputKeyHex).not.toBe(planSealLock(b).outputKeyHex)
  })
})

describe('redeemCurrentStateCw1', () => {
  const owner = realKeypair()
  const impostor = realKeypair()
  const state = genesisState('Art #1', 'desc', owner.pubkeyHex)

  it('refuses a malformed or missing secret key', () => {
    expect(() => redeemCurrentStateCw1(state, '', AMOUNT_MSAT)).toThrow(
      /secret key/
    )
    expect(() => redeemCurrentStateCw1(state, 'not-hex', AMOUNT_MSAT)).toThrow(
      /secret key/
    )
  })

  it("refuses a secret key that isn't this state's own owner", () => {
    expect(() =>
      redeemCurrentStateCw1(state, impostor.secretKeyHex, AMOUNT_MSAT)
    ).toThrow(/does not match/)
  })

  it('refuses a missing/non-positive amount', () => {
    expect(() => redeemCurrentStateCw1(state, owner.secretKeyHex, 0)).toThrow(
      /amount/
    )
  })

  it('produces a real, verifiable cw1 for the correct owner', () => {
    const cw1 = redeemCurrentStateCw1(state, owner.secretKeyHex, AMOUNT_MSAT)
    expect(cw1.startsWith('cw1')).toBe(true)
    const decoded = decodeCw1(cw1)!
    expect(decoded.witness).toHaveLength(2) // [signature, revealed state preimage]
    expect(
      verifyScriptPath(planSealLock(state).outputKeyHex, {
        script: decoded.script,
        controlBlock: decoded.controlBlock
      })
    ).toBe(true)
  })
})

describe('sealChainProblem', () => {
  const owner = realKeypair()
  const buyer = realKeypair()
  const genesis = genesisState('Art #1', 'a description', owner.pubkeyHex)
  const transfer1 = nextState(genesis, buyer.pubkeyHex)

  it('accepts a genesis-only chain', () => {
    expect(sealChainProblem([genesis])).toBe('')
  })

  it('accepts a correctly chained multi-state history', () => {
    expect(sealChainProblem([genesis, transfer1])).toBe('')
  })

  it('rejects an empty or non-array input', () => {
    expect(sealChainProblem([])).not.toBe('')
    expect(sealChainProblem('nope')).not.toBe('')
  })

  it('rejects a genesis that is not state index 0 or has a previous state', () => {
    expect(sealChainProblem([{...genesis, stateIndex: 1}])).not.toBe('')
    expect(
      sealChainProblem([{...genesis, prevStateHash: '11'.repeat(32)}])
    ).not.toBe('')
  })

  it('rejects a state whose identity (name/description/assetId) drifted from genesis', () => {
    expect(
      sealChainProblem([genesis, {...transfer1, name: 'Different name'}])
    ).toMatch(/identity is fixed/)
    expect(
      sealChainProblem([genesis, {...transfer1, assetId: '22'.repeat(32)}])
    ).toMatch(/different asset id/)
  })

  it('rejects a state index that skips or repeats', () => {
    expect(sealChainProblem([genesis, {...transfer1, stateIndex: 2}])).toMatch(
      /increase by exactly 1/
    )
    expect(sealChainProblem([genesis, {...transfer1, stateIndex: 0}])).toMatch(
      /increase by exactly 1/
    )
  })

  it('rejects a state whose prevStateHash does not really chain back', () => {
    expect(
      sealChainProblem([
        genesis,
        {...transfer1, prevStateHash: '33'.repeat(32)}
      ])
    ).toMatch(/does not chain/)
  })

  it('rejects a spliced-in state from a DIFFERENT chain (can’t forge a shorter/longer history)', () => {
    const otherOwner = realKeypair()
    const otherGenesis = genesisState('Art #2', '', otherOwner.pubkeyHex)
    // even though otherGenesis is itself a valid genesis, splicing it in as
    // "state 1" of THIS asset must fail - different assetId
    expect(sealChainProblem([genesis, otherGenesis])).toMatch(
      /different asset id|increase by exactly 1/
    )
  })
})

describe('seal consignment: build, parse, round-trip', () => {
  const owner = realKeypair()
  const buyer = realKeypair()
  const genesis = genesisState('Art #1', 'a description', owner.pubkeyHex)
  const lockedNote = {
    urlTemplate: URL_TEMPLATE,
    amountMsat: AMOUNT_MSAT,
    signature: 'deadbeef'.repeat(16),
    groupPubkeyHex: planSealLock(genesis).outputKeyHex
  }

  it('builds and round-trips a genesis-only consignment', () => {
    const url = sealConsignmentUrl(lockedNote, [genesis])!
    expect(url).not.toBeNull()
    const parsed = parseSealConsignment(url)!
    expect(parsed.amountMsat).toBe(AMOUNT_MSAT)
    expect(parsed.states).toEqual([genesis])
  })

  it('carries no k1 - not a spendable note on its own', () => {
    const url = sealConsignmentUrl(lockedNote, [genesis])!
    expect(new URL(url).searchParams.has('k1')).toBe(false)
  })

  it('round-trips a multi-state history', () => {
    const transfer1 = nextState(genesis, buyer.pubkeyHex)
    const url = sealConsignmentUrl(lockedNote, [genesis, transfer1])!
    const parsed = parseSealConsignment(url)!
    expect(parsed.states).toEqual([genesis, transfer1])
  })

  it('rejects garbage', () => {
    expect(parseSealConsignment('not a url')).toBeNull()
    expect(parseSealConsignment('https://mint.example.com/w')).toBeNull()
    expect(sealConsignmentUrl(null, [genesis])).toBeNull()
    expect(sealConsignmentUrl(lockedNote, [])).toBeNull()
  })

  it('rejects a states param that is not real JSON, not an array, or contains malformed entries', () => {
    const base = new URL(URL_TEMPLATE)
    base.searchParams.set('amount', String(AMOUNT_MSAT))
    base.searchParams.set('states', 'not json')
    expect(parseSealConsignment(base.toString())).toBeNull()

    const notArray = new URL(URL_TEMPLATE)
    notArray.searchParams.set('amount', String(AMOUNT_MSAT))
    notArray.searchParams.set('states', JSON.stringify({not: 'an array'}))
    expect(parseSealConsignment(notArray.toString())).toBeNull()

    const malformedEntry = new URL(URL_TEMPLATE)
    malformedEntry.searchParams.set('amount', String(AMOUNT_MSAT))
    malformedEntry.searchParams.set(
      'states',
      JSON.stringify([{...genesis, ownerPubkeyHex: 'not-hex'}])
    )
    expect(parseSealConsignment(malformedEntry.toString())).toBeNull()
  })
})

describe('consignmentProblem', () => {
  const owner = realKeypair()
  const genesis = genesisState('Art #1', '', owner.pubkeyHex)
  const lockedNote = {
    urlTemplate: URL_TEMPLATE,
    amountMsat: AMOUNT_MSAT,
    signature: 'deadbeef'.repeat(16),
    groupPubkeyHex: planSealLock(genesis).outputKeyHex
  }

  it('requires a non-empty input', () => {
    expect(consignmentProblem('')).not.toBe('')
  })

  it('rejects a malformed consignment shape', () => {
    expect(consignmentProblem('not a url')).not.toBe('')
  })

  it('accepts a real, self-consistent consignment', () => {
    const url = sealConsignmentUrl(lockedNote, [genesis])!
    expect(consignmentProblem(url)).toBe('')
  })

  it('catches a shape-valid but chain-broken consignment (e.g. hand-edited)', () => {
    const url = new URL(sealConsignmentUrl(lockedNote, [genesis])!)
    const tampered: SealState[] = [{...genesis, stateIndex: 5}]
    url.searchParams.set('states', JSON.stringify(tampered))
    expect(consignmentProblem(url.toString())).not.toBe('')
  })
})
