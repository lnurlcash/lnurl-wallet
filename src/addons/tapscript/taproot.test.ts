import {describe, expect, it} from 'vitest'
import {schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {
  generateKeypair,
  tweakPubkey,
  tweakSecretKey,
  signWithTweakedKey
} from './taproot'

describe('tweakPubkey / tweakSecretKey', () => {
  it('round-trips: tweaked secret key derives the same tweaked pubkey (key-path only)', () => {
    for (let i = 0; i < 5; i++) {
      const {secretKeyHex, pubkeyHex} = generateKeypair()
      const {tweakedPubkeyHex} = tweakPubkey(pubkeyHex, [])
      const tweakedSecretHex = tweakSecretKey(secretKeyHex, [])
      const derivedPubkeyHex = bytesToHex(
        schnorr.getPublicKey(hexToBytes(tweakedSecretHex))
      )
      expect(derivedPubkeyHex).toBe(tweakedPubkeyHex)
    }
  })

  it('round-trips with a non-empty script list (script-path)', () => {
    const {secretKeyHex, pubkeyHex} = generateKeypair()
    const scripts = ['OP_CHECKSIG', 'a toy script']
    const {tweakedPubkeyHex} = tweakPubkey(pubkeyHex, scripts)
    const tweakedSecretHex = tweakSecretKey(secretKeyHex, scripts)
    const derivedPubkeyHex = bytesToHex(
      schnorr.getPublicKey(hexToBytes(tweakedSecretHex))
    )
    expect(derivedPubkeyHex).toBe(tweakedPubkeyHex)
  })

  it('key-path and script-path tweaks differ for the same key', () => {
    const {pubkeyHex} = generateKeypair()
    const keyPath = tweakPubkey(pubkeyHex, [])
    const scriptPath = tweakPubkey(pubkeyHex, ['OP_CHECKSIG'])
    expect(keyPath.tweakedPubkeyHex).not.toBe(scriptPath.tweakedPubkeyHex)
  })

  it('rejects malformed hex', () => {
    expect(() => tweakPubkey('not-hex', [])).toThrow()
    expect(() => tweakPubkey('ab', [])).toThrow() // too short
  })
})

describe('signWithTweakedKey', () => {
  it('produces a signature that verifies against the tweaked pubkey', () => {
    const {secretKeyHex} = generateKeypair()
    const result = signWithTweakedKey(secretKeyHex, [], 'hello tapscript')
    expect(result.verified).toBe(true)
    expect(result.signatureHex).toHaveLength(128)
  })

  it('verifies for a script-path tweak too', () => {
    const {secretKeyHex} = generateKeypair()
    const result = signWithTweakedKey(secretKeyHex, ['OP_CHECKSIG'], 'hello')
    expect(result.verified).toBe(true)
  })
})
