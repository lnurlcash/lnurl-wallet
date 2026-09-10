import {describe, expect, it} from 'vitest'
import {secp256k1} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {requireBoundMintQuote, validateBoundMintReceipt} from './mintRequest'
import {hashK1} from './signature'

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
})
