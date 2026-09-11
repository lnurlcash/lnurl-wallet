import {afterEach, describe, expect, it, vi} from 'vitest'
import {secp256k1, schnorr} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {
  requireBoundMintQuote,
  validateBoundMintReceipt,
  requestInvoice
} from './mintRequest'
import {hashK1} from './signature'
import {encodeCp1} from './recoverableNotes'

afterEach(() => vi.unstubAllGlobals())

const K1 = 'a'.repeat(64)

// signed the same way LUD-13 signs its auth seed phrase - see
// signature.test.ts for the full rationale behind each step here
const signAsMint = (
  priv: Uint8Array,
  k1: string,
  amountMsat: number
): string => {
  const k1Hash = bytesToHex(sha256(hexToBytes(k1)))
  const message = utf8ToBytes(`LNURLcash:${amountMsat}:${k1Hash}`)
  const digest = sha256(
    sha256(
      new Uint8Array([...utf8ToBytes('Lightning Signed Message:'), ...message])
    )
  )
  const libSig = secp256k1.sign(digest, priv, {
    format: 'recovered',
    prehash: false
  })
  return bytesToHex(new Uint8Array([...libSig.subarray(1), libSig[0]]))
}

describe('bound-mint receipt authentication', () => {
  it('authenticates a settled bound-mint receipt from h without revealing k1', () => {
    const priv = secp256k1.utils.randomSecretKey()
    const pubHex = bytesToHex(secp256k1.getPublicKey(priv, true))
    const amountMsat = 21000
    const h = hashK1(K1)
    const sig = signAsMint(priv, K1, amountMsat)
    const quote = {
      pr: 'lnbc21n1bound',
      verify: 'https://mint.example/verify/1',
      disposable: true,
      mintToHash: true,
      mint: {h, amountMsat}
    }
    const verification = {
      settled: true,
      preimage: 'ff'.repeat(32),
      pr: quote.pr.toUpperCase(),
      mint: {h, amountMsat, signature: sig}
    }

    expect(requireBoundMintQuote(quote, h, amountMsat)).toEqual(quote.mint)
    expect(
      validateBoundMintReceipt(quote, verification, h, amountMsat, pubHex)
    ).toEqual({h, amountMsat, signature: sig})
    expect(() =>
      validateBoundMintReceipt(
        quote,
        {...verification, mint: {...verification.mint, h: 'bb'.repeat(32)}},
        h,
        amountMsat,
        pubHex
      )
    ).toThrow(/does not match/)
  })

  // cs1's message is LNURLcash:<amount>:<hex(pk)> with the pubkey hex used
  // DIRECTLY (no hashing) - unlike signAsMint above, which is only valid
  // for a legacy h=sha256(secret) id
  const signAsMintForId = (
    priv: Uint8Array,
    idHex: string,
    amountMsat: number
  ): string => {
    const message = utf8ToBytes(`LNURLcash:${amountMsat}:${idHex}`)
    const digest = sha256(
      sha256(
        new Uint8Array([
          ...utf8ToBytes('Lightning Signed Message:'),
          ...message
        ])
      )
    )
    const libSig = secp256k1.sign(digest, priv, {
      format: 'recovered',
      prehash: false
    })
    return bytesToHex(new Uint8Array([...libSig.subarray(1), libSig[0]]))
  }

  it('accepts a cp1/cs1-encoded bound-mint receipt, normalized to plain hex', () => {
    // as it would actually arrive: parseBoundMintCommitment (inside
    // requestInvoice/fetchInvoiceVerification, not called directly here)
    // already normalizes h/sig to plain hex before an InvoiceResult ever
    // reaches these functions - a hand-built fixture must match that same
    // already-normalized shape, not the raw wire encoding
    const priv = secp256k1.utils.randomSecretKey()
    const pubHex = bytesToHex(secp256k1.getPublicKey(priv, true))
    const amountMsat = 21000
    const notePubkey = schnorr.utils.randomSecretKey()
    const pkXOnly = schnorr.getPublicKey(notePubkey)
    const pkHex = bytesToHex(pkXOnly)
    const cp1 = encodeCp1(pkXOnly) // the wire form a caller's own expectedH may use
    const sig = signAsMintForId(priv, pkHex, amountMsat) // pk hex signed directly, no hashing
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
      validateBoundMintReceipt(quote, verification, cp1, amountMsat, pubHex)
    ).toEqual({h: pkHex, amountMsat, signature: sig})
  })
})

describe('requestInvoice - LUD-25 Part 2 cp1 comment', () => {
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

  it('still sends both comment and h for a legacy hash', async () => {
    const hash = 'a'.repeat(64)
    const fetchMock = vi.fn(async (input: string | URL) => {
      const request = new URL(input.toString())
      expect(request.searchParams.get('comment')).toBe(hash)
      expect(request.searchParams.get('h')).toBe(hash)
      return {json: async () => ({pr: 'lnbc1p0examplebech32data'})} as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    await requestInvoice('https://mint.example.com/p/cb', 1000, hash)
  })

  it('rejects an output hash that is neither hex32 nor cp1', async () => {
    await expect(
      requestInvoice('https://mint.example.com/p/cb', 1000, 'not-valid')
    ).rejects.toThrow(/cp1 pubkey/)
  })
})
