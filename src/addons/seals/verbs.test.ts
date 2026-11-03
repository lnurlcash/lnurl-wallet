import {afterEach, describe, expect, it, vi} from 'vitest'
import {schnorr, secp256k1} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, utf8ToBytes} from '@noble/hashes/utils.js'

// which mints this wallet "has pinned", by origin - empty unless a test
// says otherwise. Everything else about trustedMints.ts stays real.
const pins = vi.hoisted(() => new Map<string, string>())
vi.mock('../../trustedMints', async importOriginal => ({
  ...(await importOriginal<typeof import('../../trustedMints')>()),
  getTrustedMintPubkey: (server: string) => pins.get(server) ?? null,
  trustedMints: () =>
    [...pins].map(([server, mintPubkey]) => ({
      server,
      mintPubkey,
      addedAt: 0,
      locked: false
    }))
}))

import {VERBS, type VerbContext} from '../verbs'
import {
  decodeCp1,
  encodeCr1WithAmount,
  encodeCs1WithAmount,
  outputKeyOfCw1
} from '../../lnurlcash'
import {
  decodeSealConsignment,
  encodeSealConsignment,
  genesisState,
  planSealLock,
  sealCertificateProblem,
  type SealCertificate,
  type SealState
} from './seals'

const BASE = 'https://mock-mint.test'
const HOST = 'mock-mint.test'
const URL_TEMPLATE = `${BASE}/w`
const AMOUNT_MSAT = 20_000_000

const keypair = () => {
  const secretKey = schnorr.utils.randomSecretKey()
  return {
    secretKeyHex: bytesToHex(secretKey),
    pubkeyHex: bytesToHex(schnorr.getPublicKey(secretKey))
  }
}

const mintKeypair = () => {
  const priv = secp256k1.utils.randomSecretKey()
  return {priv, pub: bytesToHex(secp256k1.getPublicKey(priv, true))}
}

const signAs = (priv: Uint8Array, message: string): Uint8Array => {
  const digest = sha256(
    sha256(
      new Uint8Array([
        ...utf8ToBytes('Lightning Signed Message:'),
        ...utf8ToBytes(message)
      ])
    )
  )
  const sig = secp256k1.sign(digest, priv, {
    format: 'recovered',
    prehash: false
  })
  return new Uint8Array([...sig.subarray(1), sig[0]!])
}

type MockMint = {
  priv: Uint8Array
  pub: string
  // the key GET /w names as this mint's own - its real one unless a test
  // makes the server lie
  reportedPubkey: string
  // hex Q -> msat, for every note that is still unspent
  live: Map<string, number>
  // hex Q of a burned note -> the note it was rotated into
  burned: Map<string, {note: string; amountMsat: number}>
  // how many times /w/cb was asked
  rotates: number
  // what a rotate answers with, besides its cs1 - `attempt` counts the
  // answers for one and the same rotate, 1 for the first
  rotation: (
    spent: string,
    note: string,
    amountMsat: number,
    attempt: number
  ) => unknown
}

