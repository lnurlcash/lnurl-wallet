import {describe, expect, it} from 'vitest'
import {schnorr, secp256k1} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, utf8ToBytes} from '@noble/hashes/utils.js'
import {encodeCr1WithAmount} from '../../lib/recoverableNotes'
import {sealsAddon} from './manifest'
import {
  decodeSealConsignment,
  encodeSealConsignment,
  genesisState,
  nextState,
  planSealLock,
  sealCertificateProblem,
  type SealCertificate,
  type SealState
} from './seals'

// The seals manifest's own helpers around certificates and "Check at the
// mint": what a holder is shown, for each thing a mint or a liar can answer.

const helper = (name: string) =>
  sealsAddon.helpers[name] as (...args: unknown[]) => any

const AMOUNT_MSAT = 20_000_000
const HOST = 'mint.example.com'
const LOCKED = {urlTemplate: `https://${HOST}/w`, amountMsat: AMOUNT_MSAT}

const ownerKey = (): string =>
  bytesToHex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()))

const mintPriv = secp256k1.utils.randomSecretKey()
const mintPub = bytesToHex(secp256k1.getPublicKey(mintPriv, true))

const certify = (
  from: SealState,
  to: SealState,
  amountMsat = AMOUNT_MSAT
): string => {
  const digest = sha256(
    sha256(
      new Uint8Array([
        ...utf8ToBytes('Lightning Signed Message:'),
        ...utf8ToBytes(
          `LNURLcash:rotate:${amountMsat}:${planSealLock(from).outputKeyHex}:${planSealLock(to).outputKeyHex}`
        )
      ])
    )
  )
  const sig = secp256k1.sign(digest, mintPriv, {
    format: 'recovered',
    prehash: false
  })
  return encodeCr1WithAmount(
    amountMsat,
    new Uint8Array([...sig.subarray(1), sig[0]!])
  )
}

const history = (transfers: number) => {
  const states = [genesisState('Art #1', 'one of one', ownerKey())]
  const certificates: SealCertificate[] = []
  for (let i = 1; i <= transfers; i++) {
    const next = nextState(states[i - 1]!, ownerKey())
    certificates.push({stateIndex: i, cr1: certify(states[i - 1]!, next)})
    states.push(next)
  }
  return {
    states,
    certificates,
    consignment: encodeSealConsignment(LOCKED, states, certificates)!
  }
}

// what verbs.ts's seal.transition answers with
const transitionOf = (
  states: SealState[],
  over: Record<string, unknown> = {}
) => {
  const current = states[states.length - 1]!
  const state = nextState(current, ownerKey())
  return {
    urlTemplate: LOCKED.urlTemplate,
    amountMsat: AMOUNT_MSAT,
    state,
    certificate: certify(current, state),
    certificateProblem: '',
    ...over
  }
}

describe('nextConsignment', () => {
  it('carries the history’s certificates on and adds the new one', () => {
    const {states, consignment} = history(2)
    const result = transitionOf(states)
    const next = helper('nextConsignment')(consignment, result)
    const parsed = decodeSealConsignment(next)!
    expect(parsed.states).toHaveLength(4)
    expect(parsed.certificates.map(c => c.stateIndex)).toEqual([1, 2, 3])
    expect(sealCertificateProblem(parsed, mintPub)).toBe('')
  })

  it('is still built when the mint held another amount than the old header said', () => {
    // The verb refuses to move such a seal - but a transition that landed
    // must never be left without its consignment, so the helper does not
    // depend on that. The certificates are the mint's, over the amount the
    // mint held all along; only the old header was wrong.
    const real = AMOUNT_MSAT
    const states = [genesisState('Art #1', '', ownerKey())]
    const first = nextState(states[0]!, ownerKey())
    const certificates = [{stateIndex: 1, cr1: certify(states[0]!, first)}]
    const honest = decodeSealConsignment(
      encodeSealConsignment(LOCKED, [states[0]!, first], certificates)
    )!
    // the same history under a header that claims twice the value: its
    // certificates are re-labelled with that claim, as any decoded ones are
    const lying = encodeSealConsignment(
      {urlTemplate: LOCKED.urlTemplate, amountMsat: real * 2},
      honest.states,
      honest.certificates.map(c => ({
        stateIndex: c.stateIndex,
        cr1: encodeCr1WithAmount(real * 2, new Uint8Array(65))
      }))
    )!
    expect(decodeSealConsignment(lying)!.amountMsat).toBe(real * 2)
    const result = transitionOf(honest.states)
    const next = helper('nextConsignment')(lying, result)
    expect(next).not.toBeNull()
    expect(decodeSealConsignment(next)!.amountMsat).toBe(real)
    expect(decodeSealConsignment(next)!.states).toHaveLength(3)
    // and from the honest one, the whole history stays certified
    expect(
      sealCertificateProblem(
        helper('nextConsignment')(
          encodeSealConsignment(LOCKED, honest.states, honest.certificates),
          result
        ),
        mintPub
      )
    ).toBe('')
  })

  it('goes on without a certificate the mint did not give', () => {
    const {states, consignment} = history(1)
    const next = helper('nextConsignment')(
      consignment,
      transitionOf(states, {certificate: null, certificateProblem: 'missing'})
    )
    const parsed = decodeSealConsignment(next)!
    expect(parsed.certificates.map(c => c.stateIndex)).toEqual([1])
    expect(sealCertificateProblem(parsed, mintPub)).toMatch(/State 2/)
  })
})

