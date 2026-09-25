import {afterEach, describe, expect, it, vi} from 'vitest'
import {schnorr} from '@noble/curves/secp256k1.js'
import {
  parseInternalTransferHint,
  payInternalTransfer,
  type InternalTransferHint
} from './internalTransfer'
import {
  deriveNotePubkey,
  encodeCp1,
  encodeCx1,
  encodeCk1,
  encodeCs1WithAmount,
  NOTE_PURPOSE_LIGHTNING_ADDRESS,
  type Cx1
} from './recoverableNotes'
import {AmbiguousMutationError} from './errors'
import {configurePubkeySecretProvider} from './secrets'
import {signNoteOwnership} from './signature'

const SIG = encodeCs1WithAmount(1000, new Uint8Array(65).fill(0xaa))
const SIG2 = encodeCs1WithAmount(1000, new Uint8Array(65).fill(0xbb))

afterEach(() => vi.unstubAllGlobals())

describe('parseInternalTransferHint', () => {
  const branch: Cx1 = {
    pubkeyXOnly: schnorr.getPublicKey(schnorr.utils.randomSecretKey()),
    chainCode: new Uint8Array(32).fill(0x42)
  }
  const cx1 = encodeCx1(branch.pubkeyXOnly, branch.chainCode)

  it('parses a text/cpub entry into {cx1, startIndex}', () => {
    const metadata = JSON.stringify([
      ['text/plain', 'a mint'],
      ['text/cpub', `${cx1}:7`]
    ])
    expect(parseInternalTransferHint(metadata)).toEqual({
      cx1: branch,
      startIndex: 7
    })
  })

  it('is null for metadata with no text/cpub entry, or invalid JSON', () => {
    expect(
      parseInternalTransferHint(JSON.stringify([['text/plain', 'a mint']]))
    ).toBeNull()
    expect(parseInternalTransferHint('not json')).toBeNull()
    expect(parseInternalTransferHint('{}')).toBeNull()
  })

  it('rejects a malformed cx1 or a non-integer/negative index', () => {
    expect(
      parseInternalTransferHint(JSON.stringify([['text/cpub', `${cx1}:-1`]]))
    ).toBeNull()
    expect(
      parseInternalTransferHint(JSON.stringify([['text/cpub', `${cx1}:abc`]]))
    ).toBeNull()
    expect(
      parseInternalTransferHint(JSON.stringify([['text/cpub', 'cp1garbage:0']]))
    ).toBeNull()
    expect(
      parseInternalTransferHint(JSON.stringify([['text/cpub', cx1]]))
    ).toBeNull()
  })
})

