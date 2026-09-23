import {beforeEach, describe, expect, it, vi} from 'vitest'
import {bytesToHex} from '@noble/hashes/utils.js'
import type {Bearer} from './storage'
import {
  deriveNotePubkey,
  encodeCp1,
  encodeCx1,
  noteK1,
  noteSignature,
  recoverNoteOwnershipPubkey
} from './lnurlcash'

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
const SERVER = 'https://mock-mint.test'
// scanRegisteredAddress derives its branch from the bare host (serverOf),
// never SERVER's own full origin directly (see src/lib/urls.ts's serverOf)
// - so the fake mint below must build its live/spent pubkeys off the SAME
// host, or nothing it advertises would ever match what a scan derives
const HOST = 'mock-mint.test'
const USERNAME = 'alice'
const MINT_PUBKEY = `02${'cd'.repeat(32)}`

let addressRecovery: typeof import('./addressRecovery')
let cashSecrets: typeof import('./cashSecrets')
let keys: typeof import('./keys')

beforeEach(async () => {
  store.clear()
  vi.resetModules()
  addressRecovery = await import('./addressRecovery')
  cashSecrets = await import('./cashSecrets')
  keys = await import('./keys')
  cashSecrets.setCashRoot(keys.deriveLud25CashRootNode(SEED))
})

const jsonResponse = (body: unknown) =>
  Promise.resolve({json: async () => body} as unknown as Response)

// a fake mint whose /w answers cp1-pubkey lookups for a fixed set of "live"
// indices on the address branch cashAddressBranch(HOST) actually derives -
// mirrors recovery.test.ts's own fakeMint shape, adapted for p=cp1<pk>
// instead of h=sha256(k1)
const fakeMint = (liveIndices: number[], sig?: string, xpubHint?: string) => {
  const branch = cashSecrets.cashAddressBranch(HOST)!
  const liveCp1 = new Set(
    liveIndices.map(i =>
      encodeCp1(deriveNotePubkey(branch.pubkeyXOnly, branch.chainCode, i))
    )
  )
  return (input: string | URL) => {
    const url = new URL(input.toString())
    if (url.pathname === `/.well-known/lnurlp/${USERNAME}`) {
      return jsonResponse({
        tag: 'payRequest',
        callback: `${SERVER}/p/cb?username=${USERNAME}`,
        minSendable: 1000,
        maxSendable: 100_000_000,
        metadata: xpubHint ? JSON.stringify([['text/xpub', xpubHint]]) : '[]',
        withdrawLink: `${SERVER}/w`
      })
    }
    if (url.pathname === '/w') {
      const p = url.searchParams.get('p')
      if (p && liveCp1.has(p)) {
        return jsonResponse({
          tag: 'withdrawRequest',
          callback: `${SERVER}/w/cb`,
          mintPubkey: MINT_PUBKEY,
          minWithdrawable: 21000,
          maxWithdrawable: 21000,
          ...(sig ? {sig} : {})
        })
      }
      return jsonResponse({status: 'ERROR', reason: 'Unknown note.'})
    }
    return jsonResponse({status: 'ERROR', reason: 'not found'})
  }
}

