import {beforeEach, describe, expect, it, vi} from 'vitest'
import {bytesToHex} from '@noble/hashes/utils.js'
import type {Bearer} from './storage'
import {
  deriveNotePubkey,
  encodeCp1,
  decodeCk1,
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
// indices on the address branch cashAddressBranch(SERVER) actually derives -
// mirrors recovery.test.ts's own fakeMint shape, adapted for p=cp1<pk>
// instead of h=sha256(k1)
const fakeMint = (liveIndices: number[], sig?: string) => {
  const branch = cashSecrets.cashAddressBranch(SERVER)!
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
        metadata: '[]',
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
    const branch = cashSecrets.cashAddressBranch(SERVER)!
    const expectedPk = bytesToHex(
      deriveNotePubkey(branch.pubkeyXOnly, branch.chainCode, 0)
    )
    const k1 = noteK1(result.recovered[0]!.url)!
    expect(k1.startsWith('ck1')).toBe(true)
    const recoveredPk = recoverNoteOwnershipPubkey(decodeCk1(k1)!)
    expect(bytesToHex(recoveredPk!)).toBe(expectedPk)
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
