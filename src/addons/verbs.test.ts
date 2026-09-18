import {afterEach, describe, expect, it, vi} from 'vitest'

import {buildTicketLabel, VERBS, type VerbContext} from './verbs'
import {parseLabelTags} from '../noteTags'
import type {Bearer} from '../storage'

const RAFFLE = {id: 'raffle', name: 'Raffle Tickets'}

describe('buildTicketLabel', () => {
  it('always tags with the addon name and a stable addon-<id> tag', () => {
    const label = buildTicketLabel(undefined, RAFFLE)
    const {tags} = parseLabelTags(label)
    expect(tags).toContain('addon-raffle')
    expect(tags).toContain('Raffle%20Tickets')
  })

  it('keeps the addon-supplied tags alongside the host-enforced ones', () => {
    const label = buildTicketLabel(['raffle:run-1', 'tier:Grand prize'], RAFFLE)
    const {tags} = parseLabelTags(label)
    expect(tags).toEqual([
      'raffle%3Arun-1',
      'tier%3AGrand%20prize',
      'Raffle%20Tickets',
      'addon-raffle'
    ])
  })

  it('cannot be spoofed by an addon-supplied tag with the same name', () => {
    // an addon can't remove or fake the host tag just by also asking for
    // one that looks like it - both simply end up present
    const label = buildTicketLabel(['addon-raffle'], RAFFLE)
    const {tags} = parseLabelTags(label)
    expect(tags.filter(t => t === 'addon-raffle')).toHaveLength(2)
  })
})

