import {afterEach, describe, expect, it, vi} from 'vitest'
import {schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {
  fetchNoteInfo,
  fetchNoteInfoByPubkey,
  fetchMintAddress,
  rotateNoteWithHash,
  splitNoteWithHash,
  mergeNotesWithHash,
  rotateNoteWithHashShort,
  splitNoteWithHashShort,
  mergeNotesWithHashShort,
  fetchNoteInfoByHash,
  fetchNoteInfoByHashShort,
  rotateNote,
  upgradeNote,
  splitNote,
  mergeNotes
} from './request'
import {hashK1, signNoteOwnership, cp1FromCk1} from './signature'
import {
  encodeCk1,
  encodeCp1,
  encodeCs1WithAmount,
  encodeCw1,
  isCp1
} from './recoverableNotes'
import {noteRef} from './spend'

const CS1 = encodeCs1WithAmount(1000, new Uint8Array(65).fill(0xab))
import {
  AmbiguousMintError,
  AmbiguousMutationError,
  PendingNoteError
} from './errors'
import {configureSecretProvider, configurePubkeySecretProvider} from './secrets'

const K1 = 'a'.repeat(64)
const NOTE_URL = `https://mint.example.com/withdraw?k1=${K1}&amount=21000`
const MINT_KEY = `02${'11'.repeat(32)}`

afterEach(() => vi.unstubAllGlobals())

describe('mandatory offline-verification fields', () => {
  it('checks a note by hash without sending its bearer secret', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      expect(request.searchParams.get('k1')).toBeNull()
      expect(request.searchParams.get('p')).toBe(noteRef(hashK1(K1)))
      return {
        json: async () => ({
          tag: 'withdrawRequest',
          callback: 'https://mint.example.com/w/cb',
          minWithdrawable: 21000,
          maxWithdrawable: 21000,
          mintPubkey: MINT_KEY
        })
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    const info = await fetchNoteInfo(NOTE_URL)
    expect(info.k1).toBe(K1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('never falls back to sending the raw k1', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      const k1 = request.searchParams.get('k1')
      return {
        json: async () =>
          k1
            ? {
                tag: 'withdrawRequest',
                callback: 'https://mint.example.com/w/cb',
                k1,
                minWithdrawable: 21000,
                maxWithdrawable: 21000,
                mintPubkey: MINT_KEY
              }
            : {status: 'ERROR', reason: 'missing k1'}
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchNoteInfo(NOTE_URL)).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const sent = new URL(String(fetchMock.mock.calls[0]![0]))
    expect(sent.searchParams.get('k1')).toBeNull()
  })

  it('does not reveal k1 after an unknown hash response', async () => {
    const fetchMock = vi.fn(
      async () =>
        ({
          json: async () => ({status: 'ERROR', reason: 'Unknown note.'})
        }) as Response
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchNoteInfo(NOTE_URL)).rejects.toThrow(/unknown/i)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a note lookup without a persistent SERVICE key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            json: async () => ({
              tag: 'withdrawRequest',
              callback: 'https://mint.example.com/w/cb',
              minWithdrawable: 21000,
              maxWithdrawable: 21000
            })
          }) as Response
      )
    )
    await expect(fetchNoteInfo(NOTE_URL)).rejects.toThrow(/mintPubkey/)
  })

  it('classifies a pending informational lookup', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            json: async () => ({status: 'ERROR', reason: 'pending'})
          }) as Response
      )
    )
    await expect(fetchNoteInfo(NOTE_URL)).rejects.toBeInstanceOf(
      PendingNoteError
    )
  })

  it('accepts an unsigned plain-hash output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({json: async () => ({status: 'OK'})}) as Response)
    )
    await expect(
      rotateNoteWithHash('https://mint.example.com/w/cb', K1, 'b'.repeat(64))
    ).resolves.toEqual({})
  })

  it('preserves a valid optional certificate on a plain-hash output', async () => {
    const certificate = CS1
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            json: async () => ({status: 'OK', c: certificate})
          }) as Response
      )
    )
    await expect(
      rotateNoteWithHash('https://mint.example.com/w/cb', K1, 'b'.repeat(64))
    ).resolves.toEqual({signature: certificate})
  })

  it('ignores a malformed optional certificate on a plain-hash output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            json: async () => ({status: 'OK', c: 'not-a-signature'})
          }) as Response
      )
    )
    await expect(
      rotateNoteWithHash('https://mint.example.com/w/cb', K1, 'b'.repeat(64))
    ).resolves.toEqual({})
  })

  it('accepts two unsigned plain-hash split outputs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({json: async () => ({status: 'OK'})}) as Response)
    )
    await expect(
      splitNoteWithHash(
        'https://mint.example.com/w/cb',
        [K1],
        1000,
        'b'.repeat(64),
        'c'.repeat(64)
      )
    ).resolves.toEqual({})
  })
})

