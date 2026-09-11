import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  generateNoteSecret,
  hashK1,
  isPreimage,
  isCk1,
  isCp1,
  MIN_COMMENT_LENGTH_FOR_SECRET
} from './lnurlcash'

// Everything else this file used to test now lives in src/lib/*.test.ts,
// mirroring the protocol code's own extraction into src/lib (see its
// README) - generateNoteSecret is the one piece that stays wallet-specific
// (src/lib/secrets.ts only defines the injection point, see
// configureSecretProvider in this module), so it's the one test that
// stays here rather than moving with the rest.
describe('generateNoteSecret', () => {
  it('generateNoteSecret + hashK1 produce exactly a 64-char hex comment', () => {
    const secret = generateNoteSecret('mint.example.com')
    expect(isPreimage(secret)).toBe(true)
    const comment = hashK1(secret)
    expect(comment).toMatch(/^[0-9a-f]{64}$/)
    expect(comment.length).toBe(MIN_COMMENT_LENGTH_FOR_SECRET)
    // deterministic - SERVICE must be able to key its note by the same
    // hash WALLET discloses up front
    expect(hashK1(secret)).toBe(comment)
  })
})

describe('requestMintInvoice (LUD-25 Part 2 dispatch)', () => {
  // same in-memory localStorage stand-in as cashSecrets.test.ts - both the
  // legacy and Part 2 secret generators persist their own "next index"
  // counters there. Re-stubbed fresh every test (rather than once at
  // describe-scope, cashSecrets.test.ts's own approach) since this file's
  // own afterEach also unstubs 'fetch' per test via unstubAllGlobals,
  // which would otherwise tear this one down too after the first test.
  const store = new Map<string, string>()

  const SEED =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  const CALLBACK = 'https://mint.example.com/p/cb'

  let lnurlcash: typeof import('./lnurlcash')

  beforeEach(async () => {
    store.clear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) =>
        void store.set(key, String(value)),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: () => null,
      get length() {
        return store.size
      }
    })
    vi.resetModules()
    lnurlcash = await import('./lnurlcash')
    const cashSecrets = await import('./cashSecrets')
    const keys = await import('./keys')
    cashSecrets.setCashRoot(keys.deriveLud25CashRootNode(SEED))
  })

  afterEach(() => vi.unstubAllGlobals())

  it('prefers a cp1 pubkey comment when the mint accepts it', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const comment = new URL(input.toString()).searchParams.get('comment')!
      expect(isCp1(comment)).toBe(true)
      return {json: async () => ({pr: 'lnbc1testinvoice'})} as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    const {result, secret} = await lnurlcash.requestMintInvoice(
      CALLBACK,
      1000,
      'mint.example.com'
    )
    expect(isCk1(secret)).toBe(true)
    expect(result.pr).toBe('lnbc1testinvoice')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to the legacy hash comment when the mint rejects cp1', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const comment = new URL(input.toString()).searchParams.get('comment')!
      if (isCp1(comment)) {
        return {
          json: async () => ({
            status: 'ERROR',
            reason: 'Missing or malformed comment.'
          })
        } as Response
      }
      expect(comment).toMatch(/^[0-9a-f]{64}$/)
      return {json: async () => ({pr: 'lnbc1testinvoice'})} as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    const {result, secret} = await lnurlcash.requestMintInvoice(
      CALLBACK,
      1000,
      'mint.example.com'
    )
    expect(isPreimage(secret)).toBe(true)
    expect(result.pr).toBe('lnbc1testinvoice')
    // one rejected cp1 attempt, then the successful legacy retry
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('propagates a failure when no cash root is loaded at all (neither scheme can generate a secret)', async () => {
    const cashSecrets = await import('./cashSecrets')
    cashSecrets.setCashRoot(null)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      lnurlcash.requestMintInvoice(CALLBACK, 1000, 'mint.example.com')
    ).rejects.toThrow(/seed-derived cash key/)
    // neither attempt ever reaches the network - both secret generators
    // fail before any invoice request is made
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
