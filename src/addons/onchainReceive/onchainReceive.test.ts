import {describe, expect, it} from 'vitest'
import {schnorr} from '@noble/curves/secp256k1.js'
import {Address} from '@scure/btc-signer'
import {createBase58check} from '@scure/base'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex} from '@noble/hashes/utils.js'
import {generateSeedPhrase} from '../../keys'
import {decodeCp1} from '../../lib/recoverableNotes'
import {deriveOnchainReceive} from './onchainReceive'

const base58check = createBase58check(sha256)

describe('deriveOnchainReceive', () => {
  it('derives a mainnet P2TR address and a matching WIF', () => {
    const seed = generateSeedPhrase()
    const result = deriveOnchainReceive(seed, 'mint.600.wtf', 0)
    expect(result).not.toBeNull()
    const {cp1, internalPubkeyHex, address, wif} = result!

    // cp1 encodes exactly the internal pubkey this address was built from -
    // the "same pubkeys for cp1" the address is derived from, round-tripped
    expect(bytesToHex(decodeCp1(cp1)!)).toBe(internalPubkeyHex)

    // mainnet Taproot (bc1p...)
    expect(address.startsWith('bc1p')).toBe(true)

    // the WIF's own schnorr pubkey is the TAPROOT OUTPUT key (the tweaked
    // key), not the bare internal key - decode the address itself (rather
    // than re-deriving via p2tr again) to get an independent check on what
    // the WIF actually unlocks
    const decodedWif = base58check.decode(wif)
    expect(decodedWif[0]).toBe(0x80)
    expect(decodedWif.length).toBe(34) // version + 32-byte key + compression flag
    const tweakedPrivateKey = decodedWif.slice(1, 33)
    const tweakedPubkeyFromWif = bytesToHex(
      schnorr.getPublicKey(tweakedPrivateKey)
    )

    // bech32m-decode the address's own witness program via
    // @scure/btc-signer's own decoder - the same one a real onchain wallet
    // would use, rather than re-deriving through this addon's own code a
    // second time
    const decodedAddress = Address().decode(address)
    expect(decodedAddress.type).toBe('tr')
    expect(bytesToHex((decodedAddress as {pubkey: Uint8Array}).pubkey)).toBe(
      tweakedPubkeyFromWif
    )
  })

  it('returns null for an invalid seed phrase', () => {
    expect(
      deriveOnchainReceive('not a seed phrase', 'mint.600.wtf', 0)
    ).toBeNull()
  })

  it('returns null for an empty domain', () => {
    const seed = generateSeedPhrase()
    expect(deriveOnchainReceive(seed, '', 0)).toBeNull()
  })

  it('returns null for a negative index', () => {
    const seed = generateSeedPhrase()
    expect(deriveOnchainReceive(seed, 'mint.600.wtf', -1)).toBeNull()
  })

  it('derives a different address per index', () => {
    const seed = generateSeedPhrase()
    const a = deriveOnchainReceive(seed, 'mint.600.wtf', 0)!
    const b = deriveOnchainReceive(seed, 'mint.600.wtf', 1)!
    expect(a.address).not.toBe(b.address)
    expect(a.cp1).not.toBe(b.cp1)
  })

  it('derives a different address per domain', () => {
    const seed = generateSeedPhrase()
    const a = deriveOnchainReceive(seed, 'mint.600.wtf', 0)!
    const b = deriveOnchainReceive(seed, 'other-mint.example', 0)!
    expect(a.address).not.toBe(b.address)
  })
})
