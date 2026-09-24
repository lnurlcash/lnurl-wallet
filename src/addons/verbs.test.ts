import {afterEach, describe, expect, it, vi} from 'vitest'

import {secp256k1} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'

import {buildTicketLabel, VERBS, type VerbContext} from './verbs'
import {parseLabelTags} from '../noteTags'
import {encodeCp1} from '../lnurlcash'
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

describe("VERBS['note.resolveAddressPubkey']", () => {
  const BASE = 'https://mock-mint.test'

  afterEach(() => vi.unstubAllGlobals())

  const bearer: Bearer = {
    id: 'source',
    url: `${BASE}/w?k1=${'a'.repeat(64)}&amount=20000000`,
    callback: `${BASE}/w/cb`,
    amount: 20_000_000,
    verified: true,
    createdAt: 0,
    updatedAt: 0
  }

  const makeCtx = (): VerbContext => ({
    bearers: () => [bearer],
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
    addon: {id: 'musig2', name: 'MuSig2 Playground'}
  })

  // 25.md's own published "Test vector 1" - pk_0's x-only form, and the
  // same underlying key encoded two self-contained ways (a cp1 note
  // address directly, and index 0 of its own branch's cx1 export) - see
  // src/lib/specVectors.test.ts for the byte-exact cross-check these are
  // drawn from.
  const PK0_XONLY =
    'aad3a0e36c083eb0d2d92ec0860977dc46d10c952f31830e6443b1faa1997634'
  const CP1 = 'cp14tf6pcmvpqltp5ke9mqgvzthm3rdzry49uccxrnygwcl4gvewc6qh2fkky'
  const CX1 =
    'cx1k7pa9ycdcpf6ju0sryz5efp70jw72rs8d80gwtw3mh096zl5e8g6hywvzxh28902dd3zj2npgl63aaq4p6l2qnn52ymmdpceugu0jpqes280t'

  it('decodes a cp1 address locally into its even-y compressed pubkey - no mint note or network needed', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await VERBS['note.resolveAddressPubkey']!(
      {address: CP1},
      makeCtx()
    )
    expect(result).toBe(`02${PK0_XONLY}`)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("derives a cx1 address's own index 0 locally - no mint note or network needed", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await VERBS['note.resolveAddressPubkey']!(
      {address: CX1},
      makeCtx()
    )
    expect(result).toBe(`02${PK0_XONLY}`)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a bare username with no mint note picked, before ever touching the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      VERBS['note.resolveAddressPubkey']!({address: 'alice'}, makeCtx())
    ).rejects.toThrow(/pick one of your notes/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("resolves a username against the picked note's own mint, via its published LUD-25 text/xpub hint - always at index 0, not the hint's own next-payable index", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      expect(new URL(input.toString()).toString()).toBe(
        `${BASE}/.well-known/lnurlp/alice`
      )
      return {
        json: async () => ({
          tag: 'payRequest',
          callback: `${BASE}/p/cb`,
          minSendable: 1000,
          maxSendable: 100000000,
          metadata: JSON.stringify([
            ['text/plain', 'pay alice'],
            ['text/xpub', `${CX1}:3`]
          ])
        })
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    // uppercase, to also confirm this is lowercased before both the
    // pattern check and the lookup itself
    const result = await VERBS['note.resolveAddressPubkey']!(
      {mintNote: 'source', address: 'ALICE'},
      makeCtx()
    )
    expect(result).toBe(`02${PK0_XONLY}`)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // a different domain than BASE (the wallet's own mint) - proves the
  // lookup names its own mint and never falls back to the picked note's
  // one, unlike the bare-username path below
  const OTHER_MINT = 'https://another-mint.test'

  it('resolves a full Lightning Address (any domain) directly, with no mint note needed', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      expect(new URL(input.toString()).toString()).toBe(
        `${OTHER_MINT}/.well-known/lnurlp/alice`
      )
      return {
        json: async () => ({
          tag: 'payRequest',
          callback: `${OTHER_MINT}/p/cb`,
          minSendable: 1000,
          maxSendable: 100000000,
          metadata: JSON.stringify([
            ['text/plain', 'pay alice'],
            ['text/xpub', `${CX1}:3`]
          ])
        })
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    // no mintNote arg at all - unlike the bare-username path, a full
    // Lightning Address names its own domain
    const result = await VERBS['note.resolveAddressPubkey']!(
      {address: `alice@${OTHER_MINT.replace('https://', '')}`},
      makeCtx()
    )
    expect(result).toBe(`02${PK0_XONLY}`)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a Lightning Address whose mint never published a LUD-25 address (no text/xpub)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({
          tag: 'payRequest',
          callback: `${OTHER_MINT}/p/cb`,
          minSendable: 1000,
          maxSendable: 100000000,
          metadata: JSON.stringify([['text/plain', 'pay alice']])
        })
      })) as unknown as typeof fetch
    )
    await expect(
      VERBS['note.resolveAddressPubkey']!(
        {address: `alice@${OTHER_MINT.replace('https://', '')}`},
        makeCtx()
      )
    ).rejects.toThrow(/LUD-25 address/)
  })

  it('rejects a username whose mint never published a LUD-25 address (no text/xpub)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({
          tag: 'payRequest',
          callback: `${BASE}/p/cb`,
          minSendable: 1000,
          maxSendable: 100000000,
          metadata: JSON.stringify([['text/plain', 'pay bob']])
        })
      })) as unknown as typeof fetch
    )
    await expect(
      VERBS['note.resolveAddressPubkey']!(
        {mintNote: 'source', address: 'bob'},
        makeCtx()
      )
    ).rejects.toThrow(/LUD-25 address/)
  })

  it('rejects input that is neither a valid pubkey-bearing address nor a valid username', async () => {
    await expect(
      VERBS['note.resolveAddressPubkey']!(
        {address: 'not a valid one!'},
        makeCtx()
      )
    ).rejects.toThrow(/Not a valid/)
  })
})

