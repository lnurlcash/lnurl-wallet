import {beforeEach, describe, expect, it, vi} from 'vitest'
import {bytesToHex} from '@noble/hashes/utils.js'
import {
  deriveNotePubkey,
  encodeCp1,
  noteK1,
  recoverNoteOwnershipPubkey
} from './lnurlcash'
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

// LUD-25 made offline verification mandatory on 2026-09-02: a SERVICE MUST
// publish the key its notes verify against on every withdrawRequest, and this
// wallet refuses one that does not. A stand-in mint has to publish it too, or
// it is standing in for a mint no wallet will talk to.
const MINT_PUBKEY = '02' + 'cd'.repeat(32)

const jsonResponse = (body: unknown) =>
  Promise.resolve({json: async () => body} as unknown as Response)

// a minimal LUD-25 Part 2 mint fake, mirroring addressRecovery.test.ts's own
// fakeMint: `liveIndices`' pubkeys are live outstanding notes, `spentIndex`
// (if given) is already spent, every other index was never minted - enough
// to exercise recovery/spent/gap-limit handling without pulling in
// mockMint.test.ts's much larger stateful mock
const fakeMint = (
  liveIndices: number[],
  spentIndex: number | null,
  sig?: string
) => {
  const branch = cashSecrets.cashAddressBranch(SERVER)!
  const cp1At = (i: number) =>
    encodeCp1(deriveNotePubkey(branch.pubkeyXOnly, branch.chainCode, i))
  const liveCp1 = new Set(liveIndices.map(cp1At))
  const spentCp1 = spentIndex === null ? null : cp1At(spentIndex)
  return (input: string | URL) => {
    const url = new URL(input.toString())
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
      const p = url.searchParams.get('p')
      if (p && liveCp1.has(p)) {
        return jsonResponse({
          tag: 'withdrawRequest',
          callback: WITHDRAW_CALLBACK,
          mintPubkey: MINT_PUBKEY,
          minWithdrawable: 21000,
          maxWithdrawable: 21000,
          ...(sig ? {sig} : {})
        })
      }
      if (p && spentCp1 && p === spentCp1) {
        return jsonResponse({status: 'ERROR', reason: 'Note already spent.'})
      }
      return jsonResponse({status: 'ERROR', reason: 'Unknown note.'})
    }
    return jsonResponse({status: 'ERROR', reason: 'not found'})
  }
}

describe('scanMintForNotes', () => {
  it('recovers a live note and signs its own ck1', async () => {
    vi.stubGlobal('fetch', fakeMint([0], null) as unknown as typeof fetch)
    const result = await recovery.scanMintForNotes(`mint@${SERVER}`)
    expect(result.error).toBeUndefined()
    expect(result.recovered).toHaveLength(1)
    expect(result.recovered[0]!.amount).toBe(21000)
    expect(result.highestUsedIndex).toBe(0)
    // the recovered bearer's own k1 is a well-formed ck1 that actually
    // recovers to the same index's derived pubkey
    const branch = cashSecrets.cashAddressBranch(SERVER)!
    const expectedPk = bytesToHex(
      deriveNotePubkey(branch.pubkeyXOnly, branch.chainCode, 0)
    )
    const k1 = noteK1(result.recovered[0]!.url)!
    expect(k1.startsWith('ck1')).toBe(true)
    const owner = recoverNoteOwnershipPubkey(k1)
    expect(owner?.legacy).toBe(false)
    expect(bytesToHex(owner!.pubkeyXOnly)).toBe(expectedPk)
  })

  it('attaches an already-disclosed offline-verification sig immediately, no separate rotate needed', async () => {
    const sig = 'ab'.repeat(65)
    vi.stubGlobal('fetch', fakeMint([0], null, sig) as unknown as typeof fetch)
    const result = await recovery.scanMintForNotes(`mint@${SERVER}`)
    expect(result.recovered).toHaveLength(1)
    expect(new URL(result.recovered[0]!.url).searchParams.get('sig')).toBe(sig)
  })

  it("a spent index doesn't count toward the gap, but yields nothing", async () => {
    const spentIndex = gapLimit.gapLimit()
    vi.stubGlobal('fetch', fakeMint([0], spentIndex) as unknown as typeof fetch)
    const result = await recovery.scanMintForNotes(`mint@${SERVER}`)
    expect(result.recovered).toHaveLength(1)
    expect(result.highestUsedIndex).toBe(spentIndex)
  })

  it('a mint with nothing outstanding stops at the gap limit and finds nothing', async () => {
    vi.stubGlobal('fetch', fakeMint([], null) as unknown as typeof fetch)
    const result = await recovery.scanMintForNotes(`mint@${SERVER}`)
    expect(result.recovered).toHaveLength(0)
    expect(result.highestUsedIndex).toBeNull()
    expect(result.error).toBeUndefined()
  })

  it('does not re-recover a note already held locally, but still counts it used', async () => {
    vi.stubGlobal('fetch', fakeMint([0], null) as unknown as typeof fetch)
    const first = await recovery.scanMintForNotes(`mint@${SERVER}`)
    const alreadyHeld: Bearer = {
      id: 'existing',
      url: first.recovered[0]!.url,
      callback: first.recovered[0]!.callback,
      amount: first.recovered[0]!.amount,
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

  it('reports an error and no crash when no cash root is loaded', async () => {
    // build the fixture (needs the branch derived) before clearing the root
    const mock = fakeMint([0], null)
    cashSecrets.setCashRoot(null)
    vi.stubGlobal('fetch', mock as unknown as typeof fetch)
    const result = await recovery.scanMintForNotes(`mint@${SERVER}`)
    expect(result.recovered).toHaveLength(0)
    expect(result.error).toMatch(/seed-derived/)
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
        return fakeMint([0], null)(input)
      }
      calls++
      if (calls === 1) {
        return fakeMint([0], null)(input)
      }
      return Promise.reject(new Error('network down'))
    }) as unknown as typeof fetch)
    const result = await recovery.scanMintForNotes(`mint@${SERVER}`)
    // the first index (live) was recovered before the second call blew up
    expect(result.recovered).toHaveLength(1)
    expect(result.error).toBeTruthy()
  })

  it('reports progress before every probe', async () => {
    vi.stubGlobal('fetch', fakeMint([], null) as unknown as typeof fetch)
    const seen: number[] = []
    await recovery.scanMintForNotes(`mint@${SERVER}`, index => seen.push(index))
    expect(seen.length).toBe(gapLimit.gapLimit())
    expect(seen[0]).toBe(0)
  })
})
