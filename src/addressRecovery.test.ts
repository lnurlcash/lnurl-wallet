import {beforeEach, describe, expect, it, vi} from 'vitest'
import {bytesToHex, utf8ToBytes} from '@noble/hashes/utils.js'
import {sha256} from '@noble/hashes/sha2.js'
import {schnorr} from '@noble/curves/secp256k1.js'
import type {Bearer} from './storage'
import {parseLabelTags} from './noteTags'
import {
  encodeCk1,
  encodeCp1,
  noteK1,
  noteSignature,
  recoverNoteOwnershipPubkey,
  withNewK1,
  encodeCs1WithAmount
} from './lnurlcash'
import type {AddressKey} from './addressRegistry'

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
// scanRegisteredAddress derives its keys from the host (serverOf), never
// SERVER's own full origin - so the fake mint below must build its live
// pubkeys off the SAME host, or nothing would ever match what a scan derives
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

// the note key a scan derives at `index` under `key` (share 0 by default)
const secretAt = (
  index: number,
  key: AddressKey = {kind: 'share', share: 0}
) =>
  key.kind === 'share'
    ? cashSecrets.shareSecretAtIndex(HOST, key.share, index)!
    : cashSecrets.legacyAddressSecretAtIndex(HOST, index, key.slot)!

const cp1At = (index: number, key?: AddressKey) =>
  encodeCp1(schnorr.getPublicKey(secretAt(index, key)))

// a fake mint whose /w answers cp1 lookups: `live` notes, `burned` ones
// ("already in use"), everything else unknown
const fakeMint = (
  live: string[],
  opts: {sig?: string; burned?: string[]; unknownUser?: boolean} = {}
) => {
  const liveCp1 = new Set(live)
  const burned = new Set(opts.burned ?? [])
  return (input: string | URL) => {
    const url = new URL(input.toString())
    if (url.pathname === `/.well-known/lnurlp/${USERNAME}`) {
      if (opts.unknownUser) {
        return jsonResponse({status: 'ERROR', reason: 'unknown user'})
      }
      return jsonResponse({
        tag: 'payRequest',
        callback: `${SERVER}/p/${USERNAME}`,
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
          ...(opts.sig ? {c: opts.sig} : {})
        })
      }
      if (p && burned.has(p)) {
        return jsonResponse({status: 'ERROR', reason: 'already in use'})
      }
      return jsonResponse({status: 'ERROR', reason: 'Unknown note.'})
    }
    return jsonResponse({status: 'ERROR', reason: 'not found'})
  }
}

const stub = (live: number[], opts: Parameters<typeof fakeMint>[1] = {}) =>
  vi.stubGlobal(
    'fetch',
    fakeMint(
      live.map(i => cp1At(i)),
      opts
    ) as unknown as typeof fetch
  )

