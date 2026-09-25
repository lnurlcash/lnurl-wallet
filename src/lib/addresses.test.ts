import {afterEach, describe, expect, it, vi} from 'vitest'
import {schnorr} from '@noble/curves/secp256k1.js'
import {
  registerUsername,
  unregisterUsername,
  scanForAddressNotes,
  resolveScanStartIndex
} from './addresses'
import {
  deriveNotePubkey,
  encodeCp1,
  NOTE_PURPOSE_WALLET,
  type Cx1
} from './recoverableNotes'

afterEach(() => vi.unstubAllGlobals())

const MINT_KEY = `02${'11'.repeat(32)}`
// a 64-byte BIP-340 Schnorr signature (signAddressProof, luds#ck1) - was a
// 65-byte recoverable-ECDSA one (130 hex chars) before that change
const SIG_PATTERN = /^[0-9a-f]{128}$/

describe('registerUsername', () => {
  it('POSTs cx1 and a sig proof to /p/{username}', async () => {
    const proofKey = schnorr.utils.randomSecretKey()
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const request = new URL(input.toString())
      expect(request.pathname).toBe('/p/alice')
      expect(init?.method).toBe('POST')
      expect(request.searchParams.get('cx1')).toBe('cx1fakevalue')
      expect(request.searchParams.get('sig')).toMatch(SIG_PATTERN)
      return {json: async () => ({status: 'OK'})} as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    await registerUsername(
      'https://mint.example.com',
      'alice',
      'cx1fakevalue',
      proofKey
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('omits npub entirely when not given', async () => {
    const proofKey = schnorr.utils.randomSecretKey()
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      expect(request.searchParams.has('npub')).toBe(false)
      return {json: async () => ({status: 'OK'})} as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    await registerUsername(
      'https://mint.example.com',
      'alice',
      'cx1fakevalue',
      proofKey
    )
  })

  it('sends npub exactly as given, when provided', async () => {
    const proofKey = schnorr.utils.randomSecretKey()
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      expect(request.searchParams.get('npub')).toBe('npub1fakevalue')
      return {json: async () => ({status: 'OK'})} as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    await registerUsername(
      'https://mint.example.com',
      'alice',
      'cx1fakevalue',
      proofKey,
      'npub1fakevalue'
    )
  })

  it('throws on a rejected registration, with the service reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            json: async () => ({
              status: 'ERROR',
              reason:
                'Ownership proof required to overwrite an existing registration.'
            })
          }) as Response
      )
    )
    await expect(
      registerUsername(
        'https://mint.example.com',
        'alice',
        'cx1fakevalue',
        schnorr.utils.randomSecretKey()
      )
    ).rejects.toThrow(/Ownership proof required/)
  })
})

describe('unregisterUsername', () => {
  it('DELETEs /p/{username} with a sig proof', async () => {
    const proofKey = schnorr.utils.randomSecretKey()
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const request = new URL(input.toString())
      expect(request.pathname).toBe('/p/alice')
      expect(init?.method).toBe('DELETE')
      expect(request.searchParams.get('sig')).toMatch(SIG_PATTERN)
      return {json: async () => ({status: 'OK'})} as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    await unregisterUsername('https://mint.example.com', 'alice', proofKey)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws on a rejected unregistration, with the service reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            json: async () => ({
              status: 'ERROR',
              reason: 'Invalid ownership signature.'
            })
          }) as Response
      )
    )
    await expect(
      unregisterUsername(
        'https://mint.example.com',
        'alice',
        schnorr.utils.randomSecretKey()
      )
    ).rejects.toThrow(/Invalid ownership signature/)
  })
})