describe('mint address identity', () => {
  it('keeps an explicitly published nodePubkey without requiring nodeUri', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            json: async () => ({
              tag: 'withdrawRequest',
              callback: 'https://mint.example.com/w/cb',
              maxWithdrawable: 0,
              payLink: 'https://mint.example.com/.well-known/lnurlp/mint',
              mintPubkey: MINT_KEY,
              nodePubkey: MINT_KEY
            })
          }) as Response
      )
    )
    await expect(
      fetchMintAddress('https://mint.example.com/.well-known/lnurlw/mint')
    ).resolves.toMatchObject({nodePubkey: MINT_KEY})
  })
})

describe('mint address node identity', () => {
  const explicitKey = `03${'22'.repeat(32)}`
  const uriKey = `02${'33'.repeat(32)}`

  const respondWithMintAddress = (extra: Record<string, unknown>) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            json: async () => ({
              tag: 'withdrawRequest',
              callback: 'https://mint.example.com/w/cb',
              maxWithdrawable: 0,
              payLink: 'https://mint.example.com/.well-known/lnurlp/mint',
              mintPubkey: MINT_KEY,
              ...extra
            })
          }) as Response
      )
    )
  }

  it('prefers an explicit nodePubkey over the nodeUri prefix', async () => {
    respondWithMintAddress({
      nodePubkey: explicitKey,
      nodeUri: `${uriKey}@127.0.0.1:9735`
    })
    await expect(
      fetchMintAddress('https://mint.example.com/.well-known/lnurlw/mint')
    ).resolves.toMatchObject({nodePubkey: explicitKey})
  })

  it('falls back to the nodeUri prefix when nodePubkey is invalid', async () => {
    respondWithMintAddress({
      nodePubkey: 'not-a-node-key',
      nodeUri: `${uriKey}@127.0.0.1:9735`
    })
    await expect(
      fetchMintAddress('https://mint.example.com/.well-known/lnurlw/mint')
    ).resolves.toMatchObject({nodePubkey: uriKey})
  })
})

