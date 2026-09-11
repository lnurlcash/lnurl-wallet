import {describe, expect, it} from 'vitest'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {schnorr} from '@noble/curves/secp256k1.js'
import {bech32} from '@scure/base'
import {
  encodeCp1,
  decodeCp1,
  isCp1,
  encodeCk1,
  decodeCk1,
  isCk1,
  encodeCs1,
  decodeCs1,
  isCs1,
  encodeCx1,
  decodeCx1,
  isCx1,
  deriveNotePubkey,
  deriveNoteSecretKey
} from './recoverableNotes'

describe('bech32m codec', () => {
  it('round-trips a cp1 (32 bytes)', () => {
    const bytes = hexToBytes('ab'.repeat(32))
    const encoded = encodeCp1(bytes)
    expect(encoded.startsWith('cp1')).toBe(true)
    expect(decodeCp1(encoded)).toEqual(bytes)
    expect(isCp1(encoded)).toBe(true)
  })

  it("round-trips a ck1/cs1 (65 bytes) - past bech32/BIP-173's 90-char limit", () => {
    const bytes = hexToBytes('cd'.repeat(65))
    const ck1 = encodeCk1(bytes)
    const cs1 = encodeCs1(bytes)
    expect(ck1.length).toBeGreaterThan(90)
    expect(decodeCk1(ck1)).toEqual(bytes)
    expect(decodeCs1(cs1)).toEqual(bytes)
    expect(isCk1(ck1)).toBe(true)
    expect(isCs1(cs1)).toBe(true)
  })

  it('round-trips a cx1 (64 bytes: pubkey || chain code)', () => {
    const pubkeyXOnly = hexToBytes('11'.repeat(32))
    const chainCode = hexToBytes('22'.repeat(32))
    const encoded = encodeCx1(pubkeyXOnly, chainCode)
    expect(isCx1(encoded)).toBe(true)
    const decoded = decodeCx1(encoded)
    expect(decoded?.pubkeyXOnly).toEqual(pubkeyXOnly)
    expect(decoded?.chainCode).toEqual(chainCode)
  })

  it('rejects the wrong prefix for a given decoder', () => {
    const cp1 = encodeCp1(hexToBytes('ab'.repeat(32)))
    expect(decodeCk1(cp1)).toBeNull()
    expect(decodeCs1(cp1)).toBeNull()
    expect(decodeCx1(cp1)).toBeNull()
    expect(isCk1(cp1)).toBe(false)
  })

  it('rejects malformed/garbage input without throwing', () => {
    expect(decodeCp1('not bech32m at all')).toBeNull()
    expect(decodeCp1('cp1invalidchecksum')).toBeNull()
    expect(decodeCp1('')).toBeNull()
  })

  it('rejects a legacy classic-bech32 (BIP-173) string as bech32m', () => {
    // same HRP, but bech32 (checksum const 1) not bech32m (0x2bc830a3) -
    // must not cross-decode
    const classic = bech32.encode(
      'cp',
      bech32.toWords(hexToBytes('ab'.repeat(32))),
      false
    )
    expect(decodeCp1(classic)).toBeNull()
  })

  it('throws when encoding the wrong payload length', () => {
    expect(() => encodeCp1(hexToBytes('ab'.repeat(31)))).toThrow()
    expect(() => encodeCk1(hexToBytes('ab'.repeat(64)))).toThrow()
    expect(() =>
      encodeCx1(hexToBytes('ab'.repeat(32)), hexToBytes('cd'.repeat(31)))
    ).toThrow()
  })
})

