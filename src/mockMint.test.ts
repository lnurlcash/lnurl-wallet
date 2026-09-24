import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'

import {
  fetchPayRequest,
  requestInvoice,
  fetchInvoiceVerification,
  buildNoteUrl,
  fetchNoteInfo,
  fetchMintAddress,
  rotateNote,
  splitNote,
  mergeNotes,
  meltNote,
  settleNote,
  toBech32Lnurl,
  probeBurnedNote,
  canUseMintComment,
  requireMintComment,
  generateNoteSecret,
  hashK1,
  PendingNoteError,
  NoteSpentError,
  NoteUnknownError,
  ServiceError,
  AmbiguousMintError,
  AmbiguousMutationError
} from './lnurlcash'
import {receiveNote} from './receive'
import {bearerNoteIdOfHash, bearerNoteIdOfPreimage} from './lib/spend'
import {decodeCp1, encodeCp1, encodeCs1WithAmount} from './lib/recoverableNotes'

// Exercises the stateful multi-step flows Mint.tsx/MeltDialog.tsx/Wallet.tsx
// drive (mint -> rotate -> split -> merge -> melt, pending-note recovery,
// rotation-on-failure) against an in-memory mock of a LUD-25 SERVICE, so
// they're covered without a live lnurl-mint process (see integration.test.ts
// for that, opt-in via MINT_K1) and without rendering the SolidJS pages
// themselves (no component-testing setup in this repo yet). This drives the
// exact exported functions those pages call - only the fetch() layer is
// faked.

const BASE = 'https://mock-mint.test'
const PAY_URL = `${BASE}/pay`
const PAY_CALLBACK = `${BASE}/pay/cb`
// Current mint profile, advertising the mandatory LUD-12 comment capacity.
// PAY_URL remains a generic/legacy fixture for low-level protocol tests.
const PAY_COMMENT_URL = `${BASE}/pay-comment`
const PAY_COMMENT_CALLBACK = `${BASE}/pay-comment/cb`
const WITHDRAW_URL = `${BASE}/w`
const WITHDRAW_CALLBACK = `${BASE}/w/cb`
const MINT_ADDRESS_URL = `${BASE}/mintaddress`
const MINT_ADDRESS_BAD_URL = `${BASE}/mintaddress-bad`
const MINT_ADDRESS_UNKNOWN_URL = `${BASE}/mintaddress-unknown`
const MINT_KEY = `02${'11'.repeat(32)}`
const NODE_KEY = `02${'33'.repeat(32)}`
const NOTE_SIGNATURE = encodeCs1WithAmount(1000, new Uint8Array(65))

const randomHex = (bytes: number): string =>
  bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)))

const idFromVerifyUrl = (url: string): string => url.split('/').pop()!

type Note = {amountMsat: number; pending: boolean}
// `comment`: the mandatory current-mint output commitment.
type Invoice = {
  amountMsat: number
  preimage: string
  settled: boolean
  comment?: string
}
type Melt = {noteHash: string; settled: boolean}

// Notes are keyed by hex(Q), their taproot output key, as a real mint
// keys them: a bearer k1's Q is its hashlock note's, and a disclosed
// reference is a cp1 or a bearer note's 64-hex `h` (its short form).
const noteIdOfK1 = (k1: string): string => bearerNoteIdOfPreimage(k1)
const noteIdOfRef = (value: string): string | null => {
  const q = decodeCp1(value)
  if (q) return bytesToHex(q)
  return /^[0-9a-f]{64}$/i.test(value) ? bearerNoteIdOfHash(value) : null
}

// A minimal in-memory LUD-25 SERVICE: just enough of LUD-03/06/17/21/25 to
// drive this wallet's own protocol orchestration. It never learns the raw
// secret of a rotated/split/merged note, only the reference the wallet
// discloses as p1/p2.
class MockMint {
  private notes = new Map<string, Note>()
  // hashes of notes once outstanding but since burned (rotate/split/merge
  // input, or a settled melt) - kept around, like the real lnurl-mint keeps
  // spent=1 rows rather than deleting them, so GET /w can tell "this was
  // spent" apart from "this was never a note at all"
  private spent = new Set<string>()
  private invoices = new Map<string, Invoice>()
  private melts = new Map<string, Melt>()
  private invoiceCounter = 0
  private meltCounter = 0
  // when set, /w/cb requests are still fully processed (state mutated),
  // but the response never arrives - the fetch rejects the way a dropped
  // connection would. Models a mutation that landed despite its transport
  // failure, for the AmbiguousMutationError recovery paths
  dropCallbackResponses = false

  // when set, every rotate request fails without touching state - models a
  // transient SERVICE hiccup to exercise the wallet's rotate-and-fall-back
  // path (see settleNote)
  rotateFails = false

