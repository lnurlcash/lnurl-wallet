import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {
  pressKey,
  amountSats,
  canCharge,
  isPaid,
  keepPolling,
  awaitingPayment,
  statusText,
  claimText
} from './keypad'
import {posAddon} from './manifest'
import {validateManifest} from '../validate'
import {VERBS, type VerbContext} from '../verbs'
import type {RegisteredAddress} from '../../addressRegistry'

// the scan itself is addressRecovery.ts's own, tested there - here only
// whether checkPayment calls it, for which address, and what it reports
const scanMock = vi.hoisted(() => vi.fn())
const registered = vi.hoisted(() => ({list: [] as RegisteredAddress[]}))
vi.mock('../../addressRecovery', () => ({runAddressScan: scanMock}))
vi.mock('../../addressRegistry', () => ({
  registeredAddresses: () => registered.list
}))
vi.mock('../../cashSecrets', async importOriginal => ({
  ...(await importOriginal<object>()),
  hasCashRoot: () => true
}))

const BASE = 'https://mock-mint.test'
const ADDRESS = 'alice@mock-mint.test'
// amountless, so requestInvoice has no amount of its own to cross-check
const PR = 'lnbc1pexampleinvoice'
const VERIFY = `${BASE}/verify/${'ab'.repeat(32)}`
const INVOICE = {address: ADDRESS, amountSat: 2100, pr: PR, verify: VERIFY}

const makeCtx = (): VerbContext => ({
  bearers: () => [],
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
  addon: {id: 'pos', name: 'Point of Sale'}
})

const respond = (routes: Record<string, unknown>) =>
  vi.fn(async (input: string | URL) => {
    const url = new URL(input.toString())
    const body = routes[url.origin + url.pathname]
    if (body === undefined) throw new Error(`unexpected fetch ${url}`)
    return {json: async () => body} as Response
  })

describe('pos keypad', () => {
  it('types digits, never with a leading zero', () => {
    expect(pressKey('0', '7')).toBe('7')
    expect(pressKey('7', '0')).toBe('70')
    expect(pressKey('0', '0')).toBe('0')
  })

  it('backspaces and clears down to "0", never ""', () => {
    expect(pressKey('123', '⌫')).toBe('12')
    expect(pressKey('1', '⌫')).toBe('0')
    expect(pressKey('123', 'C')).toBe('0')
  })

  it('stops at 8 digits and ignores anything that is not a key', () => {
    expect(pressKey('12345678', '9')).toBe('12345678')
    expect(pressKey('12', 'x')).toBe('12')
    expect(pressKey('garbage', '5')).toBe('5')
  })

  it('only charges a positive amount to a picked address', () => {
    expect(amountSats('2100')).toBe(2100)
    expect(amountSats('0')).toBe(0)
    expect(canCharge({address: ADDRESS}, '2100')).toBe(true)
    expect(canCharge(null, '2100')).toBe(false)
    expect(canCharge({address: ADDRESS}, '0')).toBe(false)
  })
})