describe('scanRegisteredAddress', () => {
  it('recovers a live note and signs its own ck1', async () => {
    vi.stubGlobal('fetch', fakeMint([0]) as unknown as typeof fetch)
    const result = await addressRecovery.scanRegisteredAddress(SERVER, USERNAME)
    expect(result.error).toBeUndefined()
    expect(result.recovered).toHaveLength(1)
    expect(result.recovered[0]!.amount).toBe(21000)
    expect(result.highestIndex).toBe(0)
    // the recovered bearer's own k1 is a well-formed ck1 that actually
    // recovers to the same index's derived pubkey
    const branch = cashSecrets.cashAddressBranch(HOST)!
    const expectedPk = bytesToHex(
      deriveNotePubkey(branch.pubkeyXOnly, branch.chainCode, 0)
    )
    const k1 = noteK1(result.recovered[0]!.url)!
    expect(k1.startsWith('ck1')).toBe(true)
    const owner = recoverNoteOwnershipPubkey(k1)
    expect(owner?.legacy).toBe(false)
    expect(bytesToHex(owner!.pubkeyXOnly)).toBe(expectedPk)
  })

  it('attaches an already-disclosed offline-verification sig immediately', async () => {
    const sig = 'ab'.repeat(65)
    vi.stubGlobal('fetch', fakeMint([0], sig) as unknown as typeof fetch)
    const result = await addressRecovery.scanRegisteredAddress(SERVER, USERNAME)
    expect(result.recovered).toHaveLength(1)
    expect(noteSignature(result.recovered[0]!.url)).toBe(sig)
  })

  it('does not re-recover a note already held', async () => {
    vi.stubGlobal('fetch', fakeMint([0]) as unknown as typeof fetch)
    const first = await addressRecovery.scanRegisteredAddress(SERVER, USERNAME)
    const held: Bearer[] = [
      {
        id: 'x',
        url: first.recovered[0]!.url,
        callback: first.recovered[0]!.callback,
        amount: first.recovered[0]!.amount,
        verified: true,
        createdAt: 0,
        updatedAt: 0
      }
    ]
    const second = await addressRecovery.scanRegisteredAddress(
      SERVER,
      USERNAME,
      held
    )
    expect(second.recovered).toHaveLength(0)
    expect(second.highestIndex).toBe(0)
  })

  it('reports an error and no crash when no cash root is loaded', async () => {
    // build the fixture (needs the branch derived) before clearing the root
    const mock = fakeMint([0])
    cashSecrets.setCashRoot(null)
    vi.stubGlobal('fetch', mock as unknown as typeof fetch)
    const result = await addressRecovery.scanRegisteredAddress(SERVER, USERNAME)
    expect(result.recovered).toHaveLength(0)
    expect(result.error).toMatch(/seed-derived/)
  })

  it('finds nothing on an empty branch', async () => {
    vi.stubGlobal('fetch', fakeMint([]) as unknown as typeof fetch)
    const result = await addressRecovery.scanRegisteredAddress(SERVER, USERNAME)
    expect(result.recovered).toHaveLength(0)
    expect(result.highestIndex).toBeNull()
    expect(result.error).toBeUndefined()
  })
})

