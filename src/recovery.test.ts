import {beforeEach, describe, expect, it, vi} from 'vitest'
import {hashK1 as sha256Hex} from './lnurlcash'
import type {Bearer} from './storage'

// same in-memory localStorage stand-in as cashSecrets.test.ts/storage.test.ts -
// cashSecrets.ts persists per-SERVICE indices there, and a fresh module
// graph per test keeps them from bleeding across cases
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
  key: () => null,
  get length() {
    return store.size
  }
})

const SEED =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const SERVER = 'mock-mint.test'
const WITHDRAW_CALLBACK = `https://${SERVER}/w/cb`

let recovery: typeof import('./recovery')
let cashSecrets: typeof import('./cashSecrets')
let keys: typeof import('./keys')
let gapLimit: typeof import('./gapLimit')

beforeEach(async () => {
  store.clear()
  vi.resetModules()
  recovery = await import('./recovery')
  cashSecrets = await import('./cashSecrets')
  keys = await import('./keys')
  gapLimit = await import('./gapLimit')
  cashSecrets.setCashRoot(keys.deriveLud25CashRootNode(SEED))
})

// mocked fetch response shape matches mockMint.test.ts's own convention -
// lnurlFetch only ever calls .json() on the result, never inspects
// status/ok, so a bare {json} stand-in is enough
// LUD-25 made offline verification mandatory on 2026-09-02: a SERVICE MUST
// publish the key its notes verify against on every withdrawRequest, and this
// wallet refuses one that does not. A stand-in mint has to publish it too, or
// it is standing in for a mint no wallet will talk to.
const MINT_PUBKEY = '02' + 'cd'.repeat(32)

const jsonResponse = (body: unknown) =>
  Promise.resolve({json: async () => body} as unknown as Response)

// a minimal LUD-25 mint fake: `liveAtIndex`'s secret is a live outstanding
// note, `spentAtIndex`'s (if given) is already spent, every other index was
// never minted - enough to exercise recovery/spent/gap-limit handling
// without pulling in mockMint.test.ts's much larger stateful mock
const fakeMint = (liveAtIndex: number, spentAtIndex: number | null) => {
  const liveSecret = cashSecrets.cashSecretAtIndex(SERVER, liveAtIndex)!
  const spentSecret =
    spentAtIndex === null
      ? null
      : cashSecrets.cashSecretAtIndex(SERVER, spentAtIndex)!
  return (input: string | URL) => {
    const url = new URL(input.toString())
    console.log('REQ', url.pathname, url.search)
    if (url.pathname === '/.well-known/lnurlp/mint') {
      return jsonResponse({
        tag: 'payRequest',
        callback: `https://${SERVER}/pay/cb`,
        minSendable: 1000,
        maxSendable: 100_000_000,
        metadata: '[]',
        withdrawLink: `https://${SERVER}/w`
      })
    }
    if (url.pathname === '/w') {
      // This wallet asks by h=hex(sha256(k1)) first, so a note's bearer
      // secret never goes on the wire just to read its value. Both live
      // mints answer that lookup, so the stand-in does too - answering only
      // k1 would make it a mint this wallet deliberately never sends a
      // secret to, and every index would read as an empty gap.
      const askedHash = url.searchParams.get('h')
      const k1 =
        url.searchParams.get('k1') ??
        (askedHash === sha256Hex(liveSecret)
          ? liveSecret
          : spentSecret && askedHash === sha256Hex(spentSecret)
            ? spentSecret
            : null)
      if (k1 === liveSecret) {
        return jsonResponse({
          tag: 'withdrawRequest',
          callback: WITHDRAW_CALLBACK,
          mintPubkey: MINT_PUBKEY,
          // LUD-25: the hash lookup's response omits k1. The convenience it
          // normally serves does not apply - a wallet asking by hash already
          // holds the value it hashed - and echoing it back would hand over a
          // bearer secret nobody asked for.
          ...(askedHash ? {} : {k1}),
          minWithdrawable: 21000,
          maxWithdrawable: 21000
        })
      }
      if (spentSecret && k1 === spentSecret) {
        return jsonResponse({status: 'ERROR', reason: 'Note already spent.'})
      }
      return jsonResponse({status: 'ERROR', reason: 'Unknown note.'})
    }
    return jsonResponse({status: 'ERROR', reason: 'not found'})
  }
}

describe('scanMintForNotes', () => {
  it('recovers a live note and stops after the gap limit', async () => {
    vi.stubGlobal('fetch', fakeMint(0, null) as unknown as typeof fetch)
    const result = await recovery.scanMintForNotes(`mint@${SERVER}`)
    expect(result.error).toBeUndefined()
    expect(result.recovered).toHaveLength(1)
    expect(result.recovered[0].amount).toBe(21000)
    expect(result.highestUsedIndex).toBe(0)
  })

  it("a spent index doesn't count toward the gap, but yields nothing", async () => {
    vi.stubGlobal(
      'fetch',
      fakeMint(0, gapLimit.gapLimit()) as unknown as typeof fetch
    )
    const result = await recovery.scanMintForNotes(`mint@${SERVER}`)
    expect(result.recovered).toHaveLength(1)
    expect(result.highestUsedIndex).toBe(gapLimit.gapLimit())
  })

  it('a mint with nothing outstanding stops at the gap limit and finds nothing', async () => {
    vi.stubGlobal('fetch', fakeMint(-1, null) as unknown as typeof fetch)
    const result = await recovery.scanMintForNotes(`mint@${SERVER}`)
    expect(result.recovered).toHaveLength(0)
    expect(result.highestUsedIndex).toBeNull()
    expect(result.error).toBeUndefined()
  })

  it('does not re-recover a note already held locally, but still counts it used', async () => {
    vi.stubGlobal('fetch', fakeMint(0, null) as unknown as typeof fetch)
    const liveSecret = cashSecrets.cashSecretAtIndex(SERVER, 0)!
    const alreadyHeld: Bearer = {
      id: 'existing',
      url: `${WITHDRAW_CALLBACK}?k1=${liveSecret}&amount=21000`,
      callback: WITHDRAW_CALLBACK,
      amount: 21000,
      verified: true,
      createdAt: 0,
      updatedAt: 0
    }
    const result = await recovery.scanMintForNotes(
      `mint@${SERVER}`,
      undefined,
      [alreadyHeld]
    )
    expect(result.error).toBeUndefined()
    expect(result.recovered).toHaveLength(0)
    expect(result.highestUsedIndex).toBe(0)
  })

  it('reports an unresolvable address without ever calling fetch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const result = await recovery.scanMintForNotes('not a mint address')
    expect(result.error).toMatch(/not a recognizable/i)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('aborts on a transport failure instead of treating it as a gap', async () => {
    let calls = 0
    vi.stubGlobal('fetch', ((input: string | URL) => {
      const url = new URL(input.toString())
      if (url.pathname === '/.well-known/lnurlp/mint') {
        return fakeMint(0, null)(input)
      }
      calls++
      if (calls === 1) {
        // answered as the hash lookup this wallet actually sends, so k1 is
        // omitted - see the note in fakeMint
        return jsonResponse({
          tag: 'withdrawRequest',
          callback: WITHDRAW_CALLBACK,
          mintPubkey: MINT_PUBKEY,
          minWithdrawable: 21000,
          maxWithdrawable: 21000
        })
      }
      return Promise.reject(new Error('network down'))
    }) as unknown as typeof fetch)
    const result = await recovery.scanMintForNotes(`mint@${SERVER}`)
    // the first index (live) was recovered before the second call blew up
    expect(result.recovered).toHaveLength(1)
    expect(result.error).toBeTruthy()
  })
})