// A mint that holds notes by their output key and rotates one into another
// on a cw1 it does not check (signatures are the kernel's business, not
// this test's). Like lnurl-mint it certifies each rotate, refuses a second
// successor for a burned note, and answers an exact retry of a completed
// rotate with the same result again (LUD-25's Retrying a mutation).
const mockMint = (base = BASE): MockMint => {
  const {priv, pub} = mintKeypair()
  const attempts = new Map<string, number>()
  const mint: MockMint = {
    priv,
    pub,
    reportedPubkey: pub,
    live: new Map(),
    burned: new Map(),
    rotates: 0,
    rotation: (spent, note, amountMsat) =>
      encodeCr1WithAmount(
        amountMsat,
        signAs(priv, `LNURLcash:rotate:${amountMsat}:${spent}:${note}`)
      )
  }
  const keyOfCp1 = (cp1: string | null): string =>
    bytesToHex(decodeCp1(cp1 ?? '')!)
  const rotated = (spent: string, note: string, amountMsat: number) => {
    const attempt = (attempts.get(spent) ?? 0) + 1
    attempts.set(spent, attempt)
    const r = mint.rotation(spent, note, amountMsat, attempt)
    return {
      status: 'OK',
      c: encodeCs1WithAmount(
        amountMsat,
        signAs(priv, `LNURLcash:${amountMsat}:${note}`)
      ),
      ...(r === undefined ? {} : {r})
    }
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = new URL(input.toString())
      const body = (): Record<string, unknown> => {
        if (url.origin !== base) return {status: 'ERROR', reason: 'Not found'}
        if (url.pathname === '/w') {
          const key = keyOfCp1(url.searchParams.get('p'))
          if (mint.burned.has(key)) {
            return {status: 'ERROR', reason: 'Note already spent.'}
          }
          const amountMsat = mint.live.get(key)
          if (amountMsat === undefined) {
            return {status: 'ERROR', reason: 'Unknown note.'}
          }
          return {
            tag: 'withdrawRequest',
            callback: `${base}/w/cb`,
            minWithdrawable: amountMsat,
            maxWithdrawable: amountMsat,
            defaultDescription: 'lnurlcash bearer note',
            mintPubkey: mint.reportedPubkey
          }
        }
        mint.rotates++
        const spentKey = outputKeyOfCw1(url.searchParams.get('k1') ?? '')!
        const noteKey = keyOfCp1(url.searchParams.get('p1'))
        const before = mint.burned.get(spentKey)
        if (before) {
          return before.note === noteKey
            ? rotated(spentKey, noteKey, before.amountMsat)
            : {status: 'ERROR', reason: 'Invalid or already spent k1.'}
        }
        const amountMsat = mint.live.get(spentKey)
        if (amountMsat === undefined) {
          return {status: 'ERROR', reason: 'Invalid or already spent k1.'}
        }
        mint.live.delete(spentKey)
        mint.burned.set(spentKey, {note: noteKey, amountMsat})
        mint.live.set(noteKey, amountMsat)
        return rotated(spentKey, noteKey, amountMsat)
      }
      return {json: async () => body()} as Response
    })
  )
  return mint
}

const ctx = {} as VerbContext

type TransitionResult = {
  urlTemplate: string
  amountMsat: number
  state: SealState
  certificate: string | null
  certificateProblem: string
}

const transition = (
  state: SealState,
  ownerSecretKeyHex: string,
  nextOwnerPubkeyHex: string,
  amountMsat = AMOUNT_MSAT
) =>
  VERBS['seal.transition']!(
    {
      urlTemplate: URL_TEMPLATE,
      currentState: state,
      ownerSecretKeyHex,
      nextOwnerPubkeyHex,
      amountMsat
    },
    ctx
  ) as Promise<TransitionResult>

// a seal issued to `owners[0]` and handed on to each next owner in turn,
// with whatever certificates the mint really answered with
const issueAndTransfer = async (
  mint: MockMint,
  owners: ReturnType<typeof keypair>[],
  urlTemplate = URL_TEMPLATE
) => {
  const states = [genesisState('Art #1', 'one of one', owners[0]!.pubkeyHex)]
  mint.live.set(planSealLock(states[0]!).outputKeyHex, AMOUNT_MSAT)
  const certificates: SealCertificate[] = []
  for (let i = 1; i < owners.length; i++) {
    const result = await transition(
      states[i - 1]!,
      owners[i - 1]!.secretKeyHex,
      owners[i]!.pubkeyHex
    )
    states.push(result.state)
    if (result.certificate) {
      certificates.push({stateIndex: i, cr1: result.certificate})
    }
  }
  return {
    states,
    certificates,
    consignment: encodeSealConsignment(
      {urlTemplate, amountMsat: AMOUNT_MSAT},
      states,
      certificates
    )!
  }
}

const issued = (mint: MockMint) => {
  const [alice, bob] = [keypair(), keypair()]
  const genesis = genesisState('Art #1', '', alice.pubkeyHex)
  mint.live.set(planSealLock(genesis).outputKeyHex, AMOUNT_MSAT)
  return {alice, bob, genesis}
}

afterEach(() => {
  vi.unstubAllGlobals()
  pins.clear()
})