describe('scanRegisteredAddress', () => {
  it('recovers a live note and signs its own ck1', async () => {
    stub([0])
    const result = await addressRecovery.scanRegisteredAddress(SERVER, USERNAME)
    expect(result.error).toBeUndefined()
    expect(result.recovered).toHaveLength(1)
    expect(result.recovered[0]!.amount).toBe(21000)
    expect(result.highestIndex).toBe(0)
    // the recovered bearer's own k1 is a well-formed ck1 that actually
    // recovers to the share's note 0
    const expectedPk = bytesToHex(schnorr.getPublicKey(secretAt(0)))
    const k1 = noteK1(result.recovered[0]!.url)!
    expect(k1.startsWith('ck1')).toBe(true)
    const owner = recoverNoteOwnershipPubkey(k1, result.recovered[0]!.url)
    expect(owner).not.toBeNull()
    expect(bytesToHex(owner!.pubkeyXOnly)).toBe(expectedPk)
  })

  it('labels a found note with its address tag and scanned index', async () => {
    stub([0, 2])
    const result = await addressRecovery.scanRegisteredAddress(SERVER, USERNAME)
    const labels = result.recovered.map(n => parseLabelTags(n.label!))
    expect(labels).toEqual([
      {tags: [encodeURIComponent(`${USERNAME}@${HOST}`)], text: 'index 0'},
      {tags: [encodeURIComponent(`${USERNAME}@${HOST}`)], text: 'index 2'}
    ])
  })

  it('attaches an already-disclosed offline-verification sig immediately', async () => {
    const sig65 = new Uint8Array(65).fill(0xab)
    sig65[64] = 1
    const sig = encodeCs1WithAmount(5000, sig65)
    stub([0], {sig})
    const result = await addressRecovery.scanRegisteredAddress(SERVER, USERNAME)
    expect(result.recovered).toHaveLength(1)
    expect(noteSignature(result.recovered[0]!.url)).toBe(sig)
  })

  it('does not re-recover a note already held', async () => {
    stub([0])
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

  it('recognises a note held under its old-format ck1 - by its Q, not the string', async () => {
    // a note held from before ck1s signed the spend sighash still carries
    // its old ck1 (Q || sig over sha256("LNURLcash")): a rescan re-derives
    // today's ck1 for the same Q, which must not be recovered a second time
    stub([0])
    const secretKey = secretAt(0)
    const oldCk1 = encodeCk1(
      schnorr.getPublicKey(secretKey),
      schnorr.sign(
        sha256(utf8ToBytes('LNURLcash')),
        secretKey,
        new Uint8Array(32)
      )
    )
    const held: Bearer[] = [
      {
        id: 'x',
        url: withNewK1(`${SERVER}/w`, oldCk1, 21000),
        callback: `${SERVER}/w/cb`,
        amount: 21000,
        verified: true,
        createdAt: 0,
        updatedAt: 0
      }
    ]
    const result = await addressRecovery.scanRegisteredAddress(
      SERVER,
      USERNAME,
      held
    )
    expect(result.recovered).toHaveLength(0)
    expect(result.highestIndex).toBe(0)
  })

  it('reports an error and no crash when no cash root is loaded', async () => {
    // build the fixture (needs the keys derived) before clearing the root
    stub([0])
    cashSecrets.setCashRoot(null)
    const result = await addressRecovery.scanRegisteredAddress(SERVER, USERNAME)
    expect(result.recovered).toHaveLength(0)
    expect(result.error).toMatch(/seed-derived/)
  })

  it('counts a burned note ("already in use") as used, recovering nothing', async () => {
    vi.stubGlobal(
      'fetch',
      fakeMint([], {burned: [cp1At(3)]}) as unknown as typeof fetch
    )
    const result = await addressRecovery.scanRegisteredAddress(SERVER, USERNAME)
    expect(result.recovered).toHaveLength(0)
    expect(result.highestIndex).toBe(3)
    expect(result.nextScanIndex).toBe(4)
  })

  it('finds nothing on an empty share', async () => {
    stub([])
    const result = await addressRecovery.scanRegisteredAddress(SERVER, USERNAME)
    expect(result.recovered).toHaveLength(0)
    expect(result.highestIndex).toBeNull()
    expect(result.error).toBeUndefined()
  })
})

describe('scanRegisteredAddress - incremental resume (nextScanIndex)', () => {
  it('resumes past the highest index this pass actually found', async () => {
    stub([2])
    const result = await addressRecovery.scanRegisteredAddress(SERVER, USERNAME)
    expect(result.highestIndex).toBe(2)
    expect(result.nextScanIndex).toBe(3)
  })

  it('never regresses below the caller-supplied floor when nothing is found', async () => {
    stub([])
    const result = await addressRecovery.scanRegisteredAddress(
      SERVER,
      USERNAME,
      [],
      {startIndex: 5}
    )
    expect(result.recovered).toHaveLength(0)
    expect(result.nextScanIndex).toBe(5)
  })

  it('checkBehind still finds a live note below opts.startIndex', async () => {
    stub([0])
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
    stub([0])
    const result = await addressRecovery.scanRegisteredAddress(
      SERVER,
      USERNAME,
      [],
      {startIndex: 100}
    )
    expect(result.recovered).toHaveLength(0)
    expect(result.nextScanIndex).toBe(100)
  })

  it('exactStart never records an unchecked typed start as a floor', async () => {
    stub([])
    const result = await addressRecovery.scanRegisteredAddress(
      SERVER,
      USERNAME,
      [],
      {startIndex: 500, exactStart: true}
    )
    expect(result.checkedFrom).toBe(500)
    expect(result.nextScanIndex).toBe(0)
  })

  it('reports every index status, held vs recovered included', async () => {
    stub([0, 2])
    const first = await addressRecovery.scanRegisteredAddress(SERVER, USERNAME)
    const held = {
      id: 'held',
      url: first.recovered[0]!.url,
      amount: 21000
    } as unknown as Bearer
    const cells: Record<number, string> = {}
    await addressRecovery.scanRegisteredAddress(SERVER, USERNAME, [held], {
      onIndex: (index, status) => {
        cells[index] = status
      }
    })
    expect(cells[0]).toBe('held')
    expect(cells[1]).toBe('unknown')
    expect(cells[2]).toBe('recovered')
    expect(Object.keys(cells)).toHaveLength(3 + 20)
  })
})

describe('which key an address is scanned on', () => {
  const live = (pairs: [number, AddressKey][]) =>
    vi.stubGlobal(
      'fetch',
      fakeMint(
        pairs.map(([i, key]) => cp1At(i, key))
      ) as unknown as typeof fetch
    )

  it('scans the share it is given, not share 0', async () => {
    live([[1, {kind: 'share', share: 3}]])
    const result = await addressRecovery.scanRegisteredAddress(
      SERVER,
      USERNAME,
      [],
      {key: {kind: 'share', share: 3}}
    )
    expect(result.recovered).toHaveLength(1)
    const other = await addressRecovery.scanRegisteredAddress(SERVER, USERNAME)
    expect(other.recovered).toHaveLength(0)
  })

  it('scans a pre-LUD-26 registration on its old branch, slot or none', async () => {
    live([
      [0, {kind: 'legacy', slot: 2}],
      [1, {kind: 'legacy'}]
    ])
    const slot = await addressRecovery.scanRegisteredAddress(
      SERVER,
      USERNAME,
      [],
      {key: {kind: 'legacy', slot: 2}}
    )
    expect(slot.recovered).toHaveLength(1)
    expect(slot.highestIndex).toBe(0)
    const bare = await addressRecovery.scanRegisteredAddress(
      SERVER,
      USERNAME,
      [],
      {key: {kind: 'legacy'}}
    )
    expect(bare.highestIndex).toBe(1)
  })

  it("runAddressScan uses the registered address's own key", async () => {
    const registry = await import('./addressRegistry')
    registry.addRegisteredAddress(SERVER, USERNAME, undefined, 4)
    live([[0, {kind: 'share', share: 4}]])
    const added: unknown[] = []
    const result = await addressRecovery.runAddressScan(SERVER, USERNAME, [], {
      addBearer: async note => added.push(note),
      logActivity: () => {}
    })
    expect(result.recovered).toHaveLength(1)
    expect(added).toHaveLength(1)
    expect(registry.registeredAddresses()[0]?.nextScanIndex).toBe(1)
  })

  it('a full rescan also sweeps the keys an address was moved off', async () => {
    const registry = await import('./addressRegistry')
    registry.addRegisteredAddress(SERVER, USERNAME, undefined, undefined, 2)
    registry.moveRegisteredAddress(SERVER, USERNAME, 0)
    live([
      [0, {kind: 'share', share: 0}],
      [5, {kind: 'legacy', slot: 2}]
    ])
    const ops = {addBearer: async () => {}, logActivity: () => {}}
    const full = await addressRecovery.runAddressScan(SERVER, USERNAME, [], ops)
    expect(full.recovered).toHaveLength(2)
    const incremental = await addressRecovery.runAddressScan(
      SERVER,
      USERNAME,
      [],
      ops,
      {startIndex: 1}
    )
    expect(incremental.recovered).toHaveLength(1)
  })
})

describe('checkAddressOwnership', () => {
  it("is 'ours' with the recorded key when this device knows the name", async () => {
    const registry = await import('./addressRegistry')
    registry.addRegisteredAddress(SERVER, USERNAME, undefined, 2)
    registry.forgetRegisteredAddress(SERVER, USERNAME)
    stub([])
    expect(
      await addressRecovery.resolveAddressOwnership(SERVER, USERNAME)
    ).toEqual({ownership: 'ours', key: {kind: 'share', share: 2}})
  })

  it("is 'unregistered' when the mint no longer knows the name", async () => {
    stub([], {unknownUser: true})
    expect(await addressRecovery.checkAddressOwnership(SERVER, USERNAME)).toBe(
      'unregistered'
    )
  })

  it("is 'unknown' for a name this device has no record of", async () => {
    stub([])
    expect(await addressRecovery.checkAddressOwnership(SERVER, USERNAME)).toBe(
      'unknown'
    )
  })
})

describe('checkAddressFee', () => {
  // BOLT-11's coffee-beans example: timestamp 1496314658, x=60
  const FEE_PR =
    'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp'
  const EXPIRES_AT = (1496314658 + 60) * 1000

  const held = async () => {
    const registry = await import('./addressRegistry')
    registry.addRegisteredAddress(SERVER, USERNAME, undefined, 0)
    registry.setAddressFeeInvoice(SERVER, USERNAME, FEE_PR)
    return registry
  }

  it('reads the invoice expiry in milliseconds', () => {
    expect(addressRecovery.feeInvoiceExpiresAt(FEE_PR)).toBe(EXPIRES_AT)
    expect(addressRecovery.feeInvoiceExpiresAt('nope')).toBeNull()
  })

  it("is 'paid' once the mint publishes the address, and forgets the invoice", async () => {
    const registry = await held()
    stub([])
    const addr = registry.registeredAddresses()[0]!
    expect(await addressRecovery.checkAddressFee(addr, EXPIRES_AT - 1)).toBe(
      'paid'
    )
    expect(registry.registeredAddresses()[0]!.feeInvoice).toBeUndefined()
  })

  it("is 'pending' while held and the invoice still payable", async () => {
    const registry = await held()
    stub([], {unknownUser: true})
    const addr = registry.registeredAddresses()[0]!
    expect(await addressRecovery.checkAddressFee(addr, EXPIRES_AT - 1)).toBe(
      'pending'
    )
    expect(registry.registeredAddresses()[0]!.feeInvoice).toBe(FEE_PR)
  })

  it("is 'expired' once the invoice lapsed unpaid", async () => {
    const registry = await held()
    stub([], {unknownUser: true})
    const addr = registry.registeredAddresses()[0]!
    expect(await addressRecovery.checkAddressFee(addr, EXPIRES_AT)).toBe(
      'expired'
    )
  })

  it("is 'unknown' with no fee pending", async () => {
    stub([])
    expect(
      await addressRecovery.checkAddressFee({
        server: SERVER,
        username: USERNAME
      })
    ).toBe('unknown')
  })
})