describe('LUD-25: cp1/ck1/cs1 dual-mode support', () => {
  const secretKey = schnorr.utils.randomSecretKey()
  const pubkeyXOnly = schnorr.getPublicKey(secretKey)
  const ownership = signNoteOwnership(secretKey, 'mint.example')
  const ck1 = encodeCk1(ownership.pubkeyXOnly, ownership.signature)
  const cp1 = encodeCp1(pubkeyXOnly)

  it('still requires a certificate for a cp1 output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({json: async () => ({status: 'OK'})}) as Response)
    )
    await expect(
      rotateNoteWithHash('https://mint.example.com/w/cb', K1, cp1)
    ).rejects.toBeInstanceOf(AmbiguousMintError)
  })
  const CK1_NOTE_URL = `https://mint.example.com/withdraw?k1=${ck1}&amount=21000`

  it('looks a ck1 note up by its public commitment (p=cp1<pk>), never its secret', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      expect(request.searchParams.get('k1')).toBeNull()
      expect(request.searchParams.get('h')).toBeNull()
      expect(request.searchParams.get('p')).toBe(cp1)
      return {
        json: async () => ({
          tag: 'withdrawRequest',
          callback: 'https://mint.example.com/w/cb',
          minWithdrawable: 21000,
          maxWithdrawable: 21000,
          mintPubkey: MINT_KEY
        })
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    const info = await fetchNoteInfo(CK1_NOTE_URL)
    expect(info.k1).toBe(ck1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // A real, pinned script-path proof - generated once with @scure/btc-
  // signer's own p2tr() tree builder (independent of anything in
  // lib/recoverableNotes.ts) and hardcoded here rather than built live:
  // this package ships without @scure/btc-signer as a dependency (see
  // recoverableNotes.ts's own top comment), and its isolated test run
  // (release-kit.yml) has no access to it. Same vectors
  // recoverableNotes.test.ts's own deriveScriptPathCommitment tests use.
  const leaf = hexToBytes(`20${'aa'.repeat(32)}ac`) // <32x 0xaa> CHECKSIG
  const controlBlock = hexToBytes(
    'c0' + '4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa'
  )
  const outputKeyHex =
    'd37208c49a038f693bc0b362b5a7f804938bfea0b3381cfb88fb69340bb92495'
  const scriptNoteCp1 = encodeCp1(hexToBytes(outputKeyHex))
  const cw1 = encodeCw1({
    locktime: 1_800_000_000,
    sequence: 0xfffffffe,
    script: leaf,
    controlBlock,
    witness: [hexToBytes('cc'.repeat(64))]
  })
  const CW1_NOTE_URL = `https://mint.example.com/withdraw?k1=${cw1}&amount=21000`

  it('looks a cw1 note up by its derived output key (p=cp1<Q>), never its secret - Q comes from the script itself, no mint round trip needed to find it', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      expect(request.searchParams.get('k1')).toBeNull()
      expect(request.searchParams.get('h')).toBeNull()
      expect(request.searchParams.get('p')).toBe(scriptNoteCp1)
      return {
        json: async () => ({
          tag: 'withdrawRequest',
          callback: 'https://mint.example.com/w/cb',
          minWithdrawable: 21000,
          maxWithdrawable: 21000,
          mintPubkey: MINT_KEY
        })
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    const info = await fetchNoteInfo(CW1_NOTE_URL)
    expect(info.k1).toBe(cw1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a cw1 with a malformed control block before ever touching the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const badCw1 = encodeCw1({
      locktime: 1_800_000_000,
      sequence: 0xfffffffe,
      script: leaf,
      controlBlock: new Uint8Array([1, 2, 3]),
      witness: []
    })
    await expect(
      fetchNoteInfo(
        `https://mint.example.com/withdraw?k1=${badCw1}&amount=21000`
      )
    ).rejects.toThrow(/output key/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetchNoteInfoByPubkey sends p=<value> directly', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      expect(request.searchParams.get('p')).toBe(cp1)
      return {
        json: async () => ({
          tag: 'withdrawRequest',
          callback: 'https://mint.example.com/w/cb',
          minWithdrawable: 5000,
          maxWithdrawable: 5000,
          mintPubkey: MINT_KEY
        })
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    const info = await fetchNoteInfoByPubkey(
      'https://mint.example.com/withdraw',
      cp1
    )
    expect(info.maxWithdrawable).toBe(5000)
  })

  it('does not reveal a ck1 secret after an unknown-pubkey response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            json: async () => ({status: 'ERROR', reason: 'Unknown note.'})
          }) as Response
      )
    )
    await expect(fetchNoteInfo(CK1_NOTE_URL)).rejects.toThrow(/unknown/i)
  })

  it('rotateNoteWithHash sends p1 (not h) for a cp1 output', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      expect(request.searchParams.get('h')).toBeNull()
      expect(request.searchParams.get('p1')).toBe(cp1)
      return {
        json: async () => ({status: 'OK', c: CS1})
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    await rotateNoteWithHash('https://mint.example.com/w/cb', K1, cp1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('mergeNotesWithHash sends a bearer hash output as its cp1 in p1', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      expect(request.searchParams.get('h')).toBeNull()
      expect(request.searchParams.get('p1')).toBe(noteRef('b'.repeat(64)))
      return {
        json: async () => ({status: 'OK', c: CS1})
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    await mergeNotesWithHash(
      'https://mint.example.com/w/cb',
      [K1],
      'b'.repeat(64)
    )
  })

  it("splitNoteWithHash sends a bearer hash's cp1 and a cp1 as p1/p2", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      expect(request.searchParams.get('p1')).toBe(noteRef('b'.repeat(64)))
      expect(request.searchParams.get('p2')).toBe(cp1)
      expect(request.searchParams.get('h')).toBeNull()
      expect(request.searchParams.get('h2')).toBeNull()
      return {
        json: async () => ({
          status: 'OK',
          c: CS1,
          c2: CS1
        })
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    await splitNoteWithHash(
      'https://mint.example.com/w/cb',
      [K1],
      1000,
      'b'.repeat(64),
      cp1
    )
  })

  it('preserves a cs1-encoded signature exactly as SERVICE sent it', async () => {
    const cert = CS1
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => ({json: async () => ({status: 'OK', c: cert})}) as Response
      )
    )
    const result = await rotateNoteWithHash(
      'https://mint.example.com/w/cb',
      K1,
      'b'.repeat(64)
    )
    expect(result.signature).toBe(cert)
  })
})