describe('transitionFollows', () => {
  it('holds only for the consignment the transition extended', () => {
    const {states, consignment} = history(1)
    const result = transitionOf(states)
    expect(helper('transitionFollows')(consignment, result)).toBe(true)
    // not under the history it produced,
    const next = helper('nextConsignment')(consignment, result)
    expect(helper('transitionFollows')(next, result)).toBe(false)
    // nor under another seal, nor with nothing at all
    expect(helper('transitionFollows')(history(1).consignment, result)).toBe(
      false
    )
    expect(helper('transitionFollows')(consignment, null)).toBe(false)
    expect(helper('transitionFollows')('', result)).toBe(false)
  })

  it('holds for a landed transition even where no consignment can be built', () => {
    const {states, consignment} = history(1)
    // a result with an amount no consignment can carry
    const broken = transitionOf(states, {amountMsat: 0})
    expect(helper('nextConsignment')(consignment, broken)).toBeNull()
    expect(helper('transitionFollows')(consignment, broken)).toBe(true)
    // and its state can still be read off the page
    expect(JSON.parse(helper('transitionStateText')(broken))).toEqual(
      broken.state
    )
  })
})

describe('transitionCertificateLine', () => {
  it('tells a certified step from an uncertified one, and why', () => {
    const {states} = history(0)
    expect(helper('transitionCertificateLine')(transitionOf(states))).toMatch(
      /^✓ The mint certified this transition/
    )
    expect(
      helper('transitionCertificateLine')(
        transitionOf(states, {certificate: null, certificateProblem: 'missing'})
      )
    ).toMatch(/did not certify this transition/)
    expect(
      helper('transitionCertificateLine')(
        transitionOf(states, {certificate: null, certificateProblem: 'invalid'})
      )
    ).toMatch(/not its own for this step/)
    expect(helper('transitionCertificateLine')(null)).toBe('')
  })
})

