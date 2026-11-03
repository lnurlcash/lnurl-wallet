import {afterEach, describe, expect, it, vi} from 'vitest'
import {secp256k1, schnorr} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {
  requireBoundMintQuote,
  validateBoundMintReceipt,
  requestInvoice,
  requestInvoiceShort,
  fetchPayRequest
} from './mintRequest'
import {hashK1} from './signature'
import {bearerNoteIdOfHash, bearerNoteIdOfPreimage} from './spend'
import {encodeCp1, encodeCs1WithAmount} from './recoverableNotes'

afterEach(() => vi.unstubAllGlobals())

const K1 = 'a'.repeat(64)
const DOMAIN = 'mint.example'

// signed the same way LUD-13 signs its auth seed phrase - see
// signature.test.ts for the full rationale behind each step here
const signAsMint = (priv: Uint8Array, k1: string, amountMsat: number): string =>
  signAsMintForId(priv, bearerNoteIdOfPreimage(k1), amountMsat)

// a mint's cs1 certificate over "LNURLcash:<domain>:<amount_msat>:<hex(Q)>"
const signAsMintForId = (
  priv: Uint8Array,
  idHex: string,
  amountMsat: number
): string => {
  const message = utf8ToBytes(`LNURLcash:${DOMAIN}:${amountMsat}:${idHex}`)
  const digest = sha256(
    sha256(
      new Uint8Array([...utf8ToBytes('Lightning Signed Message:'), ...message])
    )
  )
  const libSig = secp256k1.sign(digest, priv, {
    format: 'recovered',
    prehash: false
  })
  return encodeCs1WithAmount(
    amountMsat,
    new Uint8Array([...libSig.subarray(1), libSig[0]!])
  )
}

describe('bound-mint receipt authentication', () => {
  it('authenticates a settled bound-mint receipt from h without revealing k1', () => {
    const priv = secp256k1.utils.randomSecretKey()
    const pubHex = bytesToHex(secp256k1.getPublicKey(priv, true))
    const amountMsat = 21000
    const h = hashK1(K1)
    const q = bearerNoteIdOfPreimage(K1)
    const sig = signAsMint(priv, K1, amountMsat)
    const quote = {
      pr: 'lnbc21n1bound',
      verify: 'https://mint.example/verify/1',
      disposable: true,
      mintToHash: true,
      mint: {h: q, amountMsat}
    }
    const verification = {
      settled: true,
      preimage: 'ff'.repeat(32),
      pr: quote.pr.toUpperCase(),
      mint: {h: q, amountMsat, signature: sig}
    }

    expect(requireBoundMintQuote(quote, h, amountMsat)).toEqual(quote.mint)
    expect(
      validateBoundMintReceipt(
        quote,
        verification,
        h,
        amountMsat,
        pubHex,
        quote.verify
      )
    ).toEqual({h: q, amountMsat, signature: sig})
    expect(() =>
      validateBoundMintReceipt(
        quote,
        {...verification, mint: {...verification.mint, h: 'bb'.repeat(32)}},
        h,
        amountMsat,
        pubHex,
        quote.verify
      )
    ).toThrow(/does not match/)
    // a certificate binds the mint's domain: another mint's receipt fails
    expect(() =>
      validateBoundMintReceipt(
        quote,
        verification,
        h,
        amountMsat,
        pubHex,
        'https://other.example'
      )
    ).toThrow(/invalid signature/)
  })

  it('accepts a bound-mint receipt for a key-path note, named by its cp1', () => {
    // as it would actually arrive: parseBoundMintCommitment (inside
    // requestInvoice/fetchInvoiceVerification, not called directly here)
    // already normalizes h to the note's hex(Q) before an InvoiceResult ever
    // reaches these functions
    const priv = secp256k1.utils.randomSecretKey()
    const pubHex = bytesToHex(secp256k1.getPublicKey(priv, true))
    const amountMsat = 21000
    const notePubkey = schnorr.utils.randomSecretKey()
    const pkXOnly = schnorr.getPublicKey(notePubkey)
    const pkHex = bytesToHex(pkXOnly)
    const cp1 = encodeCp1(pkXOnly) // the wire form a caller's own expectedH may use
    const sig = signAsMintForId(priv, pkHex, amountMsat)
    const quote = {
      pr: 'lnbc21n1bound',
      verify: 'https://mint.example/verify/1',
      disposable: true,
      mintToHash: true,
      mint: {h: pkHex, amountMsat}
    }
    const verification = {
      settled: true,
      preimage: null,
      pr: quote.pr,
      mint: {h: pkHex, amountMsat, signature: sig}
    }

    expect(requireBoundMintQuote(quote, cp1, amountMsat)).toEqual({
      h: pkHex,
      amountMsat
    })
    expect(
      validateBoundMintReceipt(
        quote,
        verification,
        cp1,
        amountMsat,
        pubHex,
        quote.verify
      )
    ).toEqual({h: pkHex, amountMsat, signature: sig})
  })
})

