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