  seed(k1: string, amountMsat: number): void {
    this.notes.set(noteIdOfK1(k1), {amountMsat, pending: false})
  }

  isOutstanding(k1: string): boolean {
    return this.notes.has(noteIdOfK1(k1))
  }

  // Simulates paying an invoice. Current mint invoices are always keyed by
  // the LUD-12 commitment; the legacy generic fixture remains preimage-keyed
  // only for compatibility tests unrelated to new wallet mint creation.
  settleInvoice(invoiceId: string): void {
    const invoice = this.invoices.get(invoiceId)
    if (!invoice) throw new Error('no such invoice')
    invoice.settled = true
    const noteHash =
      (invoice.comment && noteIdOfRef(invoice.comment)) ??
      noteIdOfK1(invoice.preimage)
    this.notes.set(noteHash, {
      amountMsat: invoice.amountMsat,
      pending: false
    })
  }

  // simulates the outgoing payment behind a melt settling for good
  settleMelt(meltId: string): void {
    const melt = this.melts.get(meltId)
    if (!melt) throw new Error('no such melt')
    melt.settled = true
    this.spent.add(melt.noteHash)
    this.notes.delete(melt.noteHash)
  }

  // simulates that outgoing payment failing - per spec, the note is
  // restored to outstanding exactly as before the attempt
  failMelt(meltId: string): void {
    const melt = this.melts.get(meltId)
    if (!melt) throw new Error('no such melt')
    const note = this.notes.get(melt.noteHash)
    if (note) note.pending = false
  }

  private respond(body: object): Promise<Response> {
    return Promise.resolve({json: async () => body} as unknown as Response)
  }

  private error(reason: string): Promise<Response> {
    return this.respond({status: 'ERROR', reason})
  }

  private ok(body: object = {}): Promise<Response> {
    return this.respond({status: 'OK', ...body})
  }