describe('scanForAddressNotes', () => {
  const branch: Cx1 = {
    pubkeyXOnly: schnorr.getPublicKey(schnorr.utils.randomSecretKey()),
    chainCode: new Uint8Array(32).fill(0x42)
  }

  const pubkeyAt = (index: number) =>
    deriveNotePubkey(
      branch.pubkeyXOnly,
      branch.chainCode,
      NOTE_PURPOSE_WALLET,
      index
    )

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
      NOTE_PURPOSE_WALLET,
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
      NOTE_PURPOSE_WALLET,
      {gapLimit: 2, onFound: r => seen.push(r.index)}
    )
    expect(seen).toEqual([0, 1, 2])
    expect(results.map(r => r.index)).toEqual([0, 1, 2])
  })

  it('calls onProgress before every probe, hit or not', async () => {
    // index 0 exists, then a clean run of unknowns closes the scan
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      const p = request.searchParams.get('p')!
      if (p === encodeCp1(pubkeyAt(0))) {
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
    const progressed: number[] = []
    await scanForAddressNotes(
      'https://mint.example.com/withdraw',
      branch,
      NOTE_PURPOSE_WALLET,
      {
        gapLimit: 2,
        onProgress: index => progressed.push(index)
      }
    )
    expect(progressed).toEqual([0, 1, 2])
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
      NOTE_PURPOSE_WALLET,
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

    const spent: number[] = []
    const results = await scanForAddressNotes(
      'https://mint.example.com/withdraw',
      branch,
      NOTE_PURPOSE_WALLET,
      {gapLimit: 3, onSpent: index => spent.push(index)}
    )
    // the spent note at 0 is never returned as something to recover, but
    // it also must not have counted toward (or reset past) the gap limit
    // in a way that hides the real note at 2
    expect(results.map(r => r.index)).toEqual([2])
    // onSpent still reports it, so a caller can track the true
    // highest-used index past a note it can no longer recover
    expect(spent).toEqual([0])
  })

  it('propagates an unexpected error rather than silently truncating the scan', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network is down')
      })
    )
    await expect(
      scanForAddressNotes(
        'https://mint.example.com/withdraw',
        branch,
        NOTE_PURPOSE_WALLET,
        {
          gapLimit: 5
        }
      )
    ).rejects.toThrow()
  })

  // fetch stub whose /w answers cp1-pubkey lookups for a fixed set of
  // "live" indices on `branch` - reused by every checkBehind case below
  const fakeMintWithLiveIndices = (liveIndices: number[]) => {
    const live = new Set(liveIndices)
    return vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      const p = request.searchParams.get('p')!
      for (const i of live) {
        if (p === encodeCp1(pubkeyAt(i))) {
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
  }

  it('checkBehind finds a live note below startIndex the forward walk alone would never reach', async () => {
    // the note that would have been missed by the addressRecovery.ts
    // regression this guards against: startIndex is past it, and the
    // forward walk from there never looks back
    vi.stubGlobal('fetch', fakeMintWithLiveIndices([0]))
    const results = await scanForAddressNotes(
      'https://mint.example.com/withdraw',
      branch,
      NOTE_PURPOSE_WALLET,
      {gapLimit: 5, startIndex: 3, checkBehind: true}
    )
    expect(results.map(r => r.index)).toEqual([0])
  })

  it('checkBehind checks the full gapLimit-sized window even past a run of unknowns', async () => {
    // live at 0 only, startIndex 10, gapLimit 5 - the window is [5, 9], so
    // this must NOT find it (0 is out of the window) but must still probe
    // every index down to 5 without stopping early on the unknowns
    vi.stubGlobal('fetch', fakeMintWithLiveIndices([0, 6]))
    const probed: number[] = []
    const results = await scanForAddressNotes(
      'https://mint.example.com/withdraw',
      branch,
      NOTE_PURPOSE_WALLET,
      {
        gapLimit: 5,
        startIndex: 10,
        checkBehind: true,
        onProgress: index => probed.push(index)
      }
    )
    expect(results.map(r => r.index).sort((a, b) => a - b)).toEqual([6])
    expect(probed.filter(i => i < 10).sort((a, b) => a - b)).toEqual([
      5, 6, 7, 8, 9
    ])
  })

  it('checkBehind clamps its window at 0 and never probes a negative index', async () => {
    vi.stubGlobal('fetch', fakeMintWithLiveIndices([]))
    const probed: number[] = []
    await scanForAddressNotes(
      'https://mint.example.com/withdraw',
      branch,
      NOTE_PURPOSE_WALLET,
      {
        gapLimit: 5,
        startIndex: 2,
        checkBehind: true,
        onProgress: index => probed.push(index)
      }
    )
    expect(Math.min(...probed)).toBe(0)
  })

  it('omitting checkBehind never probes anything below startIndex', async () => {
    vi.stubGlobal('fetch', fakeMintWithLiveIndices([0]))
    const results = await scanForAddressNotes(
      'https://mint.example.com/withdraw',
      branch,
      NOTE_PURPOSE_WALLET,
      {gapLimit: 5, startIndex: 3}
    )
    expect(results).toEqual([])
  })

  it('minIndex keeps the forward walk going past a gap-limit-sized stretch of unknowns', async () => {
    // nothing live until index 30 - a plain gapLimit: 5 walk from 0 would
    // give up at index 5, long before ever reaching it
    vi.stubGlobal('fetch', fakeMintWithLiveIndices([30]))
    const results = await scanForAddressNotes(
      'https://mint.example.com/withdraw',
      branch,
      NOTE_PURPOSE_WALLET,
      {gapLimit: 5, minIndex: 30}
    )
    expect(results.map(r => r.index)).toEqual([30])
  })

  it('minIndex forces coverage through exactly that index and no further once nothing is found', async () => {
    vi.stubGlobal('fetch', fakeMintWithLiveIndices([]))
    const probed: number[] = []
    await scanForAddressNotes(
      'https://mint.example.com/withdraw',
      branch,
      NOTE_PURPOSE_WALLET,
      {
        gapLimit: 3,
        minIndex: 10,
        onProgress: index => probed.push(index)
      }
    )
    // consecutiveUnknown keeps accumulating past gapLimit throughout the
    // forced stretch (it isn't reset at minIndex) - so the moment index
    // passes 10, the ordinary stop condition is already satisfied and the
    // scan ends right there. A caller wanting a real gapLimit's worth of
    // searching past the hint bakes that margin into minIndex itself (e.g.
    // `serviceHint + gapLimit`, see addressRecovery.ts), not by expecting
    // this function to add a second one automatically.
    expect(probed).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('minIndex resumes an ordinary fresh gapLimit search if a hit resets the counter first', async () => {
    // live at index 8 (inside the forced stretch) - finding it resets
    // consecutiveUnknown to 0, so the scan genuinely searches gapLimit
    // more indices past minIndex afterward, same as any other hit would
    vi.stubGlobal('fetch', fakeMintWithLiveIndices([8]))
    const probed: number[] = []
    await scanForAddressNotes(
      'https://mint.example.com/withdraw',
      branch,
      NOTE_PURPOSE_WALLET,
      {
        gapLimit: 3,
        minIndex: 10,
        onProgress: index => probed.push(index)
      }
    )
    expect(probed).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })

  it('omitting minIndex behaves exactly as before (plain gapLimit stop)', async () => {
    vi.stubGlobal('fetch', fakeMintWithLiveIndices([]))
    const probed: number[] = []
    await scanForAddressNotes(
      'https://mint.example.com/withdraw',
      branch,
      NOTE_PURPOSE_WALLET,
      {
        gapLimit: 4,
        onProgress: index => probed.push(index)
      }
    )
    expect(probed).toEqual([0, 1, 2, 3])
  })
})

describe('resolveScanStartIndex', () => {
  it('ignores the hint entirely at localFloor 0 (fresh scan or explicit full rescan)', () => {
    expect(resolveScanStartIndex(0, 5)).toBe(0)
    expect(resolveScanStartIndex(0, undefined)).toBe(0)
  })

  it('raises an already-nonzero floor forward to a higher hint', () => {
    expect(resolveScanStartIndex(1, 5)).toBe(5)
  })

  it('never lowers an already-nonzero floor below itself', () => {
    expect(resolveScanStartIndex(10, 2)).toBe(10)
    expect(resolveScanStartIndex(10, undefined)).toBe(10)
  })
})
