import {afterEach, describe, expect, it, vi} from 'vitest'
import {schnorr} from '@noble/curves/secp256k1.js'
import {registerUsername, scanForAddressNotes} from './addresses'
import {deriveNotePubkey, encodeCp1, type Cx1} from './recoverableNotes'

afterEach(() => vi.unstubAllGlobals())

const MINT_KEY = `02${'11'.repeat(32)}`

describe('registerUsername', () => {
  it('sends username and cx1 as query params to /register', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      expect(request.pathname).toBe('/register')
      expect(request.searchParams.get('username')).toBe('alice')
      expect(request.searchParams.get('cx1')).toBe('cx1fakevalue')
      return {json: async () => ({status: 'OK'})} as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    await registerUsername('https://mint.example.com', 'alice', 'cx1fakevalue')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws on a rejected registration, with the service reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            json: async () => ({
              status: 'ERROR',
              reason: 'Username already registered.'
            })
          }) as Response
      )
    )
    await expect(
      registerUsername('https://mint.example.com', 'alice', 'cx1fakevalue')
    ).rejects.toThrow(/already registered/)
  })
})

describe('scanForAddressNotes', () => {
  const branch: Cx1 = {
    pubkeyXOnly: schnorr.getPublicKey(schnorr.utils.randomSecretKey()),
    chainCode: new Uint8Array(32).fill(0x42)
  }

  const pubkeyAt = (index: number) =>
    deriveNotePubkey(branch.pubkeyXOnly, branch.chainCode, index)

  it('finds notes at known indices and stops after the gap limit', async () => {
    // notes exist at index 0 and 2 only
    const existing = new Set([0, 2])
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      const p = request.searchParams.get('p')!
      for (let i = 0; i < 10; i++) {
        if (p === encodeCp1(pubkeyAt(i)) && existing.has(i)) {
          return {
            json: async () => ({
              tag: 'withdrawRequest',
              callback: 'https://mint.example.com/w/cb',
              minWithdrawable: 1000,
              maxWithdrawable: 1000,
              mintPubkey: MINT_KEY
            })
          } as Response
        }
      }
      return {
        json: async () => ({status: 'ERROR', reason: 'Unknown note.'})
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    const results = await scanForAddressNotes(
      'https://mint.example.com/withdraw',
      branch,
      {gapLimit: 3}
    )
    expect(results.map(r => r.index)).toEqual([0, 2])
  })

  it('calls onFound as each note is discovered', async () => {
    // indices 0-2 exist, then a clean run of unknowns closes the scan
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      const p = request.searchParams.get('p')!
      const isKnown = [0, 1, 2].some(i => p === encodeCp1(pubkeyAt(i)))
      if (isKnown) {
        return {
          json: async () => ({
            tag: 'withdrawRequest',
            callback: 'https://mint.example.com/w/cb',
            minWithdrawable: 1000,
            maxWithdrawable: 1000,
            mintPubkey: MINT_KEY
          })
        } as Response
      }
      return {
        json: async () => ({status: 'ERROR', reason: 'Unknown note.'})
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    const seen: number[] = []
    const results = await scanForAddressNotes(
      'https://mint.example.com/withdraw',
      branch,
      {gapLimit: 2, onFound: r => seen.push(r.index)}
    )
    expect(seen).toEqual([0, 1, 2])
    expect(results.map(r => r.index)).toEqual([0, 1, 2])
  })

  it('retries (without counting toward the gap) on a rate-limited response', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls++
      if (calls === 1) {
        return {
          json: async () => ({status: 'ERROR', reason: 'rate limited'})
        } as Response
      }
      return {
        json: async () => ({status: 'ERROR', reason: 'Unknown note.'})
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    const results = await scanForAddressNotes(
      'https://mint.example.com/withdraw',
      branch,
      {gapLimit: 1, rateLimitBackoffMs: 1}
    )
    expect(results).toEqual([])
    // index 0 was probed twice (rate-limited, then unknown) before the
    // gap limit of 1 was reached
    expect(calls).toBe(2)
  })

  it('skips an already-spent index and keeps scanning past it', async () => {
    // index 0 was already spent, index 2 is a still-unspent note behind it
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      const p = request.searchParams.get('p')!
      if (p === encodeCp1(pubkeyAt(0))) {
        return {
          json: async () => ({status: 'ERROR', reason: 'Note already spent.'})
        } as Response
      }
      if (p === encodeCp1(pubkeyAt(2))) {
        return {
          json: async () => ({
            tag: 'withdrawRequest',
            callback: 'https://mint.example.com/w/cb',
            minWithdrawable: 1000,
            maxWithdrawable: 1000,
            mintPubkey: MINT_KEY
          })
        } as Response
      }
      return {
        json: async () => ({status: 'ERROR', reason: 'Unknown note.'})
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    const results = await scanForAddressNotes(
      'https://mint.example.com/withdraw',
      branch,
      {gapLimit: 3}
    )
    // the spent note at 0 is never returned as something to recover, but
    // it also must not have counted toward (or reset past) the gap limit
    // in a way that hides the real note at 2
    expect(results.map(r => r.index)).toEqual([2])
  })

  it('propagates an unexpected error rather than silently truncating the scan', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network is down')
      })
    )
    await expect(
      scanForAddressNotes('https://mint.example.com/withdraw', branch, {
        gapLimit: 5
      })
    ).rejects.toThrow()
  })
})