  fetch = async (input: string | URL): Promise<Response> => {
    const url = new URL(input.toString())
    if (this.dropCallbackResponses && url.pathname === '/w/cb') {
      // process the request for real, then lose the response
      this.dropCallbackResponses = false
      await this.fetch(input)
      this.dropCallbackResponses = true
      throw new TypeError('fetch failed')
    }
    const params = url.searchParams

    if (url.pathname === '/pay') {
      return this.respond({
        tag: 'payRequest',
        callback: PAY_CALLBACK,
        minSendable: 1000,
        maxSendable: 100_000_000,
        metadata: JSON.stringify([['text/plain', 'mock mint']]),
        withdrawLink: WITHDRAW_URL
      })
    }

    // same mint, additionally LUD-12-capable (see PAY_COMMENT_URL above)
    if (url.pathname === '/pay-comment') {
      return this.respond({
        tag: 'payRequest',
        callback: PAY_COMMENT_CALLBACK,
        minSendable: 1000,
        maxSendable: 100_000_000,
        metadata: JSON.stringify([['text/plain', 'mock mint (comment)']]),
        withdrawLink: WITHDRAW_URL,
        commentAllowed: 64
      })
    }

    if (url.pathname === '/pay/cb' || url.pathname === '/pay-comment/cb') {
      const amountMsat = Number(params.get('amount'))
      const comment = params.get('comment') ?? undefined
      if (
        url.pathname === '/pay-comment/cb' &&
        (!comment || noteIdOfRef(comment) === null)
      ) {
        return this.error('comment must be a cp1 or 64 hex characters')
      }
      const id = String(this.invoiceCounter++)
      this.invoices.set(id, {
        amountMsat,
        preimage: randomHex(32),
        settled: false,
        comment
      })
      return this.respond({
        pr: `lnbcmock${id}`,
        verify: `${BASE}/verify/pay/${id}`,
        disposable: true
      })
    }

    // LUD-25 mint address (experimental) - the withdraw-side discovery
    // response fetchMintAddress parses (see lnurlcash.ts)
    if (url.pathname === '/mintaddress') {
      return this.respond({
        tag: 'withdrawRequest',
        callback: WITHDRAW_URL,
        minWithdrawable: 1000,
        maxWithdrawable: 100_000_000,
        payLink: PAY_URL,
        mintPubkey: MINT_KEY,
        nodeAlias: 'mock node',
        nodeUri: `${NODE_KEY}@127.0.0.1:9735`,
        nodeColor: '#3399ff',
        // the wire name, as lnurl-mint sends it - not the nodeCapacityMsat
        // the parsed type exposes
        nodeCapacity: 750_000_000,
        nodeNumChannels: 3,
        nodeNumPeers: 5
      })
    }
    if (url.pathname === '/mintaddress-bad') {
      // missing payLink/maxWithdrawable - not a well-formed mint address
      return this.respond({tag: 'withdrawRequest', callback: WITHDRAW_URL})
    }
    if (url.pathname === '/mintaddress-unknown') {
      return this.error('Unknown user.')
    }

    const payVerify = url.pathname.match(/^\/verify\/pay\/(.+)$/)
    if (payVerify) {
      const invoice = this.invoices.get(payVerify[1])
      if (!invoice) return this.error('unknown invoice')
      return this.respond({
        settled: invoice.settled,
        preimage: invoice.settled ? invoice.preimage : null,
        pr: `lnbcmock${payVerify[1]}`
      })
    }

    const meltVerify = url.pathname.match(/^\/verify\/melt\/(.+)$/)
    if (meltVerify) {
      const melt = this.melts.get(meltVerify[1])
      if (!melt) return this.error('unknown melt')
      return this.respond({
        settled: melt.settled,
        preimage: null,
        pr: 'lnbcmockmelt'
      })
    }

    if (url.pathname === '/w') {
      const k1 = params.get('k1')
      const requestedHash = params.get('p')
      if (!k1 && !requestedHash) return this.error('missing k1')
      const hash = requestedHash ? noteIdOfRef(requestedHash) : noteIdOfK1(k1!)
      const note = this.notes.get(hash)
      if (!note) {
        return this.error(
          requestedHash
            ? 'Unknown note.'
            : this.spent.has(hash)
              ? 'Note already spent.'
              : 'Unknown note.'
        )
      }
      return this.respond({
        tag: 'withdrawRequest',
        callback: WITHDRAW_CALLBACK,
        ...(k1 ? {k1} : {}),
        minWithdrawable: note.amountMsat,
        maxWithdrawable: note.amountMsat,
        mintPubkey: MINT_KEY
      })
    }

    if (url.pathname === '/w/cb') {
      const k1s = params.getAll('k1')
      const pr = params.get('pr')
      const amount = params.get('amount')
      const p1 = params.get('p1')
      const p2 = params.get('p2')
      const h = p1 ? noteIdOfRef(p1) : null
      const h2 = p2 ? noteIdOfRef(p2) : null

      if (k1s.length === 0) return this.error('missing k1')
      const hashes = k1s.map(noteIdOfK1)
      const notes = hashes.map(hash => this.notes.get(hash))
      if (notes.some(n => !n)) return this.error('not found')
      if (notes.some(n => n!.pending)) return this.error('pending')

      // melt: LUD-03 semantics untouched - single k1, pr, no h
      if (pr && k1s.length === 1 && !h) {
        const hash = hashes[0]
        this.notes.get(hash)!.pending = true
        const meltId = String(this.meltCounter++)
        this.melts.set(meltId, {noteHash: hash, settled: false})
        return this.ok({pr, verify: `${BASE}/verify/melt/${meltId}`})
      }

      // rotate: single k1, h only
      if (h && !h2 && !amount && !pr && k1s.length === 1) {
        if (this.rotateFails) return this.error('simulated failure')
        const total = notes.reduce((sum, n) => sum + n!.amountMsat, 0)
        for (const hash of hashes) {
          this.spent.add(hash)
          this.notes.delete(hash)
        }
        this.notes.set(h, {amountMsat: total, pending: false})
        return this.ok({sig: NOTE_SIGNATURE})
      }

      // split: one or many k1s, amount + h + h2, no pr (LUD-25)
      if (amount && h && h2 && !pr) {
        const target = Number(amount)
        const total = notes.reduce((sum, n) => sum + n!.amountMsat, 0)
        const change = total - target
        if (change < 0) return this.error('insufficient value')
        for (const hash of hashes) {
          this.spent.add(hash)
          this.notes.delete(hash)
        }
        this.notes.set(h, {amountMsat: target, pending: false})
        this.notes.set(h2, {amountMsat: change, pending: false})
        return this.ok({sig: NOTE_SIGNATURE, sig2: NOTE_SIGNATURE})
      }

      // merge: many k1s, h only, no amount/pr
      if (h && !h2 && !amount && !pr && k1s.length > 1) {
        const total = notes.reduce((sum, n) => sum + n!.amountMsat, 0)
        for (const hash of hashes) {
          this.spent.add(hash)
          this.notes.delete(hash)
        }
        this.notes.set(h, {amountMsat: total, pending: false})
        return this.ok({sig: NOTE_SIGNATURE})
      }

      return this.error('bad request')
    }

    return this.error('not found')
  }
}

let mint: MockMint