describe("deriveNotePubkey - cross-validated against lnurl-mint's own derivation.py", () => {
  // generated via: lnurl-mint/.venv/bin/python3, calling
  // lnurl_mint.derivation.derive_pubkey(P, chain_code, index) directly for
  // 3 real secp256k1 x-only pubkeys (from PrivateKey(bytes([s])*32) for
  // s in 1,2,3) x 5 (chain_code, index) pairs - these are NOT self-
  // generated fixtures, they're the actual mint's own output, so a match
  // here means this wallet's derivation is byte-for-byte interoperable
  // with the real service, not just internally consistent
  const VECTORS: {P: string; chainCode: string; index: number; pk: string}[] = [
    {
      P: '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f',
      chainCode:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      index: 0,
      pk: '4d8fb1b73a4780cd71a2e75e355aa5ebcba52be3ed1b98e0a6d236052198d50f'
    },
    {
      P: '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f',
      chainCode:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      index: 1,
      pk: '0bfed7d10dcbf66a4d66d2a23b96f42451c5247cfc57abefee09247a5f393599'
    },
    {
      P: '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f',
      chainCode:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      index: 255,
      pk: '1bdeb2476a36a8ce6a1586a9053f7094d23fa08b79b52b2c9b2592c81ff3d470'
    },
    {
      P: '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f',
      chainCode:
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      index: 4294967295,
      pk: 'a2dabf6666197bbeed46108e36fca9788b7ad12add655e54b03aa5213e4c052b'
    },
    {
      P: '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f',
      chainCode:
        'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'.slice(
          0,
          64
        ),
      index: 42,
      pk: '5201197658d719e2031303faa3e487ff731aea235d91f9e5b5f78d652d395d2e'
    },
    {
      P: '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766',
      chainCode:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      index: 0,
      pk: '8789101ce4c81b2fd4ce755244bde884b52801e41784f46a22a8086e8034a7d0'
    },
    {
      P: '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766',
      chainCode:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      index: 1,
      pk: 'c194417d8c5e5db1e292f3545eb3e9b900b3ea9880f9603c8bfba7e125a333ff'
    },
    {
      P: '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766',
      chainCode:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      index: 255,
      pk: '942f0b6512dfd384cd2f4f18c0b6e850caa9bd46e9f704afe76b27658f659e99'
    },
    {
      P: '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766',
      chainCode:
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      index: 4294967295,
      pk: 'f49c6e1e3b56ba0111c2a06aceb1a68612e540927d322a20f36335875df3ec59'
    },
    {
      P: '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766',
      chainCode:
        'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'.slice(
          0,
          64
        ),
      index: 42,
      pk: '0aa26357fc467e42cf5e3b964dbef9965cbcd91d2d5bf47b8e2bf89128dbc4bc'
    },
    {
      P: '531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337',
      chainCode:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      index: 0,
      pk: 'ac497f69c1f2782bb7d508a839d8457d6ec928c5955027ca104c7a38f5dcb873'
    },
    {
      P: '531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337',
      chainCode:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      index: 1,
      pk: '1c012788f539d4a92677933a032ba36b581ade3cc7b518e79ef506748a77e878'
    },
    {
      P: '531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337',
      chainCode:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      index: 255,
      pk: '5e9c9c751cef23d2f6d84ba92fa5c5fd6ca1fe5c6c4debb142fa1743de36f75d'
    },
    {
      P: '531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337',
      chainCode:
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      index: 4294967295,
      pk: '912f2878042de6b79d77cf08374d2e1e2970f1b9e85bd85656b228b2986ba889'
    },
    {
      P: '531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337',
      chainCode:
        'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'.slice(
          0,
          64
        ),
      index: 42,
      pk: '35556c902d940c7e2a7370ee65e19af8e841563b23b590f5868eb3d2752fda22'
    }
  ]

  it("matches the mint's output for every cross-validated vector", () => {
    for (const v of VECTORS) {
      const got = bytesToHex(
        deriveNotePubkey(hexToBytes(v.P), hexToBytes(v.chainCode), v.index)
      )
      expect(got).toBe(v.pk)
    }
  })
})

describe('deriveNoteSecretKey', () => {
  it('produces a secret whose own public key matches deriveNotePubkey (BIP-340 parity handled correctly)', () => {
    for (let s = 1; s <= 5; s++) {
      const branchPrivateKey = hexToBytes(
        s.toString(16).padStart(2, '0').repeat(32).slice(0, 64)
      )
      const branchPubkeyXOnly = schnorr.getPublicKey(branchPrivateKey)
      const chainCode = hexToBytes('7'.repeat(64))
      for (const index of [0, 1, 42, 255, 4294967295]) {
        const secretKey = deriveNoteSecretKey(
          branchPrivateKey,
          chainCode,
          index
        )
        const pubkeyFromSecret = schnorr.getPublicKey(secretKey)
        const pubkeyWatchOnly = deriveNotePubkey(
          branchPubkeyXOnly,
          chainCode,
          index
        )
        expect(bytesToHex(pubkeyFromSecret)).toBe(bytesToHex(pubkeyWatchOnly))
      }
    }
  })

  it('is deterministic', () => {
    const branchPrivateKey = schnorr.utils.randomSecretKey()
    const chainCode = hexToBytes('9'.repeat(64))
    const a = deriveNoteSecretKey(branchPrivateKey, chainCode, 7)
    const b = deriveNoteSecretKey(branchPrivateKey, chainCode, 7)
    expect(bytesToHex(a)).toBe(bytesToHex(b))
  })

  it('produces a different secret for a different index', () => {
    const branchPrivateKey = schnorr.utils.randomSecretKey()
    const chainCode = hexToBytes('9'.repeat(64))
    const a = deriveNoteSecretKey(branchPrivateKey, chainCode, 0)
    const b = deriveNoteSecretKey(branchPrivateKey, chainCode, 1)
    expect(bytesToHex(a)).not.toBe(bytesToHex(b))
  })
})