describe('requestInvoice - LUD-25 cp1 comment', () => {
  it('sends a cp1 pubkey as comment alone (no redundant h)', async () => {
    const notePubkey = schnorr.getPublicKey(schnorr.utils.randomSecretKey())
    const cp1 = encodeCp1(notePubkey)
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      expect(request.searchParams.get('comment')).toBe(cp1)
      expect(request.searchParams.get('h')).toBeNull()
      return {json: async () => ({pr: 'lnbc1p0examplebech32data'})} as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    await requestInvoice('https://mint.example.com/p/cb', 1000, cp1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("sends a bearer hash as its hashlock note's cp1", async () => {
    const hash = 'a'.repeat(64)
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      expect(request.searchParams.get('comment')).toBe(
        encodeCp1(hexToBytes(bearerNoteIdOfHash(hash)))
      )
      expect(request.searchParams.get('h')).toBeNull()
      return {json: async () => ({pr: 'lnbc1p0examplebech32data'})} as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    await requestInvoice('https://mint.example.com/p/cb', 1000, hash)
  })

  it('requestInvoiceShort sends a bearer hash as its 64-hex short form', async () => {
    const hash = 'a'.repeat(64)
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      expect(request.searchParams.get('comment')).toBe(hash)
      return {json: async () => ({pr: 'lnbc1p0examplebech32data'})} as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    await requestInvoiceShort('https://mint.example.com/p/cb', 1000, hash)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects an output hash that is neither hex32 nor a pubkey commitment', async () => {
    await expect(
      requestInvoice('https://mint.example.com/p/cb', 1000, 'not-valid')
    ).rejects.toThrow(/cp1 output key/)
  })
})

describe('requestInvoice - LUD-06 description hash', () => {
  // BOLT-11's own description_hash example, for 2_000_000_000 msat
  const PR =
    'lnbc20m1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqhp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqscc6gd6ql3jrc5yzme8v4ntcewwz5cnw92tz0pc8qcuufvq7khhr8wpald05e92xw006sq94mg8v2ndf4sefvf9sygkshp5zfem29trqq2yxxz7'
  const METADATA =
    'One piece of chocolate cake, one icecream cone, one pickle, one slice of swiss cheese, one slice of salami, one lollypop, one piece of cherry pie, one sausage, one cupcake, and one slice of watermelon'
  const callback = 'https://mint.example.com/p/cb'
  const answering = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({json: async () => ({pr: PR})}) as Response)
    )

  it('accepts an invoice committing to the payRequest metadata', async () => {
    answering()
    const result = await requestInvoice(
      {callback, metadata: METADATA},
      2_000_000_000
    )
    expect(result.pr).toBe(PR)
  })

  it('refuses one committing to anything else', async () => {
    answering()
    await expect(
      requestInvoice({callback, metadata: '[]'}, 2_000_000_000)
    ).rejects.toThrow(/does not commit to its payRequest's metadata/)
  })

  it('cannot check without the metadata', async () => {
    answering()
    expect((await requestInvoice(callback, 2_000_000_000)).pr).toBe(PR)
  })
})
