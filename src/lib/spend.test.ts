import {describe, expect, it} from 'vitest'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {schnorr} from '@noble/curves/secp256k1.js'
import {
  bearerNote,
  bearerNoteIdOfHash,
  bearerNoteIdOfPreimage,
  keyPathSighash,
  scriptPathSighash,
  spendDomainOf,
  spendPrevout,
  spendSigMsg
} from './spend'

// 25.md, Test vector 3: Key-path spend (ck1)
const Q3 = hexToBytes(
  'aad3a0e36c083eb0d2d92ec0860977dc46d10c952f31830e6443b1faa1997634'
)

describe('LUD-25 canonical spend transaction', () => {
  it('matches test vector 3 field by field', () => {
    expect(bytesToHex(spendPrevout('mint.example'))).toBe(
      'd5ac2de3423432e37713bcb133cfea7938ff6b2f8ea4174dfcec84bea705d6b2'
    )
    const msg = spendSigMsg({
      outputKey: Q3,
      domain: 'mint.example',
      locktime: 0,
      sequence: 0xffffffff
    })
    expect(msg.length).toBe(174)
    expect(bytesToHex(msg)).toBe(
      '00020000000000000030b1cba17526057f8343b434d78c6e2daf43429c3a38e236d22cf5f5b78b9024af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfcddd2d8771df7fb07a13626816ef020a553559bdcd01734d1259655430f6b91faad95131bc0b799c0b1af477fb14fcf26a6a9f76079e48bf090acb7e8367bfd0e3e7077fd2f66d689e0cee6a7cf5b37bf2dca7c979af356d0a31cbc5c85605c7d0000000000'
    )
    expect(bytesToHex(keyPathSighash(Q3, 'mint.example'))).toBe(
      'b8933a42090297a1f80d7f1fc0023ec1aa2ab36a7df332520f0dacf07f617943'
    )
  })

  it('reproduces test vector 3 signature with a zero aux_rand', () => {
    const sk = hexToBytes(
      '944a9631dbda27cf989e27df8be7317a5a9dfb517a6b71358d175f58dd2dc99f'
    )
    const sig = schnorr.sign(
      keyPathSighash(Q3, 'mint.example'),
      sk,
      new Uint8Array(32)
    )
    expect(bytesToHex(sig)).toBe(
      '83bbe1fe044d3d15cd1c18b484168c37f921864a9f85e9251f8457b576abd66b211b70b97fb3d63856ae271e4b3e3cf95da8e8b7769fefc309d8dc4989120e8e'
    )
  })

  it('binds the domain, case-insensitively', () => {
    expect(keyPathSighash(Q3, 'Mint.Example')).toEqual(
      keyPathSighash(Q3, 'mint.example')
    )
    expect(keyPathSighash(Q3, 'other.example')).not.toEqual(
      keyPathSighash(Q3, 'mint.example')
    )
  })

  it('commits a script path to its leaf and time claim', () => {
    const leaf = new Uint8Array([0x51])
    const a = scriptPathSighash(Q3, 'mint.example', leaf, 0, 0xfffffffe)
    expect(
      scriptPathSighash(Q3, 'mint.example', leaf, 1, 0xfffffffe)
    ).not.toEqual(a)
    expect(
      scriptPathSighash(
        Q3,
        'mint.example',
        new Uint8Array([0x52]),
        0,
        0xfffffffe
      )
    ).not.toEqual(a)
  })

  it('reads the domain off any note or mint URL', () => {
    expect(spendDomainOf('lnurlw://Mint.Example:8443/w?k1=ab')).toBe(
      'mint.example'
    )
    expect(spendDomainOf('https://mint.example/w')).toBe('mint.example')
    expect(spendDomainOf('mint.example')).toBe('mint.example')
  })
})

// 25.md, Test vector 5: Bearer note
describe('LUD-25 bearer note', () => {
  const preimage =
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
  const h = '630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd'

  it('matches test vector 5', () => {
    const note = bearerNote(hexToBytes(h))
    expect(bytesToHex(note.leaf)).toBe(`a820${h}87`)
    expect(bytesToHex(note.outputKey)).toBe(
      'd18b619687343df2fc7a47e1daf25260b909bb563fb4b4b11e59e2bd64880982'
    )
    expect(bytesToHex(note.controlBlock)).toBe(
      'c050929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0'
    )
    expect(bearerNoteIdOfHash(h)).toBe(bytesToHex(note.outputKey))
    expect(bearerNoteIdOfPreimage(preimage)).toBe(bytesToHex(note.outputKey))
  })
})
