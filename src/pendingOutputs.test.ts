import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {Bearer} from './storage'
import type {NewBearer} from './WalletContext'

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key)
})

const DOMAIN = 'mint.example.test'
const NOW = 1_000_000_000_000
const SECRET = 'ab'.repeat(32)

let cashSecrets: typeof import('./cashSecrets')
let pending: typeof import('./pendingOutputs')
let lnurlcash: typeof import('./lnurlcash')

beforeEach(async () => {
  store.clear()
  vi.resetModules()
  cashSecrets = await import('./cashSecrets')
  pending = await import('./pendingOutputs')
  lnurlcash = await import('./lnurlcash')
})

const template = (k1 = 'cd'.repeat(32)): Bearer => ({
  id: 'tpl',
  url: `https://${DOMAIN}/w?k1=${k1}&amount=1000`,
  callback: `https://${DOMAIN}/w/cb`,
  amount: 1000,
  verified: true,
  spent: true,
  createdAt: 0,
  updatedAt: 0
})

const journaled = (): string[] =>
  Object.values(cashSecrets.pendingOutputSecrets())
    .flat()
    .map(e => e.secret)

const run = (
  held: Bearer[],
  fetchInfo: (url: string) => Promise<any>,
  ageMs = pending.PENDING_OUTPUT_MIN_AGE_MS + 1
) => {
  const added: NewBearer[] = []
  const result = pending.reconcilePendingOutputs({
    bearers: () => held,
    addBearer: async note => {
      added.push(note)
      cashSecrets.clearPendingOutputSecret(lnurlcash.noteK1(note.url)!)
      return {...note, id: 'x', createdAt: 0, updatedAt: 0}
    },
    logActivity: () => {},
    now: () => NOW + ageMs,
    fetchInfo: fetchInfo as typeof lnurlcash.fetchNoteInfo
  })
  return {result, added}
}

describe('reconcilePendingOutputs', () => {
  beforeEach(() => cashSecrets.recordPendingOutputSecret(DOMAIN, SECRET, NOW))

  it('adopts a live output, probing by the template url with its own k1', async () => {
    const fetchInfo = vi.fn(async (_url: string) => ({
      callback: `https://${DOMAIN}/w/cb`,
      maxWithdrawable: 4000
    }))
    const {result, added} = run([template()], fetchInfo)
    expect(await result).toEqual({recovered: 1, recoveredMsat: 4000})
    expect(lnurlcash.noteK1(fetchInfo.mock.calls[0][0])).toBe(SECRET)
    expect(lnurlcash.noteK1(added[0].url)).toBe(SECRET)
    expect(added[0].amount).toBe(4000)
    expect(journaled()).toEqual([])
  })

  it('skips entries young enough to still be in flight', async () => {
    const fetchInfo = vi.fn()
    const {result} = run([template()], fetchInfo, 1000)
    expect(await result).toEqual({recovered: 0, recoveredMsat: 0})
    expect(fetchInfo).not.toHaveBeenCalled()
    expect(journaled()).toEqual([SECRET])
  })

  it('clears an entry already held as a bearer without probing', async () => {
    const fetchInfo = vi.fn()
    const {result} = run([template(SECRET)], fetchInfo)
    await result
    expect(fetchInfo).not.toHaveBeenCalled()
    expect(journaled()).toEqual([])
  })

  it('drops a spent output', async () => {
    const {result} = run([template()], async () => {
      throw new lnurlcash.NoteSpentError('spent')
    })
    await result
    expect(journaled()).toEqual([])
  })

  it('keeps an output the mint does not know yet, until it expires', async () => {
    const unknown = async () => {
      throw new lnurlcash.NoteUnknownError('unknown')
    }
    await run([template()], unknown).result
    expect(journaled()).toEqual([SECRET])
    await run([template()], unknown, pending.PENDING_OUTPUT_MAX_AGE_MS + 1)
      .result
    expect(journaled()).toEqual([])
  })

  it('keeps everything when the mint cannot be reached', async () => {
    const {result} = run([template()], async () => {
      throw new lnurlcash.AmbiguousMintError('down')
    })
    await result
    expect(journaled()).toEqual([SECRET])
  })

  it('keeps an entry with no stored note on that mint to probe from', async () => {
    const fetchInfo = vi.fn()
    await run([], fetchInfo).result
    expect(fetchInfo).not.toHaveBeenCalled()
    expect(journaled()).toEqual([SECRET])
  })
})