describe('WithdrawRequestInfo.c: informational GET may already disclose one', () => {
  it('ignores a plain-hex value on the informational GET: only a cs1 is a certificate', async () => {
    const c = 'ab'.repeat(65)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            json: async () => ({
              tag: 'withdrawRequest',
              callback: 'https://mint.example.com/w/cb',
              minWithdrawable: 21000,
              maxWithdrawable: 21000,
              mintPubkey: MINT_KEY,
              c
            })
          }) as Response
      )
    )
    const info = await fetchNoteInfo(NOTE_URL)
    expect(info.c).toBeUndefined()
  })

  it('captures a cs1-encoded certificate, preserved exactly as disclosed', async () => {
    const cert = encodeCs1WithAmount(21000, new Uint8Array(65).fill(0xcd))
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            json: async () => ({
              tag: 'withdrawRequest',
              callback: 'https://mint.example.com/w/cb',
              minWithdrawable: 21000,
              maxWithdrawable: 21000,
              mintPubkey: MINT_KEY,
              c: cert
            })
          }) as Response
      )
    )
    const info = await fetchNoteInfo(NOTE_URL)
    expect(info.c).toBe(cert)
  })

  it('leaves c undefined rather than leaking a malformed one through', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            json: async () => ({
              tag: 'withdrawRequest',
              callback: 'https://mint.example.com/w/cb',
              minWithdrawable: 21000,
              maxWithdrawable: 21000,
              mintPubkey: MINT_KEY,
              c: 'not-a-real-signature'
            })
          }) as Response
      )
    )
    const info = await fetchNoteInfo(NOTE_URL)
    expect(info.c).toBeUndefined()
  })

  it('leaves c undefined when SERVICE does not disclose one at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            json: async () => ({
              tag: 'withdrawRequest',
              callback: 'https://mint.example.com/w/cb',
              minWithdrawable: 21000,
              maxWithdrawable: 21000,
              mintPubkey: MINT_KEY
            })
          }) as Response
      )
    )
    const info = await fetchNoteInfo(NOTE_URL)
    expect(info.c).toBeUndefined()
  })
})