describe('checkReport', () => {
  const {states, consignment} = history(2)
  const answer = (over: Record<string, unknown> = {}) => ({
    consignment,
    host: HOST,
    live: true,
    amountMsat: AMOUNT_MSAT,
    mintPubkey: mintPub,
    mintPubkeyPinned: true,
    keyKnownAs: null,
    transitions: 2,
    certified: true,
    certificateProblem: '',
    ...over
  })
  const report = (result: unknown, input: unknown = consignment) =>
    helper('checkReport')(input, result, null) as string[]

  it('names the host first, whatever it answered', () => {
    for (const result of [
      answer(),
      answer({mintPubkeyPinned: false}),
      answer({live: false, reason: 'gone', certified: null, mintPubkey: null})
    ]) {
      expect(report(result)[0]).toBe(`Asked ${HOST}.`)
    }
    expect(helper('consignmentHost')(consignment)).toBe(HOST)
    expect(helper('consignmentHost')('nope')).toBe('')
  })

  it('gives a pinned mint’s answer its check marks', () => {
    const lines = report(answer())
    expect(lines).toEqual([
      `Asked ${HOST}.`,
      `✓ Live at ${HOST} - its current note is unspent and worth ${AMOUNT_MSAT} msat.`,
      expect.stringMatching(
        /^✓ Every one of its 2 transition\(s\) is certified by the key this wallet has pinned/
      ),
      `Key: ${mintPub}`
    ])
  })

  it('gives an unpinned server’s answer none, and says it is that server’s word', () => {
    const lines = report(answer({mintPubkeyPinned: false}))
    expect(lines.filter(line => line.startsWith('✓'))).toEqual([])
    expect(lines[1]).toBe(
      `${HOST} says its current note is unspent and worth ${AMOUNT_MSAT} msat.`
    )
    expect(lines[2]).toMatch(/certified by the key mint\.example\.com names/)
    expect(lines[lines.length - 1]).toMatch(
      /^⚠ This wallet has no key pinned for mint\.example\.com.*anyone can run a server/
    )
  })

  it('warns when the key named belongs to another mint this wallet knows', () => {
    const lines = report(
      answer({
        host: 'liar.test',
        mintPubkeyPinned: false,
        keyKnownAs: HOST
      })
    )
    expect(lines[0]).toBe('Asked liar.test.')
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^⚠ This wallet knows that key as mint\.example\.com's\. liar\.test is another address/
      )
    )
  })

  it('reports a spent note, with or without a key to check the certificates', () => {
    const gone = {live: false, reason: 'Its current note is already spent.'}
    expect(
      report(answer({...gone, certified: null, mintPubkey: null}))
    ).toEqual([
      `Asked ${HOST}.`,
      '✗ Its current note is already spent.',
      expect.stringMatching(/could not be checked: this wallet has no key/)
    ])
    const unpinned = report(
      answer({
        ...gone,
        certified: null,
        mintPubkey: null,
        mintPubkeyPinned: false
      })
    )
    expect(unpinned[unpinned.length - 1]).toMatch(/^⚠ This wallet has no key/)
    expect(report(answer(gone))).toContainEqual(
      expect.stringMatching(/^✓ Every one of its 2 transition/)
    )
  })

  it('reports an uncertified history and a never-transferred seal', () => {
    expect(
      report(
        answer({
          certified: false,
          certificateProblem:
            'State 1: the mint did not certify this transition.'
        })
      )
    ).toContain(
      '✗ Not fully certified - State 1: the mint did not certify this transition.'
    )
    expect(report(answer({transitions: 0}))).toContainEqual(
      expect.stringMatching(/^Never transferred/)
    )
  })

  it('shows nothing under another consignment, or once the seal has moved on', () => {
    expect(report(answer(), history(1).consignment)).toEqual([])
    expect(report(null)).toEqual([])
    // "unspent" stopped being true when this very seal was transitioned
    const moved = transitionOf(states)
    expect(helper('checkReport')(consignment, answer(), moved)).toEqual([])
    // an answer that already says it is gone is as true as it was
    expect(
      helper('checkReport')(
        consignment,
        answer({live: false, reason: 'Its current note is already spent.'}),
        moved
      )
    ).toContain('✗ Its current note is already spent.')
  })
})

describe('offlineCertificateLine', () => {
  it('checks a history against a typed-in mint key, with no network', () => {
    const {states, certificates, consignment} = history(2)
    expect(helper('offlineCertificateLine')(consignment, mintPub)).toMatch(
      /^✓ Every one of its 2 transition\(s\) is certified by this key/
    )
    const other = bytesToHex(
      secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)
    )
    expect(helper('offlineCertificateLine')(consignment, other)).toMatch(
      /^✗ State 1: its certificate is not this mint/
    )
    expect(
      helper('offlineCertificateLine')(
        encodeSealConsignment(LOCKED, states, [certificates[1]!]),
        mintPub
      )
    ).toMatch(/^✗ State 1: the mint did not certify/)
    expect(helper('offlineCertificateLine')(consignment, 'nope')).toMatch(
      /^✗ Missing the mint’s own signing key/
    )
    expect(
      helper('offlineCertificateLine')(history(0).consignment, mintPub)
    ).toMatch(/^Never transferred/)
    // nothing to say until there is a key and a consignment
    expect(helper('offlineCertificateLine')(consignment, '')).toBe('')
    expect(helper('offlineCertificateLine')('', mintPub)).toBe('')
  })
})
