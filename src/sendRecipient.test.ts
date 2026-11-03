import {secp256k1} from '@noble/curves/secp256k1.js'
import {describe, expect, it} from 'vitest'
import {encodeCp1, encodeCx1} from './lnurlcash'
import {parseRecipient} from './sendRecipient'

const HOST = 'mint.example.test'
const KEY = new Uint8Array(32).fill(7)
const CHAIN = new Uint8Array(32).fill(9)

describe('parseRecipient', () => {
  it('reads a cp1 as a single pubkey', () => {
    const cp1 = encodeCp1(KEY)
    expect(parseRecipient(` ${cp1.toUpperCase()} `, HOST)).toEqual({
      kind: 'cp1',
      cp1
    })
  })

  it('no longer accepts a cx1 branch', () => {
    const pubkey = new Uint8Array([
      2,
      ...secp256k1.getPublicKey(new Uint8Array(32).fill(3)).slice(1)
    ])
    expect(
      parseRecipient(encodeCx1({chainCode: CHAIN, pubkey}), HOST)
    ).toBeNull()
  })

  it('reads a username, bare or at this same mint', () => {
    expect(parseRecipient('Alice', HOST)).toEqual({
      kind: 'username',
      username: 'alice'
    })
    expect(parseRecipient(`alice@${HOST}`, HOST)).toEqual({
      kind: 'username',
      username: 'alice'
    })
  })

  it('refuses an address at another mint, or junk', () => {
    expect(parseRecipient('alice@other.example.test', HOST)).toBeNull()
    expect(parseRecipient('', HOST)).toBeNull()
    expect(parseRecipient('not a name', HOST)).toBeNull()
  })
})