// TODO.md's "differentiation between rescan all and check notes where you
// remember the last checked index or get the index from the lightning
// address xpub in metadata" - nextScanIndex is what a "check notes" pass
// (Mint.tsx, AddressAutoScanner.tsx) resumes from next time; opts.startIndex
// is how a caller applies that resume point (or forces 0 for "rescan all")
describe('scanRegisteredAddress - incremental resume (nextScanIndex)', () => {
  it('resumes past the highest index this pass actually found', async () => {
    vi.stubGlobal('fetch', fakeMint([2]) as unknown as typeof fetch)
    const result = await addressRecovery.scanRegisteredAddress(SERVER, USERNAME)
    expect(result.highestIndex).toBe(2)
    expect(result.nextScanIndex).toBe(3)
  })

  it('never regresses below the caller-supplied floor when nothing is found', async () => {
    vi.stubGlobal('fetch', fakeMint([]) as unknown as typeof fetch)
    const result = await addressRecovery.scanRegisteredAddress(
      SERVER,
      USERNAME,
      [],
      {startIndex: 5}
    )
    expect(result.recovered).toHaveLength(0)
    expect(result.nextScanIndex).toBe(5)
  })

  it('checkBehind still finds a live note below opts.startIndex (the safety-net window)', async () => {
    vi.stubGlobal('fetch', fakeMint([0]) as unknown as typeof fetch)
    const result = await addressRecovery.scanRegisteredAddress(
      SERVER,
      USERNAME,
      [],
      {startIndex: 1}
    )
    expect(result.recovered).toHaveLength(1)
    expect(result.highestIndex).toBe(0)
  })

  it('a note beyond the checkBehind window is not found by a nonzero startIndex alone', async () => {
    // gapLimit(). default 20 - a note far enough below startIndex to fall
    // outside the checkBehind window is genuinely not covered by this pass
    vi.stubGlobal('fetch', fakeMint([0]) as unknown as typeof fetch)
    const result = await addressRecovery.scanRegisteredAddress(
      SERVER,
      USERNAME,
      [],
      {startIndex: 100}
    )
    expect(result.recovered).toHaveLength(0)
    expect(result.nextScanIndex).toBe(100)
  })

  it("never lets SERVICE's own text/xpub metadata hint skip a fresh device's unscanned floor", async () => {
    const branch = cashSecrets.cashAddressBranch(HOST)!
    const cx1 = encodeCx1(branch.pubkeyXOnly, branch.chainCode)
    vi.stubGlobal(
      'fetch',
      fakeMint([0], undefined, `${cx1}:3`) as unknown as typeof fetch
    )
    // index 0 is live (a real payment this device has never seen), and the
    // hint says SERVICE already handed out invoices up to 3 - but
    // `next_index` advances the moment SERVICE creates an invoice, not once
    // it settles (lnurl-mint's own claim_next_index), so a bare "check
    // notes" from a device with no local nextScanIndex yet MUST NOT trust
    // the hint to skip straight past index 0: nothing below it has actually
    // been confirmed recovered by this device
    const result = await addressRecovery.scanRegisteredAddress(SERVER, USERNAME)
    expect(result.recovered).toHaveLength(1)
    expect(result.highestIndex).toBe(0)
  })

  it('the metadata hint only ever raises an already-nonzero local floor, never lowers it', async () => {
    const branch = cashSecrets.cashAddressBranch(HOST)!
    const cx1 = encodeCx1(branch.pubkeyXOnly, branch.chainCode)
    vi.stubGlobal(
      'fetch',
      fakeMint([], undefined, `${cx1}:2`) as unknown as typeof fetch
    )
    const result = await addressRecovery.scanRegisteredAddress(
      SERVER,
      USERNAME,
      [],
      {startIndex: 10}
    )
    expect(result.nextScanIndex).toBe(10)
  })

  it('the metadata hint DOES raise an already-nonzero local floor forward', async () => {
    const branch = cashSecrets.cashAddressBranch(HOST)!
    const cx1 = encodeCx1(branch.pubkeyXOnly, branch.chainCode)
    vi.stubGlobal(
      'fetch',
      fakeMint([], undefined, `${cx1}:5`) as unknown as typeof fetch
    )
    // this device already confirmed up through index 1 on a prior pass
    // (startIndex: 1, a genuine nonzero resume point, not a fresh scan) -
    // SERVICE's hint of 5 is allowed to skip it ahead from there
    const result = await addressRecovery.scanRegisteredAddress(
      SERVER,
      USERNAME,
      [],
      {startIndex: 1}
    )
    expect(result.nextScanIndex).toBe(5)
  })

  it('a full rescan reaches at least the metadata hint + gap limit, past an intervening dead stretch', async () => {
    const branch = cashSecrets.cashAddressBranch(HOST)!
    const cx1 = encodeCx1(branch.pubkeyXOnly, branch.chainCode)
    // default gap limit is 20 (see gapLimit.ts) - a plain forward walk from
    // 0 would give up at index 20, long before reaching this note at 25,
    // even though SERVICE's own hint (10) says it has handed out well past
    // the dead stretch sitting in between
    vi.stubGlobal(
      'fetch',
      fakeMint([25], undefined, `${cx1}:10`) as unknown as typeof fetch
    )
    const result = await addressRecovery.scanRegisteredAddress(
      SERVER,
      USERNAME,
      [],
      {startIndex: 0}
    )
    expect(result.recovered).toHaveLength(1)
    expect(result.highestIndex).toBe(25)
  })
})
