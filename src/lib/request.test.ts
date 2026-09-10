import {afterEach, describe, expect, it, vi} from 'vitest'
import {fetchNoteInfo, rotateNoteWithHash, splitNoteWithHash} from './request'
import {hashK1} from './signature'
import {AmbiguousMintError} from './errors'

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