describe('payInternalTransfer', () => {
  const branch: Cx1 = {
    pubkeyXOnly: schnorr.getPublicKey(schnorr.utils.randomSecretKey()),
    chainCode: new Uint8Array(32).fill(0x7)
  }
  const cp1At = (index: number) =>
    encodeCp1(
      deriveNotePubkey(
        branch.pubkeyXOnly,
        branch.chainCode,
        NOTE_PURPOSE_LIGHTNING_ADDRESS,
        index
      )
    )

  const okResponse = () =>
    ({json: async () => ({status: 'OK', c: SIG})}) as Response
  const okSplitResponse = () =>
    ({
      json: async () => ({
        status: 'OK',
        c: SIG,
        c2: SIG2
      })
    }) as Response
  const errorResponse = (reason: string) =>
    ({json: async () => ({status: 'ERROR', reason})}) as Response

  it('merges to pk_i when amountMsat equals the full input value', async () => {
    const hint: InternalTransferHint = {cx1: branch, startIndex: 3}
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      expect(request.searchParams.getAll('k1')).toEqual(['secretA'])
      expect(request.searchParams.get('p1')).toBe(cp1At(3))
      expect(request.searchParams.has('amount')).toBe(false)
      return okResponse()
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await payInternalTransfer(
      'https://mint.example.com/w/cb',
      ['secretA'],
      21000,
      21000,
      hint
    )
    expect(result).toEqual({
      kind: 'merge',
      index: 3,
      signature: SIG
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('splits off pk_i and keeps a fresh change secret when paying less than the full input value', async () => {
    const hint: InternalTransferHint = {cx1: branch, startIndex: 0}
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      expect(request.searchParams.get('amount')).toBe('5000')
      expect(request.searchParams.get('p1')).toBe(cp1At(0))
      // change is a bearer secret by default (no pubkey provider configured
      // in tests) - disclosed as p2, its hashlock note's cp1
      expect(request.searchParams.get('p2')).toMatch(/^cp1/)
      return okSplitResponse()
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await payInternalTransfer(
      'https://mint.example.com/w/cb',
      ['secretA'],
      5000,
      10000,
      hint
    )
    expect(result.kind).toBe('split')
    if (result.kind === 'split') {
      expect(result.index).toBe(0)
      expect(result.signature).toBe(SIG)
      expect(result.changeSignature).toBe(SIG2)
      expect(result.change).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  // the change output's own domain (for a configured pubkey provider) must
  // be the callback's bare host, never its full scheme/port-bearing origin
  // - see request.test.ts's identical rotateNote case and
  // src/lib/urls.ts's serverOf for why
  it('derives the change output’s pubkey provider domain from the callback’s bare host', async () => {
    // preferPubkey only turns on when every input is already ck1-shaped
    // (isCk1) - a plain placeholder string like the other tests' 'secretA'
    // never triggers the pubkey provider at all
    const inputCk1 = encodeCk1(
      signNoteOwnership(schnorr.utils.randomSecretKey(), 'mint.example')
        .pubkeyXOnly,
      signNoteOwnership(schnorr.utils.randomSecretKey(), 'mint.example')
        .signature
    )
    const seenDomains: string[] = []
    configurePubkeySecretProvider(domain => {
      seenDomains.push(domain)
      return null // falls back to the legacy provider - only the domain matters here
    })
    try {
      const hint: InternalTransferHint = {cx1: branch, startIndex: 0}
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => okSplitResponse())
      )
      await payInternalTransfer(
        'https://mint.example.com:8443/w/cb',
        [inputCk1],
        5000,
        10000,
        hint
      )
      expect(seenDomains).toEqual(['mint.example.com:8443'])
    } finally {
      configurePubkeySecretProvider(() => null)
    }
  })

  it('retries at the next index when SERVICE reports pk_i already in use', async () => {
    const hint: InternalTransferHint = {cx1: branch, startIndex: 0}
    let calls = 0
    const fetchMock = vi.fn(async (input: string | URL) => {
      calls++
      const request = new URL(input.toString())
      const p1 = request.searchParams.get('p1')
      if (p1 === cp1At(0)) return errorResponse('already in use')
      if (p1 === cp1At(1)) return okResponse()
      throw new Error(`unexpected p1: ${p1}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await payInternalTransfer(
      'https://mint.example.com/w/cb',
      ['secretA'],
      21000,
      21000,
      hint
    )
    expect(result).toEqual({
      kind: 'merge',
      index: 1,
      signature: SIG
    })
    expect(calls).toBe(2)
  })

  it('gives up after exhausting every index attempt', async () => {
    const hint: InternalTransferHint = {cx1: branch, startIndex: 0}
    const fetchMock = vi.fn(async () => errorResponse('already in use'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      payInternalTransfer(
        'https://mint.example.com/w/cb',
        ['secretA'],
        21000,
        21000,
        hint
      )
    ).rejects.toThrow(/already in use/)
  })

  it('refuses to pay more than the selected notes are worth, without any request', async () => {
    const hint: InternalTransferHint = {cx1: branch, startIndex: 0}
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      payInternalTransfer(
        'https://mint.example.com/w/cb',
        ['secretA'],
        10000,
        5000,
        hint
      )
    ).rejects.toThrow(/Cannot pay more/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('on an ambiguous split failure, carries only the change secret (never the recipient output)', async () => {
    const hint: InternalTransferHint = {cx1: branch, startIndex: 0}
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network is down')
      })
    )
    try {
      await payInternalTransfer(
        'https://mint.example.com/w/cb',
        ['secretA'],
        5000,
        10000,
        hint
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(AmbiguousMutationError)
      const ambiguous = err as AmbiguousMutationError
      expect(ambiguous.newSecrets).toHaveLength(1)
      expect(ambiguous.newSecrets[0]).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})