describe("VERBS['seal.transition']: the mint's certificate", () => {
  it('hands back the certificate the mint answered the rotate with', async () => {
    const mint = mockMint()
    const {alice, bob, genesis} = issued(mint)

    const result = await transition(genesis, alice.secretKeyHex, bob.pubkeyHex)
    expect(result.state.stateIndex).toBe(1)
    expect(result.state.ownerPubkeyHex).toBe(bob.pubkeyHex)
    expect(result.amountMsat).toBe(AMOUNT_MSAT)
    expect(result.certificate).toMatch(/^cr/)
    expect(result.certificateProblem).toBe('')
    // asked once: an answer that carries its certificate is not asked again
    expect(mint.rotates).toBe(1)

    // the consignment built from it is certified, start to end
    const consignment = encodeSealConsignment(
      {urlTemplate: result.urlTemplate, amountMsat: result.amountMsat},
      [genesis, result.state],
      [{stateIndex: 1, cr1: result.certificate!}]
    )
    expect(sealCertificateProblem(consignment, mint.pub)).toBe('')
    // and the mint really moved the note
    expect(mint.live.has(planSealLock(result.state).outputKeyHex)).toBe(true)
    expect(mint.burned.has(planSealLock(genesis).outputKeyHex)).toBe(true)
  })

  it('asks once more for a certificate the first answer lacked', async () => {
    // the mint could not sign when the rotate landed; the same request
    // again is the only way to its certificate, and nothing else ever is
    const mint = mockMint()
    const certify = mint.rotation
    mint.rotation = (spent, note, amountMsat, attempt) =>
      attempt === 1 ? undefined : certify(spent, note, amountMsat, attempt)
    const {alice, bob, genesis} = issued(mint)

    const result = await transition(genesis, alice.secretKeyHex, bob.pubkeyHex)
    expect(mint.rotates).toBe(2)
    expect(result.certificate).toMatch(/^cr/)
    expect(result.certificateProblem).toBe('')
    expect(
      sealCertificateProblem(
        encodeSealConsignment(
          {urlTemplate: URL_TEMPLATE, amountMsat: AMOUNT_MSAT},
          [genesis, result.state],
          [{stateIndex: 1, cr1: result.certificate!}]
        ),
        mint.pub
      )
    ).toBe('')
  })

  it('still transitions at a mint that issues no certificates', async () => {
    const mint = mockMint()
    mint.rotation = () => undefined
    const {alice, bob, genesis} = issued(mint)

    const result = await transition(genesis, alice.secretKeyHex, bob.pubkeyHex)
    expect(result.certificate).toBeNull()
    expect(result.certificateProblem).toBe('missing')
    expect(result.state.ownerPubkeyHex).toBe(bob.pubkeyHex)
    expect(mint.live.has(planSealLock(result.state).outputKeyHex)).toBe(true)
    // asked twice, no more
    expect(mint.rotates).toBe(2)
  })

  it('a second answer that is an error changes nothing about a landed transition', async () => {
    // a mint that issues none AND replays nothing
    const mint = mockMint()
    mint.rotation = (_spent, _note, _amountMsat, attempt) => {
      if (attempt > 1) throw new Error('this mint replays nothing')
      return undefined
    }
    const {alice, bob, genesis} = issued(mint)
    const result = await transition(genesis, alice.secretKeyHex, bob.pubkeyHex)
    expect(result.certificate).toBeNull()
    expect(result.state.ownerPubkeyHex).toBe(bob.pubkeyHex)
  })

  it('never hands on a certificate that is not this mint’s for this very step', async () => {
    const impostor = mintKeypair()
    const answers: ((mint: MockMint) => MockMint['rotation'])[] = [
      // signed by some other key
      () => (spent, note, amountMsat) =>
        encodeCr1WithAmount(
          amountMsat,
          signAs(
            impostor.priv,
            `LNURLcash:rotate:${amountMsat}:${spent}:${note}`
          )
        ),
      // the mint's OWN key, over another step: the direction reversed,
      mint => (spent, note, amountMsat) =>
        encodeCr1WithAmount(
          amountMsat,
          signAs(mint.priv, `LNURLcash:rotate:${amountMsat}:${note}:${spent}`)
        ),
      // another note than the one this transition created,
      mint => (spent, _note, amountMsat) =>
        encodeCr1WithAmount(
          amountMsat,
          signAs(
            mint.priv,
            `LNURLcash:rotate:${amountMsat}:${spent}:${'ab'.repeat(32)}`
          )
        ),
      // another amount,
      mint => (spent, note, amountMsat) =>
        encodeCr1WithAmount(
          amountMsat,
          signAs(
            mint.priv,
            `LNURLcash:rotate:${amountMsat + 1}:${spent}:${note}`
          )
        ),
      // or its certificate for the NOTE, dressed up as one for the rotation
      mint => (_spent, note, amountMsat) =>
        encodeCr1WithAmount(
          amountMsat,
          signAs(mint.priv, `LNURLcash:${amountMsat}:${note}`)
        )
    ]
    for (const answer of answers) {
      const mint = mockMint()
      mint.rotation = answer(mint)
      const {alice, bob, genesis} = issued(mint)
      const result = await transition(
        genesis,
        alice.secretKeyHex,
        bob.pubkeyHex
      )
      expect(result.certificate).toBeNull()
      expect(result.certificateProblem).toBe('invalid')
      // a certificate that is there but wrong is not asked for again
      expect(mint.rotates).toBe(1)
      vi.unstubAllGlobals()
    }
  })

  it('checks the certificate against the key this wallet pinned, not the one the server names', async () => {
    const mint = mockMint()
    const {alice, bob, genesis} = issued(mint)
    // the wallet knows this mint under another key than the one it signs
    // with now
    pins.set(BASE, mintKeypair().pub)
    const result = await transition(genesis, alice.secretKeyHex, bob.pubkeyHex)
    expect(result.certificate).toBeNull()
    expect(result.certificateProblem).toBe('invalid')

    // pinned to the key it does sign with, the same answer is certified
    vi.unstubAllGlobals()
    const again = mockMint()
    const second = issued(again)
    pins.set(BASE, again.pub)
    again.reportedPubkey = mintKeypair().pub
    const certified = await transition(
      second.genesis,
      second.alice.secretKeyHex,
      second.bob.pubkeyHex
    )
    expect(certified.certificate).toMatch(/^cr/)
  })

  it('moves nothing when the mint holds another amount than the consignment says', async () => {
    const mint = mockMint()
    const {alice, bob, genesis} = issued(mint)
    await expect(
      transition(genesis, alice.secretKeyHex, bob.pubkeyHex, AMOUNT_MSAT * 2)
    ).rejects.toThrow(/holds 20000000 msat .* not the 40000000 msat/)
    expect(mint.rotates).toBe(0)
    expect(mint.live.has(planSealLock(genesis).outputKeyHex)).toBe(true)
  })
})

