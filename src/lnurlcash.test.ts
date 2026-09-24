import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  generateNoteSecret,
  hashK1,
  isPreimage,
  isCk1,
  isCp1,
  MIN_COMMENT_LENGTH_FOR_SECRET
} from './lnurlcash'
import {hexToBytes} from '@noble/hashes/utils.js'
import {bearerNoteIdOfPreimage} from './lib/spend'
import {encodeCp1} from './lib/recoverableNotes'

const bearerCp1 = (secret: string): string =>
  encodeCp1(hexToBytes(bearerNoteIdOfPreimage(secret)))

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

  it("falls back to a bearer note's cp1 when the mint rejects the key-path cp1", async () => {
    const comments: string[] = []
    const fetchMock = vi.fn(async (input: string | URL) => {
      const comment = new URL(input.toString()).searchParams.get('comment')!
      comments.push(comment)
      if (comments.length === 1) {
        return {
          json: async () => ({
            status: 'ERROR',
            reason: 'Missing or malformed comment.'
          })
        } as Response
      }
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
    // one rejected key-path attempt, then the bearer note, also as a cp1
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(comments[1]).toBe(bearerCp1(secret))
  })

  it("falls back to a bearer note's cp1 when no cash root is loaded at all", async () => {
    // Part 2's pubkey secret needs a cash root (requireRecoverableCashAddressSecret
    // throws without one); Part 1's plain secret does not (25.md's Part 1
    // defines no derivation at all - see cashSecrets.ts's header comment),
    // so the bearer fallback still succeeds even fully locked
    const cashSecrets = await import('./cashSecrets')
    cashSecrets.setCashRoot(null)
    const comments: string[] = []
    const fetchMock = vi.fn(async (input: string | URL) => {
      comments.push(new URL(input.toString()).searchParams.get('comment')!)
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
    // the Part 2 attempt fails locally (no cash root) before ever reaching
    // the network, so only the bearer request is ever sent
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(comments[0]).toBe(bearerCp1(secret))
  })
})