beforeEach(() => {
  mint = new MockMint()
  vi.stubGlobal('fetch', mint.fetch as unknown as typeof fetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('LUD-25 mint address (experimental)', () => {
  it('parses node identity/capacity and mint limits', async () => {
    const info = await fetchMintAddress(MINT_ADDRESS_URL)
    expect(info.tag).toBe('withdrawRequest')
    expect(info.payLink).toBe(PAY_URL)
    expect(info.callback).toBe(WITHDRAW_URL)
    expect(info.minWithdrawable).toBe(1000)
    expect(info.maxWithdrawable).toBe(100_000_000)
    expect(info.mintPubkey).toBe(MINT_KEY)
    expect(info.nodePubkey).toBe(NODE_KEY)
    expect(info.nodeAlias).toBe('mock node')
    expect(info.nodeUri).toBe(`${NODE_KEY}@127.0.0.1:9735`)
    expect(info.nodeColor).toBe('#3399ff')
    expect(info.nodeCapacityMsat).toBe(750_000_000)
    expect(info.nodeNumChannels).toBe(3)
    expect(info.nodeNumPeers).toBe(5)
  })

  it('rejects a response missing payLink/maxWithdrawable', async () => {
    await expect(fetchMintAddress(MINT_ADDRESS_BAD_URL)).rejects.toThrow(
      'Not a mint address response'
    )
  })

  it('surfaces the service error for an unknown username', async () => {
    await expect(fetchMintAddress(MINT_ADDRESS_UNKNOWN_URL)).rejects.toThrow(
      'Unknown user.'
    )
  })
})

describe('secret-free device mirrors', () => {
  it('fails locally instead of asking the mint for a note without k1', async () => {
    const fetchSpy = vi.fn(mint.fetch)
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)

    await expect(fetchNoteInfo(`${WITHDRAW_URL}?amount=21000`)).rejects.toThrow(
      /reconnect the vault/i
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fails locally instead of sending a mutation with an empty k1', async () => {
    const fetchSpy = vi.fn(mint.fetch)
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)

    await expect(meltNote(WITHDRAW_CALLBACK, '', 'lnbcmock')).rejects.toThrow(
      /reconnect the vault/i
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('mint -> rotate -> split -> merge -> melt', () => {
  it('carries one note through the full LUD-25 lifecycle', async () => {
    const payInfo = await fetchPayRequest(PAY_URL)
    expect(payInfo.withdrawLink).toBe(WITHDRAW_URL)

    const invoice = await requestInvoice(payInfo.callback, 21000)
    expect(invoice.verify).toBeDefined()
    expect((await fetchInvoiceVerification(invoice.verify!)).settled).toBe(
      false
    )

    mint.settleInvoice(idFromVerifyUrl(invoice.verify!))
    const verification = await fetchInvoiceVerification(invoice.verify!)
    expect(verification.settled).toBe(true)
    const preimage = verification.preimage!

    // claim: informational GET settles the note's authoritative value
    const noteUrl = buildNoteUrl(payInfo.withdrawLink!, preimage, 21000)
    const info = await fetchNoteInfo(noteUrl)
    expect(info.maxWithdrawable).toBe(21000)
    expect(info.k1).toBe(preimage)

    // Rotate once to obtain the freshly minted note's signed certificate.
    const rotated = await rotateNote(info.callback, preimage)
    expect(rotated.k1).not.toBe(preimage)
    expect(mint.isOutstanding(preimage)).toBe(false)
    expect(mint.isOutstanding(rotated.k1)).toBe(true)
    // Hash lookup deliberately does not reveal whether this identifier was
    // burned or never existed.
    await expect(fetchNoteInfo(noteUrl)).rejects.toBeInstanceOf(
      NoteUnknownError
    )

    // split: one k1, one piece + change (LUD-25 also allows many at once,
    // covered by the "one or many k1s" test below)
    const parts = await splitNote(info.callback, [rotated.k1], 6000)
    expect(mint.isOutstanding(rotated.k1)).toBe(false)
    expect(mint.isOutstanding(parts.k1)).toBe(true)
    expect(mint.isOutstanding(parts.change)).toBe(true)
    const partInfo = await fetchNoteInfo(
      buildNoteUrl(WITHDRAW_URL, parts.k1, 6000)
    )
    const changeInfo = await fetchNoteInfo(
      buildNoteUrl(WITHDRAW_URL, parts.change, 15000)
    )
    expect(partInfo.maxWithdrawable).toBe(6000)
    expect(changeInfo.maxWithdrawable).toBe(15000)

    // merge: back into one 21-sat note
    const merged = await mergeNotes(info.callback, [parts.k1, parts.change])
    expect(mint.isOutstanding(parts.k1)).toBe(false)
    expect(mint.isOutstanding(parts.change)).toBe(false)
    const mergedInfo = await fetchNoteInfo(
      buildNoteUrl(WITHDRAW_URL, merged.k1, 21000)
    )
    expect(mergedInfo.maxWithdrawable).toBe(21000)

    // melt: {"status":"OK"} only means the payment is in flight - the note
    // is neither burned nor spendable elsewhere until it settles
    const meltResult = await meltNote(info.callback, merged.k1, 'lnbcmockpay')
    expect(meltResult.verify).toBeDefined()
    expect(mint.isOutstanding(merged.k1)).toBe(true)
    await expect(rotateNote(info.callback, merged.k1)).rejects.toBeInstanceOf(
      PendingNoteError
    )

    mint.settleMelt(idFromVerifyUrl(meltResult.verify!))
    expect((await fetchInvoiceVerification(meltResult.verify!)).settled).toBe(
      true
    )
    expect(mint.isOutstanding(merged.k1)).toBe(false)
    await expect(
      fetchNoteInfo(buildNoteUrl(WITHDRAW_URL, merged.k1, 21000))
    ).rejects.toThrow(/unknown/i)
  })

  it('splits one or many k1s in a single request (LUD-25)', async () => {
    const a = randomHex(32)
    const b = randomHex(32)
    mint.seed(a, 10000)
    mint.seed(b, 5000)

    const parts = await splitNote(WITHDRAW_CALLBACK, [a, b], 9000)
    expect(mint.isOutstanding(a)).toBe(false)
    expect(mint.isOutstanding(b)).toBe(false)
    expect(
      (await fetchNoteInfo(buildNoteUrl(WITHDRAW_URL, parts.k1, 9000)))
        .maxWithdrawable
    ).toBe(9000)
    expect(
      (await fetchNoteInfo(buildNoteUrl(WITHDRAW_URL, parts.change, 6000)))
        .maxWithdrawable
    ).toBe(6000)
  })
})

describe('current LUD-25 mandatory comment binding', () => {
  it('mints a note keyed by the wallet secret, never by the payment preimage', async () => {
    const payInfo = await fetchPayRequest(PAY_COMMENT_URL)
    expect(canUseMintComment(payInfo)).toBe(true)

    // this is exactly what Mint.tsx's getInvoice does: generate the note's
    // real secret up front, disclose only its hash as `comment`
    const secret = generateNoteSecret('mock-mint.test')
    const invoice = await requestInvoice(
      payInfo.callback,
      21000,
      hashK1(secret)
    )
    expect(invoice.verify).toBeDefined()

    mint.settleInvoice(idFromVerifyUrl(invoice.verify!))
    const verification = await fetchInvoiceVerification(invoice.verify!)
    expect(verification.settled).toBe(true)
    const preimage = verification.preimage!

    // the note is outstanding under the wallet-chosen secret, and the
    // payment preimage the mint happens to disclose via verify is NOT a
    // valid k1 for it - safe to hand out anywhere, including via verify,
    // per LUD-25's Security considerations
    expect(mint.isOutstanding(secret)).toBe(true)
    expect(mint.isOutstanding(preimage)).toBe(false)

    const noteUrl = buildNoteUrl(payInfo.withdrawLink!, secret, 21000)
    const info = await fetchNoteInfo(noteUrl)
    expect(info.maxWithdrawable).toBe(21000)
    expect(info.k1).toBe(secret)
  })

  it('refuses a mint with no commentAllowed before requesting an invoice', async () => {
    const payInfo = await fetchPayRequest(PAY_URL)
    expect(canUseMintComment(payInfo)).toBe(false)
    expect(() => requireMintComment(payInfo)).toThrow(/commentAllowed: 64/)
  })
})

describe('pending-note recovery', () => {
  it('rejects every other op on a k1 mid-melt, then finalizes on settlement', async () => {
    const k1 = randomHex(32)
    mint.seed(k1, 10000)

    const melt = await meltNote(WITHDRAW_CALLBACK, k1, 'lnbcmockpay')

    // any other mutating op on the same k1 is rejected while it's pending -
    // per spec, regardless of which operation is attempted
    await expect(rotateNote(WITHDRAW_CALLBACK, k1)).rejects.toBeInstanceOf(
      PendingNoteError
    )
    await expect(
      splitNote(WITHDRAW_CALLBACK, [k1], 5000)
    ).rejects.toBeInstanceOf(PendingNoteError)

    // the informational GET is unaffected - only callback mutations are
    // blocked while pending
    expect(
      (await fetchNoteInfo(buildNoteUrl(WITHDRAW_URL, k1, 10000)))
        .maxWithdrawable
    ).toBe(10000)

    mint.settleMelt(idFromVerifyUrl(melt.verify!))
    await expect(
      fetchNoteInfo(buildNoteUrl(WITHDRAW_URL, k1, 10000))
    ).rejects.toThrow(/unknown/i)
  })

  it('restores the note to outstanding if the outgoing payment fails', async () => {
    const k1 = randomHex(32)
    mint.seed(k1, 5000)

    const melt = await meltNote(WITHDRAW_CALLBACK, k1, 'lnbcmockpay')
    mint.failMelt(idFromVerifyUrl(melt.verify!))

    // no longer pending - a normal op on it succeeds again, as if the melt
    // never happened
    const rotated = await rotateNote(WITHDRAW_CALLBACK, k1)
    expect(mint.isOutstanding(rotated.k1)).toBe(true)
  })
})

describe('spent vs. unknown note classification', () => {
  it('reports a never-issued k1 as unknown, not spent', async () => {
    const neverIssued = randomHex(32)
    await expect(
      fetchNoteInfo(buildNoteUrl(WITHDRAW_URL, neverIssued, 1000))
    ).rejects.toBeInstanceOf(NoteUnknownError)
    await expect(
      fetchNoteInfo(buildNoteUrl(WITHDRAW_URL, neverIssued, 1000))
    ).rejects.toThrow(/unknown/i)
  })

  it('does not distinguish a burned hash from an unknown one', async () => {
    const k1 = randomHex(32)
    mint.seed(k1, 1000)
    await rotateNote(WITHDRAW_CALLBACK, k1)
    await expect(
      fetchNoteInfo(buildNoteUrl(WITHDRAW_URL, k1, 1000))
    ).rejects.toBeInstanceOf(NoteUnknownError)
  })

  it('a mutating callback naming an unknown k1 is also classified, even from its generic wording', async () => {
    const neverIssued = randomHex(32)
    await expect(
      rotateNote(WITHDRAW_CALLBACK, neverIssued)
    ).rejects.toBeInstanceOf(NoteUnknownError)
  })
})

describe('a rejection carrying no reason says nothing about the note', () => {
  // classifyNoteError reads SERVICE's own words to decide a note's fate.
  // A reasonless {"status":"ERROR"} contains no such words, so it must
  // reach callers unclassified - if wording invented on this side for the
  // display string were classified instead, an ambiguous mutation would
  // read as "the burn landed" and the rescued secrets, the only copies of
  // the outputs, would be dropped as worthless
  const respondWith = (body: object): void => {
    vi.stubGlobal(
      'fetch',
      (async () =>
        ({
          json: async () => body
        }) as unknown as Response) as unknown as typeof fetch
    )
  }

  it('is not classified as spent or unknown', async () => {
    respondWith({status: 'ERROR'})
    const url = buildNoteUrl(WITHDRAW_URL, randomHex(32), 1000)
    const err = await fetchNoteInfo(url).catch(e => e)
    expect(err).toBeInstanceOf(ServiceError)
    expect(err).not.toBeInstanceOf(NoteUnknownError)
    expect(err).not.toBeInstanceOf(NoteSpentError)
    expect((err as ServiceError).reason).toBe('')
    // still says something a person can read
    expect((err as Error).message).not.toBe('')
  })

  it('leaves probeBurnedNote with no verdict rather than a wrong one', async () => {
    respondWith({status: 'ERROR'})
    const url = buildNoteUrl(WITHDRAW_URL, randomHex(32), 1000)
    expect(await probeBurnedNote(url)).toBe('unknown')
  })

  it('holds for an empty reason and a non-string one too', async () => {
    const url = buildNoteUrl(WITHDRAW_URL, randomHex(32), 1000)
    for (const body of [
      {status: 'ERROR', reason: ''},
      {status: 'ERROR', reason: null},
      {status: 'ERROR', reason: 42}
    ]) {
      respondWith(body)
      expect(await probeBurnedNote(url)).toBe('unknown')
    }
  })

  it('does not classify a mutating callback either', async () => {
    respondWith({status: 'ERROR'})
    const err = await rotateNote(WITHDRAW_CALLBACK, randomHex(32)).catch(e => e)
    expect(err).not.toBeInstanceOf(NoteUnknownError)
    expect(err).not.toBeInstanceOf(NoteSpentError)
  })

  it('still classifies a reason SERVICE actually gave', async () => {
    const url = buildNoteUrl(WITHDRAW_URL, randomHex(32), 1000)
    respondWith({status: 'ERROR', reason: 'Note already spent.'})
    await expect(fetchNoteInfo(url)).rejects.toBeInstanceOf(NoteSpentError)
    expect(await probeBurnedNote(url)).toBe('gone')

    respondWith({status: 'ERROR', reason: 'Unknown note.'})
    await expect(fetchNoteInfo(url)).rejects.toBeInstanceOf(NoteUnknownError)
    expect(await probeBurnedNote(url)).toBe('gone')
  })

  it('still maps the verbatim "pending" reason to PendingNoteError', async () => {
    respondWith({status: 'ERROR', reason: 'pending'})
    await expect(
      rotateNote(WITHDRAW_CALLBACK, randomHex(32))
    ).rejects.toBeInstanceOf(PendingNoteError)
  })

  it('never classifies a transport failure as a verdict on the note', async () => {
    vi.stubGlobal('fetch', (() => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch)
    const url = buildNoteUrl(WITHDRAW_URL, randomHex(32), 1000)
    expect(await probeBurnedNote(url)).toBe('unknown')
  })
})

describe('receiveNote surfaces a definitive spent/unknown report', () => {
  it('throws instead of storing a note whose hash is no longer outstanding', async () => {
    const k1 = randomHex(32)
    mint.seed(k1, 1000)
    await rotateNote(WITHDRAW_CALLBACK, k1) // burns k1

    const url = buildNoteUrl(WITHDRAW_URL, k1, 1000)
    await expect(receiveNote(toBech32Lnurl(url), [])).rejects.toBeInstanceOf(
      NoteUnknownError
    )
  })

  it('throws for a note the service never issued', async () => {
    const neverIssued = randomHex(32)
    const url = buildNoteUrl(WITHDRAW_URL, neverIssued, 1000)
    await expect(receiveNote(toBech32Lnurl(url), [])).rejects.toBeInstanceOf(
      NoteUnknownError
    )
  })

  it('still falls back to an unverified note when the service is unreachable', async () => {
    vi.stubGlobal('fetch', (() => {
      throw new Error('network down')
    }) as unknown as typeof fetch)
    const k1 = randomHex(32)
    const url = buildNoteUrl(WITHDRAW_URL, k1, 1000)
    const received = await receiveNote(toBech32Lnurl(url), [])
    expect(received.verified).toBe(false)
    expect(received.amount).toBe(1000)
  })
})

describe('service-response sanity checks', () => {
  it('sends a bearer mint output as its cp1 comment, and parses receipt fields', async () => {
    const h = 'ab'.repeat(32)
    let requested: URL | null = null
    vi.stubGlobal('fetch', (async (input: string | URL) => {
      requested = new URL(input.toString())
      return {
        json: async () => ({
          pr: 'lnbc1000n1mockinvoice',
          verify: `${BASE}/verify/receipt`,
          mintToHash: true,
          mint: {h: h.toUpperCase(), amount: 99000}
        })
      } as unknown as Response
    }) as typeof fetch)

    const result = await requestInvoice(PAY_CALLBACK, 100_000, h)
    expect(requested!.searchParams.get('comment')).toBe(
      encodeCp1(hexToBytes(bearerNoteIdOfHash(h)))
    )
    expect(requested!.searchParams.get('h')).toBeNull()
    expect(result.mintToHash).toBe(true)
    expect(result.mint).toEqual({h: bearerNoteIdOfHash(h), amountMsat: 99000})
  })

  it('requestInvoice rejects an invoice for a different amount than requested', async () => {
    // the mock's own invoices are amountless (lnbcmockN), which pass
    // through unchecked - this needs one with a decodable, wrong amount
    vi.stubGlobal('fetch', (async (input: string | URL) => {
      const url = new URL(input.toString())
      if (url.pathname === '/pay/cb') {
        return {
          json: async () => ({pr: 'lnbc21n1mockinvoice'})
        } as unknown as Response
      }
      return mint.fetch(input)
    }) as typeof fetch)
    // requested 100_000 msat; lnbc21n1... decodes to 210 * 100 = 2100
    await expect(requestInvoice(PAY_CALLBACK, 100_000)).rejects.toThrow(
      /not the 100000 requested/
    )
  })

  it('requestInvoice accepts the invoice when its amount matches', async () => {
    vi.stubGlobal('fetch', (async (input: string | URL) => {
      const url = new URL(input.toString())
      if (url.pathname === '/pay/cb') {
        // lnbc1000n1... decodes to 1000 * 100 = 100_000 msat
        return {
          json: async () => ({pr: 'lnbc1000n1mockinvoice'})
        } as unknown as Response
      }
      return mint.fetch(input)
    }) as typeof fetch)
    const result = await requestInvoice(PAY_CALLBACK, 100_000)
    expect(result.pr).toBe('lnbc1000n1mockinvoice')
  })

  it('fetchNoteInfo rejects nonsensical amounts', async () => {
    const k1 = randomHex(32)
    vi.stubGlobal('fetch', (async () => {
      return {
        json: async () => ({
          tag: 'withdrawRequest',
          callback: WITHDRAW_CALLBACK,
          minWithdrawable: 1000,
          maxWithdrawable: -5
        })
      } as unknown as Response
    }) as typeof fetch)
    await expect(
      fetchNoteInfo(buildNoteUrl(WITHDRAW_URL, k1, 1000))
    ).rejects.toThrow(/unexpected response/i)
  })
})

describe('hash-only settlement lookup', () => {
  it('keeps the same note while reading its authoritative value', async () => {
    const k1 = randomHex(32)
    mint.seed(k1, 8000)

    const settled = await settleNote(WITHDRAW_URL, k1, 8000, undefined)

    expect(settled.k1).toBe(k1)
    expect(settled.amountMsat).toBe(8000)
    expect(mint.isOutstanding(k1)).toBe(true)
  })
})

describe('ambiguous mutation failures', () => {
  it('a dropped rotate response carries the fresh secret, and the burn landed', async () => {
    const k1 = randomHex(32)
    mint.seed(k1, 8000)
    mint.dropCallbackResponses = true

    const err = await rotateNote(WITHDRAW_CALLBACK, k1).catch(e => e)
    expect(err).toBeInstanceOf(AmbiguousMutationError)
    const [newK1] = (err as AmbiguousMutationError).newSecrets
    expect(newK1).toMatch(/^[0-9a-f]{64}$/)

    // the request was fully processed mint-side despite the lost response:
    // the old secret is spent and the carried one is the live note
    expect(mint.isOutstanding(k1)).toBe(false)
    expect(mint.isOutstanding(newK1)).toBe(true)

    // the recovery probe reads exactly that back
    expect(await probeBurnedNote(buildNoteUrl(WITHDRAW_URL, k1, 8000))).toBe(
      'gone'
    )
    expect(await probeBurnedNote(buildNoteUrl(WITHDRAW_URL, newK1, 8000))).toBe(
      'live'
    )
  })

  it('a dropped split response carries both output secrets', async () => {
    const k1 = randomHex(32)
    mint.seed(k1, 9000)
    mint.dropCallbackResponses = true

    const err = await splitNote(WITHDRAW_CALLBACK, [k1], 4000).catch(e => e)
    expect(err).toBeInstanceOf(AmbiguousMutationError)
    const [partK1, changeK1] = (err as AmbiguousMutationError).newSecrets
    expect(mint.isOutstanding(k1)).toBe(false)
    expect(mint.isOutstanding(partK1)).toBe(true)
    expect(mint.isOutstanding(changeK1)).toBe(true)
  })

  it('a dropped merge response carries the merged secret', async () => {
    const [a, b] = [randomHex(32), randomHex(32)]
    mint.seed(a, 5000)
    mint.seed(b, 7000)
    mint.dropCallbackResponses = true

    const err = await mergeNotes(WITHDRAW_CALLBACK, [a, b]).catch(e => e)
    expect(err).toBeInstanceOf(AmbiguousMutationError)
    expect(mint.isOutstanding(a)).toBe(false)
    expect(mint.isOutstanding(b)).toBe(false)
    expect(
      mint.isOutstanding((err as AmbiguousMutationError).newSecrets[0])
    ).toBe(true)
  })

  it('a definitive rejection is not ambiguous and carries no secrets', async () => {
    const k1 = randomHex(32)
    mint.seed(k1, 5000)
    mint.rotateFails = true // a parsed status:ERROR, state untouched

    const err = await rotateNote(WITHDRAW_CALLBACK, k1).catch(e => e)
    expect(err).not.toBeInstanceOf(AmbiguousMintError)
    expect(mint.isOutstanding(k1)).toBe(true)
    expect(await probeBurnedNote(buildNoteUrl(WITHDRAW_URL, k1, 5000))).toBe(
      'live'
    )
  })

  it('an unreachable service leaves the probe unknown', async () => {
    const k1 = randomHex(32)
    mint.seed(k1, 5000)
    mint.dropCallbackResponses = true

    const err = await rotateNote(WITHDRAW_CALLBACK, k1).catch(e => e)
    expect(err).toBeInstanceOf(AmbiguousMutationError)

    // ...and then the whole service goes dark: the probe can't say either
    // way, so nothing may be discarded
    vi.stubGlobal('fetch', (() => {
      throw new TypeError('network down')
    }) as unknown as typeof fetch)
    expect(await probeBurnedNote(buildNoteUrl(WITHDRAW_URL, k1, 5000))).toBe(
      'unknown'
    )
  })
})