describe('pos payment status', () => {
  it('ignores a status left over from a previous invoice', () => {
    const stale = {pr: 'lnbc1pprevious', settled: true, claimedSats: 5}
    expect(isPaid(INVOICE, stale)).toBe(false)
    expect(awaitingPayment(INVOICE, stale)).toBe(true)
    expect(keepPolling(INVOICE, stale)).toBe(true)
    expect(claimText(INVOICE, stale)).toBe('')
  })

  it('stops polling once settled, or on an invoice mismatch', () => {
    expect(keepPolling(INVOICE, {pr: PR, settled: false})).toBe(true)
    expect(keepPolling(INVOICE, {pr: PR, settled: true})).toBe(false)
    expect(keepPolling(INVOICE, {pr: PR, settled: false, mismatch: true})).toBe(
      false
    )
  })

  it('never polls an invoice whose mint offers no verify URL', () => {
    const noVerify = {...INVOICE, verify: null}
    expect(keepPolling(noVerify, null)).toBe(false)
    expect(statusText(noVerify, null)).toMatch(/doesn't report payment status/)
  })

  it('reports what the claim found', () => {
    const paid = (extra: object) => ({pr: PR, settled: true, ...extra})
    expect(claimText(INVOICE, paid({claimedSats: 2079}))).toBe(
      '2,079 sats added to your wallet.'
    )
    expect(claimText(INVOICE, paid({claimedSats: 0}))).toMatch(/Already/)
    expect(claimText(INVOICE, paid({claimedSats: null}))).toMatch(/Mint page/)
    expect(
      claimText(INVOICE, paid({claimedSats: null, claimError: 'offline'}))
    ).toMatch(/offline/)
  })

  it('has a manifest that passes validateManifest', () => {
    expect(() => validateManifest(posAddon.manifest)).not.toThrow()
  })
})

describe("VERBS['lnaddress.invoice']", () => {
  afterEach(() => vi.unstubAllGlobals())

  const PAY_REQUEST = {
    tag: 'payRequest',
    callback: `${BASE}/p/alice`,
    minSendable: 1000,
    maxSendable: 100_000_000,
    metadata: JSON.stringify([['text/plain', 'pay alice']])
  }

  it('asks the address for an invoice of exactly the typed amount', async () => {
    const fetchMock = respond({
      [`${BASE}/.well-known/lnurlp/alice`]: PAY_REQUEST,
      [`${BASE}/p/alice`]: {pr: PR, verify: VERIFY, routes: []}
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await VERBS['lnaddress.invoice']!(
      {address: ADDRESS, amountSat: 2100},
      makeCtx()
    )
    expect(result).toEqual(INVOICE)
    const callback = new URL(fetchMock.mock.calls[1]![0].toString())
    expect(callback.searchParams.get('amount')).toBe('2100000')
    expect(callback.searchParams.has('comment')).toBe(false)
  })

  it("refuses an amount outside the address's own sendable range", async () => {
    vi.stubGlobal(
      'fetch',
      respond({[`${BASE}/.well-known/lnurlp/alice`]: PAY_REQUEST})
    )
    await expect(
      VERBS['lnaddress.invoice']!(
        {address: ADDRESS, amountSat: 200_000},
        makeCtx()
      )
    ).rejects.toThrow('accepts between 1 and 100,000 sats')
  })

  it('refuses before any fetch without an address or amount', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      VERBS['lnaddress.invoice']!({address: '', amountSat: 10}, makeCtx())
    ).rejects.toThrow('Pick a Lightning Address')
    await expect(
      VERBS['lnaddress.invoice']!({address: ADDRESS, amountSat: 0}, makeCtx())
    ).rejects.toThrow('Enter an amount')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("VERBS['lnaddress.checkPayment']", () => {
  beforeEach(() => {
    scanMock.mockReset()
    registered.list = [
      {server: BASE, username: 'alice', registeredAt: 0, nextScanIndex: 4}
    ]
  })
  afterEach(() => vi.unstubAllGlobals())

  const verifyReturns = (body: unknown) =>
    vi.stubGlobal('fetch', respond({[VERIFY]: body}))

  it('reports unpaid without scanning', async () => {
    verifyReturns({settled: false, preimage: null, pr: PR})
    const result = await VERBS['lnaddress.checkPayment']!(
      {invoice: INVOICE},
      makeCtx()
    )
    expect(result).toEqual({pr: PR, settled: false})
    expect(scanMock).not.toHaveBeenCalled()
  })

  it('once settled, claims via a scan of that registered address', async () => {
    verifyReturns({settled: true, preimage: null, pr: PR})
    scanMock.mockResolvedValue({recovered: [{amount: 2_079_000}]})
    const result = await VERBS['lnaddress.checkPayment']!(
      {invoice: INVOICE},
      makeCtx()
    )
    expect(result).toEqual({pr: PR, settled: true, claimedSats: 2079})
    expect(scanMock).toHaveBeenCalledWith(
      BASE,
      'alice',
      [],
      expect.anything(),
      {startIndex: 4}
    )
  })

  it('does not scan an address this wallet never registered', async () => {
    registered.list = []
    verifyReturns({settled: true, preimage: null, pr: PR})
    const result = await VERBS['lnaddress.checkPayment']!(
      {invoice: INVOICE},
      makeCtx()
    )
    expect(result).toEqual({pr: PR, settled: true, claimedSats: null})
    expect(scanMock).not.toHaveBeenCalled()
  })

  it('flags a verify response for a different invoice, never as paid', async () => {
    verifyReturns({settled: true, preimage: null, pr: 'lnbc1pother'})
    const result = (await VERBS['lnaddress.checkPayment']!(
      {invoice: INVOICE},
      makeCtx()
    )) as {settled: boolean; mismatch?: boolean}
    expect(result.settled).toBe(false)
    expect(result.mismatch).toBe(true)
    expect(scanMock).not.toHaveBeenCalled()
  })

  it('returns a failed check as an error instead of throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      })
    )
    const result = (await VERBS['lnaddress.checkPayment']!(
      {invoice: INVOICE},
      makeCtx()
    )) as {settled: boolean; error?: string}
    expect(result.settled).toBe(false)
    expect(result.error).toBeTruthy()
  })
})