describe('rotateNote/splitNote/mergeNotes: pub/sig outputs never silently downgrade', () => {
  const secretKey = schnorr.utils.randomSecretKey()
  const ownership = signNoteOwnership(secretKey, 'mint.example')
  const ck1 = encodeCk1(ownership.pubkeyXOnly, ownership.signature)
  // a second, distinct ck1 for the "every input" all-or-nothing checks
  const otherSecretKey = schnorr.utils.randomSecretKey()
  const otherOwnership = signNoteOwnership(otherSecretKey, 'mint.example')
  const otherCk1 = encodeCk1(
    otherOwnership.pubkeyXOnly,
    otherOwnership.signature
  )

  afterEach(() => {
    // reset both provider singletons back to their unconfigured defaults so
    // a provider wired up in one test can never leak into the next
    configureSecretProvider(() => 'f'.repeat(64))
    configurePubkeySecretProvider(() => null)
  })

  const okResponse = () =>
    ({
      json: async () => ({status: 'OK', c: CS1})
    }) as Response

  it('rotateNote reissues a ck1 input as a pubkey-bound output when a provider is configured', async () => {
    configurePubkeySecretProvider(() => ck1)
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      expect(request.searchParams.get('h')).toBeNull()
      expect(request.searchParams.get('p1')).toBe(cp1FromCk1(ck1))
      return okResponse()
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await rotateNote('https://mint.example.com/w/cb', otherCk1)
    expect(result.k1).toBe(ck1)
  })

  // the domain a seed-derived branch is keyed under MUST be the callback's
  // bare host (serverOf), deliberately never the scheme/port-bearing
  // origin - a holder's own branch at a mint is meant to stay the SAME
  // branch regardless of which scheme/port that mint happens to be reached
  // through at any given moment (see src/lib/urls.ts's serverOf). Every
  // one of rotateNote/upgradeNote/splitNote/mergeNotes threads its own
  // domain through to the configured pubkey provider the same way - this
  // exercises rotateNote as the representative case.
  it('rotateNote derives the pubkey provider domain from the callback’s bare host, not its full origin', async () => {
    const seenDomains: string[] = []
    configurePubkeySecretProvider(domain => {
      seenDomains.push(domain)
      return ck1
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse())
    )
    await rotateNote('https://mint.example.com:8443/w/cb', otherCk1)
    expect(seenDomains).toEqual(['mint.example.com:8443'])
  })

  it('rotateNote falls back to the legacy provider when no pubkey provider is configured', async () => {
    configureSecretProvider(() => 'f'.repeat(64))
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      expect(request.searchParams.get('p1')).toBe(
        noteRef(hashK1('f'.repeat(64)))
      )
      return okResponse()
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await rotateNote('https://mint.example.com/w/cb', ck1)
    expect(result.k1).toBe('f'.repeat(64))
  })

  it('rotateNote never upgrades a legacy input to pub/sig, even with a provider configured', async () => {
    configurePubkeySecretProvider(() => ck1)
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      expect(request.searchParams.get('p1')).toBe(
        noteRef(hashK1('f'.repeat(64)))
      )
      return okResponse()
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await rotateNote(
      'https://mint.example.com/w/cb',
      'a'.repeat(64)
    )
    expect(result.k1).toBe('f'.repeat(64))
  })

  it('splitNote prefers pubkey outputs only when every input is ck1-shaped', async () => {
    configurePubkeySecretProvider(() => ck1)
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      // mixed batch (one bearer k1 among the inputs) - stays bearer
      const p1 = request.searchParams.get('p1')!
      const p2 = request.searchParams.get('p2')!
      expect(isCp1(p1) && isCp1(p2)).toBe(true)
      expect([p1, p2]).not.toContain(cp1FromCk1(ck1))
      return {
        json: async () => ({
          status: 'OK',
          c: CS1,
          c2: CS1
        })
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    await splitNote(
      'https://mint.example.com/w/cb',
      [otherCk1, 'a'.repeat(64)],
      1000
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('mergeNotes prefers a pubkey output when every input is ck1-shaped', async () => {
    configurePubkeySecretProvider(() => ck1)
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      expect(request.searchParams.get('p1')).toBe(cp1FromCk1(ck1))
      return okResponse()
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await mergeNotes('https://mint.example.com/w/cb', [
      otherCk1,
      ck1
    ])
    expect(result.k1).toBe(ck1)
  })
})

describe('upgradeNote: the explicit, holder-initiated plain -> pub/sig action', () => {
  const secretKey = schnorr.utils.randomSecretKey()
  const ownership = signNoteOwnership(secretKey, 'mint.example')
  const ck1 = encodeCk1(ownership.pubkeyXOnly, ownership.signature)

  afterEach(() => {
    configureSecretProvider(() => 'f'.repeat(64))
    configurePubkeySecretProvider(() => null)
  })

  const okResponse = () =>
    ({
      json: async () => ({status: 'OK', c: CS1})
    }) as Response

  it('reissues a plain legacy secret as a ck1, unlike an ordinary rotate', async () => {
    configurePubkeySecretProvider(() => ck1)
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      expect(request.searchParams.get('h')).toBeNull()
      expect(request.searchParams.get('p1')).toBe(cp1FromCk1(ck1))
      return okResponse()
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await upgradeNote(
      'https://mint.example.com/w/cb',
      'a'.repeat(64)
    )
    expect(result.k1).toBe(ck1)
  })

  it('refuses (before touching the network) rather than silently completing a same-kind rotate when no provider is configured', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      upgradeNote('https://mint.example.com/w/cb', 'a'.repeat(64))
    ).rejects.toThrow(/seed-derived key/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('wraps an ambiguous mutation with the fresh secret, same as rotateNote', async () => {
    configurePubkeySecretProvider(() => ck1)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down')
      })
    )
    await expect(
      upgradeNote('https://mint.example.com/w/cb', 'a'.repeat(64))
    ).rejects.toBeInstanceOf(AmbiguousMutationError)
  })
})

describe('short-form variants', () => {
  const h = 'b'.repeat(64)
  const okBody = {status: 'OK', c: CS1, c2: CS1}
  const capture = (seen: URL[], body: object) =>
    vi.fn(async (input: string | URL) => {
      seen.push(new URL(input.toString()))
      return {json: async () => body} as Response
    })

  it('send a bearer hash as its 64-hex short form', async () => {
    const seen: URL[] = []
    vi.stubGlobal('fetch', capture(seen, okBody))
    const cb = 'https://mint.example.com/w/cb'
    await rotateNoteWithHashShort(cb, K1, h)
    await mergeNotesWithHashShort(cb, [K1], h)
    await splitNoteWithHashShort(cb, [K1], 1000, h, h.replace(/b/g, 'c'))
    expect(seen.map(u => u.searchParams.get('p1'))).toEqual([h, h, h])
    expect(seen[2]!.searchParams.get('p2')).toBe('c'.repeat(64))
  })

  it('look a note up by its short form, or by its cp1 by default', async () => {
    const seen: URL[] = []
    vi.stubGlobal(
      'fetch',
      capture(seen, {
        tag: 'withdrawRequest',
        callback: 'https://mint.example.com/w/cb',
        minWithdrawable: 1000,
        maxWithdrawable: 1000,
        mintPubkey: MINT_KEY
      })
    )
    await fetchNoteInfoByHash('https://mint.example.com/w', h)
    await fetchNoteInfoByHashShort('https://mint.example.com/w', h)
    expect(seen.map(u => u.searchParams.get('p'))).toEqual([noteRef(h), h])
  })
})