type CheckResult = {
  consignment: string
  host: string
  live: boolean
  reason?: string
  amountMsat?: number
  mintPubkey: string | null
  mintPubkeyPinned: boolean
  keyKnownAs: string | null
  transitions: number
  certified: boolean | null
  certificateProblem: string
}

const check = (consignment: unknown) =>
  VERBS['seal.check']!({consignment}, ctx) as Promise<CheckResult>

describe("VERBS['seal.check']", () => {
  it('reports a seal that is live and certified at every transition - and who said so', async () => {
    const mint = mockMint()
    const {consignment} = await issueAndTransfer(mint, [
      keypair(),
      keypair(),
      keypair()
    ])
    expect(await check(`  ${consignment}\n`)).toEqual({
      consignment,
      host: HOST,
      live: true,
      amountMsat: AMOUNT_MSAT,
      mintPubkey: mint.pub,
      mintPubkeyPinned: false,
      keyKnownAs: null,
      transitions: 2,
      certified: true,
      certificateProblem: ''
    })
    // the same, at a mint this wallet has pinned
    pins.set(BASE, mint.pub)
    expect(await check(consignment)).toMatchObject({
      live: true,
      mintPubkeyPinned: true,
      certified: true
    })
  })

  it('reports a never-transferred seal as live, with nothing to certify', async () => {
    const mint = mockMint()
    const {consignment} = await issueAndTransfer(mint, [keypair()])
    const result = await check(consignment)
    expect(result.live).toBe(true)
    expect(result.transitions).toBe(0)
    expect(result.certified).toBe(true)
  })

  it('reports which transition the mint did not certify', async () => {
    const mint = mockMint()
    mint.rotation = () => undefined
    const {consignment} = await issueAndTransfer(mint, [keypair(), keypair()])
    const result = await check(consignment)
    expect(result.live).toBe(true)
    expect(result.certified).toBe(false)
    expect(result.certificateProblem).toMatch(/State 1: the mint did not/)
  })

  it('a look-alike on a note of its own is live, but not certified', async () => {
    // someone who knows the history mints their own note onto a made-up
    // next state: the mint holds it, the chain checks out - and no
    // certificate says the real note ever became it
    const mint = mockMint()
    const real = await issueAndTransfer(mint, [keypair(), keypair()])
    const forgedState: SealState = {
      ...real.states[1]!,
      ownerPubkeyHex: keypair().pubkeyHex
    }
    mint.live.set(planSealLock(forgedState).outputKeyHex, AMOUNT_MSAT)
    const forged = encodeSealConsignment(
      {urlTemplate: URL_TEMPLATE, amountMsat: AMOUNT_MSAT},
      [real.states[0]!, forgedState],
      real.certificates
    )!
    const result = await check(forged)
    expect(result.live).toBe(true)
    expect(result.certified).toBe(false)
    expect(result.certificateProblem).toMatch(/State 1: its certificate is not/)
    // the real one, side by side
    expect((await check(real.consignment)).certified).toBe(true)
  })

  it('a pinned key beats whatever key the server names', async () => {
    const mint = mockMint()
    const {consignment} = await issueAndTransfer(mint, [keypair(), keypair()])
    pins.set(BASE, mintKeypair().pub)
    const result = await check(consignment)
    expect(result.mintPubkeyPinned).toBe(true)
    expect(result.mintPubkey).toBe(pins.get(BASE))
    expect(result.certified).toBe(false)
  })

  it('a stale seal re-pointed at a server that lies is told apart by its host', async () => {
    // A past owner has a genuinely certified history of a seal that has
    // since moved on. They re-encode it to name a server of their own,
    // which answers "unspent" and names the REAL mint's key - public
    // information. The certificates do verify against that key.
    const real = mockMint()
    const {states, certificates} = await issueAndTransfer(real, [
      keypair(),
      keypair(),
      keypair()
    ])
    const stale = {states: states.slice(0, 2), certificates: [certificates[0]!]}
    vi.unstubAllGlobals()

    const LIAR = 'https://liar.test'
    const liar = mockMint(LIAR)
    liar.reportedPubkey = real.pub
    liar.live.set(planSealLock(stale.states[1]!).outputKeyHex, AMOUNT_MSAT)
    const repointed = encodeSealConsignment(
      {urlTemplate: `${LIAR}/w`, amountMsat: AMOUNT_MSAT},
      stale.states,
      stale.certificates
    )!

    // a wallet that knows the real mint: the answer names the host that
    // was asked, says it is not a pinned one, and says whose key that is
    pins.set(BASE, real.pub)
    expect(await check(repointed)).toMatchObject({
      host: 'liar.test',
      live: true,
      mintPubkey: real.pub,
      mintPubkeyPinned: false,
      keyKnownAs: HOST,
      certified: true
    })
    // a wallet that knows neither still learns which host answered, and
    // that nothing is pinned for it
    pins.clear()
    expect(await check(repointed)).toMatchObject({
      host: 'liar.test',
      mintPubkeyPinned: false,
      keyKnownAs: null
    })
  })

  it('says so when the history is out of date - and still checks its certificates against a pinned key', async () => {
    const mint = mockMint()
    const {states, certificates} = await issueAndTransfer(mint, [
      keypair(),
      keypair(),
      keypair()
    ])
    const stale = encodeSealConsignment(
      {urlTemplate: URL_TEMPLATE, amountMsat: AMOUNT_MSAT},
      states.slice(0, 2),
      certificates.slice(0, 1)
    )!
    // no pin: the mint named no key for a note it no longer holds
    expect(await check(stale)).toEqual({
      consignment: stale,
      host: HOST,
      live: false,
      reason: expect.stringMatching(/already spent/),
      mintPubkey: null,
      mintPubkeyPinned: false,
      keyKnownAs: null,
      transitions: 1,
      certified: null,
      certificateProblem: ''
    })
    // with a pin, the auditor of an old consignment gets a real answer
    pins.set(BASE, mint.pub)
    expect(await check(stale)).toMatchObject({
      live: false,
      mintPubkey: mint.pub,
      mintPubkeyPinned: true,
      certified: true
    })
  })

  it('says so when the mint knows no such note', async () => {
    mockMint()
    const consignment = encodeSealConsignment(
      {urlTemplate: URL_TEMPLATE, amountMsat: AMOUNT_MSAT},
      [genesisState('Art #1', '', keypair().pubkeyHex)]
    )!
    const result = await check(consignment)
    expect(result.live).toBe(false)
    expect(result.reason).toMatch(/knows no note/)
  })

  it('says so when the note is worth something else than the consignment claims', async () => {
    const mint = mockMint()
    const {states} = await issueAndTransfer(mint, [keypair()])
    const inflated = encodeSealConsignment(
      {urlTemplate: URL_TEMPLATE, amountMsat: AMOUNT_MSAT * 2},
      states
    )!
    const result = await check(inflated)
    expect(result.live).toBe(false)
    expect(result.reason).toMatch(/20000000 msat/)
  })

  it('refuses anything that is not a self-consistent consignment, before asking the mint', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(check('nope')).rejects.toThrow(/consignment/)
    const a = genesisState('Art #1', '', keypair().pubkeyHex)
    const broken = encodeSealConsignment(
      {urlTemplate: URL_TEMPLATE, amountMsat: AMOUNT_MSAT},
      [a, {...a, stateIndex: 1}]
    )!
    expect(decodeSealConsignment(broken)).not.toBeNull()
    await expect(check(broken)).rejects.toThrow(/chain/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