describe("VERBS['note.split']", () => {
  const BASE = 'https://mock-mint.test'
  const CALLBACK = `${BASE}/w/cb`
  const MINT_KEY = `02${'11'.repeat(32)}`

  afterEach(() => vi.unstubAllGlobals())

  const sourceBearer: Bearer = {
    id: 'source',
    url: `${BASE}/w?k1=${'a'.repeat(64)}&amount=20000000`,
    callback: CALLBACK,
    amount: 20_000_000, // msat - well above the two targets below
    verified: true,
    createdAt: 0,
    updatedAt: 0
  }

  const makeCtx = (): VerbContext => ({
    bearers: () => [sourceBearer],
    addBearer: async note => ({
      id: crypto.randomUUID(),
      ...note,
      createdAt: 0,
      updatedAt: 0
    }),
    updateBearer: async () => {},
    removeBearer: () => {},
    logActivity: () => {},
    deviceClient: () => null,
    requireDeviceClient: () => {
      throw new Error('no device in this test')
    },
    addon: {id: 'raffle', name: 'Raffle Tickets'}
  })

  // regression test for a real bug: the verb used to return amountSat via
  // helpers.ts's own msatToSats (a locale-formatted STRING for on-screen
  // display, e.g. "10,000") instead of a plain number, so summing several
  // tickets' amounts string-concatenated instead of adding - and it never
  // carried the input ticket's own index through at all (always undefined,
  // so a ticket number printed as NaN in the raffle PDF).
  it("returns a numeric amountSat and each ticket's own index, not a formatted string or undefined", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(input.toString())
      if (url.pathname === '/w/cb') {
        return {
          json: async () => ({
            status: 'OK',
            sig: '00'.repeat(65),
            sig2: '00'.repeat(65)
          })
        } as Response
      }
      if (url.pathname === '/w') {
        // echoes back whatever amount the settle GET asked about, as a
        // fee-free remainder - this test only cares about the verb's own
        // output shape, not fee accounting
        const amount = Number(url.searchParams.get('amount') ?? '0')
        return {
          json: async () => ({
            tag: 'withdrawRequest',
            callback: CALLBACK,
            mintPubkey: MINT_KEY,
            minWithdrawable: amount,
            maxWithdrawable: amount
          })
        } as Response
      }
      throw new Error(`unexpected request: ${url.pathname}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const tickets = [
      {index: 7, amountMsat: 10_000_000, tags: ['tier:big']},
      {index: 2, amountMsat: 5_000_000, tags: ['tier:small']}
    ]
    const result = (await VERBS['note.split']!(
      {note: 'source', tickets},
      makeCtx()
    )) as {index: number; amountSat: number}[]

    expect(result).toHaveLength(2)
    for (const r of result) expect(typeof r.amountSat).toBe('number')
    // arithmetic sum, not string concatenation ("10000" + "5000")
    expect(result.reduce((sum, r) => sum + r.amountSat, 0)).toBe(15000)
    // each output keeps its own input ticket's index (shuffled print
    // order), matched positionally - never undefined/NaN
    expect(result[0]!.index).toBe(7)
    expect(result[1]!.index).toBe(2)
  })
})

describe("VERBS['note.resolveAddressPubkey']", () => {
  const BASE = 'https://mock-mint.test'

  afterEach(() => vi.unstubAllGlobals())

  const bearer: Bearer = {
    id: 'source',
    url: `${BASE}/w?k1=${'a'.repeat(64)}&amount=20000000`,
    callback: `${BASE}/w/cb`,
    amount: 20_000_000,
    verified: true,
    createdAt: 0,
    updatedAt: 0
  }

  const makeCtx = (): VerbContext => ({
    bearers: () => [bearer],
    addBearer: async note => ({
      id: crypto.randomUUID(),
      ...note,
      createdAt: 0,
      updatedAt: 0
    }),
    updateBearer: async () => {},
    removeBearer: () => {},
    logActivity: () => {},
    deviceClient: () => null,
    requireDeviceClient: () => {
      throw new Error('no device in this test')
    },
    addon: {id: 'musig2', name: 'MuSig2 Playground'}
  })

  // 25.md's own published "Test vector 1" - pk_0's x-only form, and the
  // same underlying key encoded two self-contained ways (a cp1 note
  // address directly, and index 0 of its own branch's cx1 export) - see
  // src/lib/specVectors.test.ts for the byte-exact cross-check these are
  // drawn from.
  const PK0_XONLY =
    'aad3a0e36c083eb0d2d92ec0860977dc46d10c952f31830e6443b1faa1997634'
  const CP1 = 'cp14tf6pcmvpqltp5ke9mqgvzthm3rdzry49uccxrnygwcl4gvewc6qh2fkky'
  const CX1 =
    'cx1k7pa9ycdcpf6ju0sryz5efp70jw72rs8d80gwtw3mh096zl5e8g6hywvzxh28902dd3zj2npgl63aaq4p6l2qnn52ymmdpceugu0jpqes280t'

  it('decodes a cp1 address locally into its even-y compressed pubkey - no mint note or network needed', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await VERBS['note.resolveAddressPubkey']!(
      {address: CP1},
      makeCtx()
    )
    expect(result).toBe(`02${PK0_XONLY}`)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("derives a cx1 address's own index 0 locally - no mint note or network needed", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await VERBS['note.resolveAddressPubkey']!(
      {address: CX1},
      makeCtx()
    )
    expect(result).toBe(`02${PK0_XONLY}`)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a bare username with no mint note picked, before ever touching the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      VERBS['note.resolveAddressPubkey']!({address: 'alice'}, makeCtx())
    ).rejects.toThrow(/pick one of your notes/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("resolves a username against the picked note's own mint, via its published LUD-25 text/xpub hint - always at index 0, not the hint's own next-payable index", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      expect(new URL(input.toString()).toString()).toBe(
        `${BASE}/.well-known/lnurlp/alice`
      )
      return {
        json: async () => ({
          tag: 'payRequest',
          callback: `${BASE}/p/cb`,
          minSendable: 1000,
          maxSendable: 100000000,
          metadata: JSON.stringify([
            ['text/plain', 'pay alice'],
            ['text/xpub', `${CX1}:3`]
          ])
        })
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    // uppercase, to also confirm this is lowercased before both the
    // pattern check and the lookup itself
    const result = await VERBS['note.resolveAddressPubkey']!(
      {mintNote: 'source', address: 'ALICE'},
      makeCtx()
    )
    expect(result).toBe(`02${PK0_XONLY}`)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // a different domain than BASE (the wallet's own mint) - proves the
  // lookup names its own mint and never falls back to the picked note's
  // one, unlike the bare-username path below
  const OTHER_MINT = 'https://another-mint.test'

  it('resolves a full Lightning Address (any domain) directly, with no mint note needed', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      expect(new URL(input.toString()).toString()).toBe(
        `${OTHER_MINT}/.well-known/lnurlp/alice`
      )
      return {
        json: async () => ({
          tag: 'payRequest',
          callback: `${OTHER_MINT}/p/cb`,
          minSendable: 1000,
          maxSendable: 100000000,
          metadata: JSON.stringify([
            ['text/plain', 'pay alice'],
            ['text/xpub', `${CX1}:3`]
          ])
        })
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    // no mintNote arg at all - unlike the bare-username path, a full
    // Lightning Address names its own domain
    const result = await VERBS['note.resolveAddressPubkey']!(
      {address: `alice@${OTHER_MINT.replace('https://', '')}`},
      makeCtx()
    )
    expect(result).toBe(`02${PK0_XONLY}`)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a Lightning Address whose mint never published a LUD-25 address (no text/xpub)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({
          tag: 'payRequest',
          callback: `${OTHER_MINT}/p/cb`,
          minSendable: 1000,
          maxSendable: 100000000,
          metadata: JSON.stringify([['text/plain', 'pay alice']])
        })
      })) as unknown as typeof fetch
    )
    await expect(
      VERBS['note.resolveAddressPubkey']!(
        {address: `alice@${OTHER_MINT.replace('https://', '')}`},
        makeCtx()
      )
    ).rejects.toThrow(/LUD-25 address/)
  })

  it('rejects a username whose mint never published a LUD-25 address (no text/xpub)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({
          tag: 'payRequest',
          callback: `${BASE}/p/cb`,
          minSendable: 1000,
          maxSendable: 100000000,
          metadata: JSON.stringify([['text/plain', 'pay bob']])
        })
      })) as unknown as typeof fetch
    )
    await expect(
      VERBS['note.resolveAddressPubkey']!(
        {mintNote: 'source', address: 'bob'},
        makeCtx()
      )
    ).rejects.toThrow(/LUD-25 address/)
  })

  it('rejects input that is neither a valid pubkey-bearing address nor a valid username', async () => {
    await expect(
      VERBS['note.resolveAddressPubkey']!(
        {address: 'not a valid one!'},
        makeCtx()
      )
    ).rejects.toThrow(/Not a valid/)
  })
})
