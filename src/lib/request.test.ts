import {afterEach, describe, expect, it, vi} from 'vitest'
import {schnorr} from '@noble/curves/secp256k1.js'
import {
  fetchNoteInfo,
  fetchNoteInfoByPubkey,
  rotateNoteWithHash,
  splitNoteWithHash,
  mergeNotesWithHash,
  rotateNote,
  splitNote,
  mergeNotes
} from './request'
import {hashK1, signNoteOwnership, cp1FromCk1} from './signature'
import {encodeCk1, encodeCp1, encodeCs1} from './recoverableNotes'
import {AmbiguousMintError} from './errors'
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
      expect(request.searchParams.get('h')).toBe(hashK1(K1))
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

  it('falls back to raw k1 only when an older SERVICE requires it', async () => {
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
    expect((await fetchNoteInfo(NOTE_URL)).k1).toBe(K1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
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

  it('preserves mutation outputs when an OK response omits sig', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({json: async () => ({status: 'OK'})}) as Response)
    )
    await expect(
      rotateNoteWithHash('https://mint.example.com/w/cb', K1, 'b'.repeat(64))
    ).rejects.toBeInstanceOf(AmbiguousMintError)
  })

  it('requires both signatures for a split', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            json: async () => ({status: 'OK', sig: '00'.repeat(65)})
          }) as Response
      )
    )
    await expect(
      splitNoteWithHash(
        'https://mint.example.com/w/cb',
        [K1],
        1000,
        'b'.repeat(64),
        'c'.repeat(64)
      )
    ).rejects.toThrow(/sig2/)
  })
})

describe('LUD-25 Part 2: cp1/ck1/cs1 dual-mode support', () => {
  const secretKey = schnorr.utils.randomSecretKey()
  const pubkeyXOnly = schnorr.getPublicKey(secretKey)
  const ck1 = encodeCk1(signNoteOwnership(secretKey))
  const cp1 = encodeCp1(pubkeyXOnly)
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
        json: async () => ({status: 'OK', sig: '00'.repeat(65)})
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    await rotateNoteWithHash('https://mint.example.com/w/cb', K1, cp1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('mergeNotesWithHash sends h (not p1) for a legacy hash output', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      expect(request.searchParams.get('p1')).toBeNull()
      expect(request.searchParams.get('h')).toBe('b'.repeat(64))
      return {
        json: async () => ({status: 'OK', sig: '00'.repeat(65)})
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    await mergeNotesWithHash(
      'https://mint.example.com/w/cb',
      [K1],
      'b'.repeat(64)
    )
  })

  it('splitNoteWithHash dispatches each output field independently by shape', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      // first output legacy hash -> h, second output cp1 -> p2
      expect(request.searchParams.get('h')).toBe('b'.repeat(64))
      expect(request.searchParams.get('p2')).toBe(cp1)
      expect(request.searchParams.get('h2')).toBeNull()
      expect(request.searchParams.get('p1')).toBeNull()
      return {
        json: async () => ({
          status: 'OK',
          sig: '00'.repeat(65),
          sig2: '00'.repeat(65)
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
    const cert = encodeCs1(new Uint8Array(65).fill(0xab))
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({json: async () => ({status: 'OK', sig: cert})}) as Response
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

describe('rotateNote/splitNote/mergeNotes: pub/sig outputs never silently downgrade', () => {
  const secretKey = schnorr.utils.randomSecretKey()
  const ck1 = encodeCk1(signNoteOwnership(secretKey))
  // a second, distinct ck1 for the "every input" all-or-nothing checks
  const otherSecretKey = schnorr.utils.randomSecretKey()
  const otherCk1 = encodeCk1(signNoteOwnership(otherSecretKey))

  afterEach(() => {
    // reset both provider singletons back to their unconfigured defaults so
    // a provider wired up in one test can never leak into the next
    configureSecretProvider(() => 'f'.repeat(64))
    configurePubkeySecretProvider(() => null)
  })

  const okResponse = () =>
    ({
      json: async () => ({status: 'OK', sig: '00'.repeat(65)})
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

  it('rotateNote falls back to the legacy provider when no pubkey provider is configured', async () => {
    configureSecretProvider(() => 'f'.repeat(64))
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      expect(request.searchParams.get('p1')).toBeNull()
      expect(request.searchParams.get('h')).toBe(hashK1('f'.repeat(64)))
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
      expect(request.searchParams.get('p1')).toBeNull()
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
      // mixed batch (one legacy k1 among the inputs) - stays legacy
      expect(request.searchParams.get('p1')).toBeNull()
      expect(request.searchParams.get('p2')).toBeNull()
      return {
        json: async () => ({
          status: 'OK',
          sig: '00'.repeat(65),
          sig2: '00'.repeat(65)
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