describe("VERBS['note.lockToPubkey']", () => {
  const BASE = 'https://mock-mint.test'
  const CALLBACK = `${BASE}/w/cb`
  const AMOUNT = 20_000_000
  // any valid x-only key stands in for a MuSig2 group key / taproot Q
  const TARGET_HEX =
    'aad3a0e36c083eb0d2d92ec0860977dc46d10c952f31830e6443b1faa1997634'

  afterEach(() => vi.unstubAllGlobals())

  // a real mint signing key, so pubkeyVerified exercises genuine
  // signature recovery against the note's pinned key rather than a stub
  const mintPriv = secp256k1.utils.randomSecretKey()
  const mintPub = bytesToHex(secp256k1.getPublicKey(mintPriv, true))

  // the certificate a mint issues for a pubkey-committed output: the same
  // Lightning-signmessage digest a hash output gets, over (amount, Q)
  const certify = (outputHex: string, amountMsat: number): string => {
    const message = utf8ToBytes(`LNURLcash:${amountMsat}:${outputHex}`)
    const digest = sha256(
      sha256(
        new Uint8Array([
          ...utf8ToBytes('Lightning Signed Message:'),
          ...message
        ])
      )
    )
    const sig = secp256k1.sign(digest, mintPriv, {
      format: 'recovered',
      prehash: false
    })
    return bytesToHex(new Uint8Array([...sig.subarray(1), sig[0]!]))
  }

  const makeBearer = (over: Partial<Bearer> = {}): Bearer => ({
    id: 'source',
    url: `${BASE}/w?k1=${'a'.repeat(64)}&amount=${AMOUNT}`,
    callback: CALLBACK,
    amount: AMOUNT,
    verified: true,
    mintPubkey: mintPub,
    createdAt: 0,
    updatedAt: 0,
    ...over
  })

  const makeCtx = (bearer: Bearer) => {
    const markedSpent: string[] = []
    const ctx: VerbContext = {
      bearers: () => [bearer],
      addBearer: async note => ({
        id: 'x',
        ...note,
        createdAt: 0,
        updatedAt: 0
      }),
      updateBearer: async (id, changes) => {
        if (changes.spent) markedSpent.push(id)
      },
      removeBearer: () => {},
      logActivity: () => {},
      deviceClient: () => null,
      requireDeviceClient: () => {
        throw new Error('no device in this test')
      },
      addon: {id: 'musig2', name: 'MuSig2 Playground'}
    }
    return {ctx, markedSpent}
  }

  // a mint that accepts the mutation and certifies whatever output it was
  // handed, recording exactly which query params arrived
  const stubMint = () => {
    const seen: URLSearchParams[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const params = new URL(input.toString()).searchParams
        seen.push(params)
        return {
          json: async () => ({status: 'OK', sig: certify(TARGET_HEX, AMOUNT)})
        } as Response
      })
    )
    return seen
  }

  it('locks to p1=cp1<key>, and hands back the mint every spend of it is bound to', async () => {
    const seen = stubMint()
    const {ctx, markedSpent} = makeCtx(makeBearer())
    const result = (await VERBS['note.lockToPubkey']!(
      {note: 'source', pubkeyHex: TARGET_HEX},
      ctx
    )) as {mint: string; pubkeyVerified: boolean; groupPubkeyHex: string}

    expect(seen).toHaveLength(1)
    expect(seen[0]!.get('p1')).toBe(encodeCp1(hexToBytes(TARGET_HEX)))
    expect(seen[0]!.get('h')).toBeNull()
    expect(result.mint).toBe(new URL(BASE).hostname)
    expect(result.groupPubkeyHex).toBe(TARGET_HEX)
    expect(result.pubkeyVerified).toBe(true)
    expect(markedSpent).toEqual(['source'])
  })

  it("an old kind: 'ct1' argument still locks to cp1<Q> - every note is one kind", async () => {
    // a taproot output key with script leaves is an ordinary cp1 note: the
    // mint accepts its key path and every leaf alike, so there is nothing
    // left to choose
    const seen = stubMint()
    const {ctx} = makeCtx(makeBearer())
    await VERBS['note.lockToPubkey']!(
      {note: 'source', pubkeyHex: TARGET_HEX, kind: 'ct1'},
      ctx
    )
    expect(seen[0]!.get('p1')).toBe(encodeCp1(hexToBytes(TARGET_HEX)))
  })

  it('a mint that refuses the lock burns nothing and keeps the note', async () => {
    // the lock must fail cleanly and leave the wallet's note untouched
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({status: 'ERROR', reason: 'unsupported output'})
      })) as unknown as typeof fetch
    )
    const {ctx, markedSpent} = makeCtx(makeBearer())
    await expect(
      VERBS['note.lockToPubkey']!({note: 'source', pubkeyHex: TARGET_HEX}, ctx)
    ).rejects.toThrow()
    expect(markedSpent).toEqual([])
  })

  it('reports pubkeyVerified=false when the certificate is not from the pinned mint key', async () => {
    const impostor = secp256k1.utils.randomSecretKey()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const digest = sha256(
          sha256(
            new Uint8Array([
              ...utf8ToBytes('Lightning Signed Message:'),
              ...utf8ToBytes(`LNURLcash:${AMOUNT}:${TARGET_HEX}`)
            ])
          )
        )
        const sig = secp256k1.sign(digest, impostor, {
          format: 'recovered',
          prehash: false
        })
        return {
          json: async () => ({
            status: 'OK',
            sig: bytesToHex(new Uint8Array([...sig.subarray(1), sig[0]!]))
          })
        } as Response
      })
    )
    const {ctx} = makeCtx(makeBearer())
    const result = (await VERBS['note.lockToPubkey']!(
      {note: 'source', pubkeyHex: TARGET_HEX},
      ctx
    )) as {pubkeyVerified: boolean}
    // well-shaped, so accepted - but NOT certified by this note's mint
    expect(result.pubkeyVerified).toBe(false)
  })

  it('rejects a malformed key before touching the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const {ctx} = makeCtx(makeBearer())
    await expect(
      VERBS['note.lockToPubkey']!({note: 'source', pubkeyHex: 'not-hex'}, ctx)
    ).rejects.toThrow(/32-byte x-only/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
