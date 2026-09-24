import {describe, expect, it} from 'vitest'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {schnorr} from '@noble/curves/secp256k1.js'
import {bech32, bech32m} from '@scure/base'
import {
  encodeCp1,
  decodeCp1,
  isCp1,
  isPubkeyCommitment,
  encodeCw1,
  decodeCw1,
  isCw1,
  deriveScriptPathCommitment,
  outputKeyOfScriptPath,
  outputKeyOfCw1,
  encodeCk1,
  decodeCk1,
  isCk1,
  encodeCs1WithAmount,
  decodeCs1WithAmount,
  isCs1WithAmount,
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

  it('a cp1 is a pubkey commitment; a ck1 spending it is not', () => {
    const bytes = hexToBytes('ab'.repeat(32))
    expect(isPubkeyCommitment(encodeCp1(bytes))).toBe(true)
    expect(
      isPubkeyCommitment(encodeCk1(bytes, hexToBytes('cd'.repeat(64))))
    ).toBe(false)
  })

  it('round-trips a cw1 (locktime, sequence, script, control block, witness)', () => {
    const script = hexToBytes('51'.repeat(40))
    const controlBlock = hexToBytes('c0' + 'ab'.repeat(32) + 'cd'.repeat(32))
    const witness = [hexToBytes('ef'.repeat(64)), hexToBytes('11')]
    const cw1 = {
      locktime: 1_800_000_000,
      sequence: 0xfffffffe,
      script,
      controlBlock,
      witness
    }
    const encoded = encodeCw1(cw1)
    expect(encoded.startsWith('cw1')).toBe(true)
    expect(isCw1(encoded)).toBe(true)
    expect(decodeCw1(encoded)).toEqual(cw1)
  })

  it('round-trips a cw1 with an empty witness stack', () => {
    // a pure timelock leaf needs nothing pushed to satisfy it
    const cw1 = {
      locktime: 1_800_000_000,
      sequence: 0xfffffffe,
      script: hexToBytes('b2' + '75'),
      controlBlock: hexToBytes('c1' + '00'.repeat(32)),
      witness: []
    }
    expect(decodeCw1(encodeCw1(cw1))).toEqual(cw1)
  })

  it('pins the exact wire layout: u32 locktime, u32 sequence, then u16-prefixed parts', () => {
    // byte-exact, so the layout a signer and a SERVICE must agree on cannot
    // drift silently - an independent implementation can be checked against
    // this vector
    const encoded = encodeCw1({
      locktime: 0x01020304,
      sequence: 0x0a0b0c0d,
      script: new Uint8Array([0xaa, 0xbb]),
      controlBlock: new Uint8Array([0xcc]),
      witness: [new Uint8Array([0xdd, 0xee, 0xff])]
    })
    const payload = bech32m.fromWords(
      bech32m.decode(encoded as `${string}1${string}`, false).words
    )
    expect(bytesToHex(payload)).toBe(
      '01020304' + // locktime
        '0a0b0c0d' + // sequence
        '0002aabb' + // script
        '0001cc' + // control block
        '0003ddeeff' // witness[0]
    )
  })

  it('carries the extremes of both u32 fields', () => {
    for (const [locktime, sequence] of [
      [0, 0],
      [0xffffffff, 0xffffffff],
      [500_000_000, 1 << 22]
    ] as const) {
      const cw1 = {
        locktime,
        sequence,
        script: new Uint8Array([1]),
        controlBlock: new Uint8Array([2]),
        witness: []
      }
      expect(decodeCw1(encodeCw1(cw1))).toEqual(cw1)
    }
  })

  it('refuses to encode a locktime or sequence that is not a u32', () => {
    const base = {
      script: new Uint8Array([1]),
      controlBlock: new Uint8Array([2]),
      witness: []
    }
    for (const bad of [-1, 0x100000000, 1.5, NaN]) {
      expect(() => encodeCw1({...base, locktime: bad, sequence: 0})).toThrow()
      expect(() => encodeCw1({...base, locktime: 0, sequence: bad})).toThrow()
    }
  })

  it('rejects a malformed cw1 rather than partially reading it', () => {
    const wrap = (bytes: number[]) =>
      bech32m.encode('cw', bech32m.toWords(new Uint8Array(bytes)), false)
    const header = [0, 0, 0, 0, 0, 0, 0, 0]
    // a length prefix claiming more bytes than actually follow
    expect(decodeCw1(wrap([...header, 0x00, 0x20, 0x01, 0x02]))).toBeNull()
    // only one part present - a control block is mandatory
    expect(decodeCw1(wrap([...header, 0x00, 0x01, 0xff]))).toBeNull()
    // shorter than the fixed header
    expect(decodeCw1(wrap([0, 0, 0]))).toBeNull()
    // a trailing byte too short to be a length prefix
    expect(
      decodeCw1(wrap([...header, 0, 1, 0xaa, 0, 1, 0xbb, 0x00]))
    ).toBeNull()
    expect(decodeCw1('cw1notbech32')).toBeNull()
    expect(decodeCw1(encodeCp1(hexToBytes('ab'.repeat(32))))).toBeNull()
  })

  it("round-trips a cs1 (65 bytes) - past bech32/BIP-173's 90-char limit", () => {
    const bytes = hexToBytes('cd'.repeat(65))
    const cs1 = encodeCs1WithAmount(1000, bytes)
    expect(cs1.length).toBeGreaterThan(90)
    expect(decodeCs1WithAmount(cs1)?.signature).toEqual(bytes)
    expect(isCs1WithAmount(cs1)).toBe(true)
  })

  it('round-trips a ck1 (96 bytes: 32-byte pk || 64-byte Schnorr sig)', () => {
    const pubkeyXOnly = hexToBytes('ab'.repeat(32))
    const signature = hexToBytes('cd'.repeat(64))
    const ck1 = encodeCk1(pubkeyXOnly, signature)
    expect(ck1.length).toBeGreaterThan(90)
    expect(decodeCk1(ck1)).toEqual({pubkeyXOnly, signature})
    expect(isCk1(ck1)).toBe(true)
  })

  it('rejects a ck1 payload of any length but 96 bytes', () => {
    const short = bech32m.encode(
      'ck',
      bech32m.toWords(hexToBytes('ef'.repeat(65))),
      false
    )
    expect(decodeCk1(short)).toBeNull()
    expect(isCk1(short)).toBe(false)
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
    expect(decodeCs1WithAmount(cp1)).toBeNull()
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
    expect(() =>
      encodeCk1(hexToBytes('ab'.repeat(32)), hexToBytes('cd'.repeat(63)))
    ).toThrow()
    expect(() =>
      encodeCx1(hexToBytes('ab'.repeat(32)), hexToBytes('cd'.repeat(31)))
    ).toThrow()
  })
})

describe('deriveScriptPathCommitment / outputKeyOfCw1', () => {
  // Real, spec-shaped vectors - generated once with @scure/btc-signer's own
  // p2tr() tree builder (a construction wholly independent of anything in
  // recoverableNotes.ts) and pinned here as literal bytes, rather than
  // built live in this test file: this package (@lnurlcash/kit) ships
  // without @scure/btc-signer as a dependency (a full transaction-building
  // library, see this file's own top comment) and its own isolated test
  // run (release-kit.yml, npm ci scoped to src/lib alone) has no access to
  // it even as a devDependency of the wallet monorepo it's vendored in.
  // Regenerate by temporarily dumping p2tr()'s own output from
  // addons/taproot/taproot.test.ts (which does have @scure/btc-signer) if
  // these primitives ever change - see its git history for the exact
  // one-off script used to produce the values below.
  const internalKey = hexToBytes(
    '4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa'
  )
  // Script.encode([<32 bytes of 0xaa/0xbb>, 'CHECKSIG']): 0x20 (push32) ||
  // pubkey || 0xac (OP_CHECKSIG)
  const leafA = hexToBytes(`20${'aa'.repeat(32)}ac`)
  const leafB = hexToBytes(`20${'bb'.repeat(32)}ac`)
  // depth-0 (leafA alone): version/parity byte || internal key, no siblings
  const singleLeafControlBlock = hexToBytes(
    'c0' + '4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa'
  )
  const singleLeafOutputKeyHex =
    'd37208c49a038f693bc0b362b5a7f804938bfea0b3381cfb88fb69340bb92495'
  // depth-1 (leafA + leafB, two equal-weight leaves): version/parity byte
  // || internal key || one 32-byte sibling (leafB's own TapLeaf hash)
  const multiLeafControlBlock = hexToBytes(
    'c1' +
      '4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa' +
      '5c95326c4af903b97f2c63f4809184af217e7f5421041ba5c25d17212c7fb36c'
  )
  const multiLeafOutputKeyHex =
    'cef5e074133b91e081f2771a28d13e46837fea794df3ff52b6e61bc46f912202'

  it('derives exactly the same Q a real p2tr() tree was built with (single leaf)', () => {
    const commitment = deriveScriptPathCommitment(leafA, singleLeafControlBlock)
    expect(commitment).not.toBeNull()
    expect(bytesToHex(commitment!.outputKey)).toBe(singleLeafOutputKeyHex)
    expect(outputKeyOfScriptPath(leafA, singleLeafControlBlock)).toEqual(
      commitment!.outputKey
    )
  })

  it('walks a real multi-leaf merkle path (not just a depth-0 tree)', () => {
    // version/parity byte + 32-byte internal key + one 32-byte sibling
    expect(multiLeafControlBlock.length).toBe(1 + 32 + 32)
    const commitment = deriveScriptPathCommitment(leafA, multiLeafControlBlock)
    expect(bytesToHex(commitment!.outputKey)).toBe(multiLeafOutputKeyHex)
  })

  it('round-trips through a real cw1 end to end', () => {
    const cw1 = encodeCw1({
      locktime: 1_800_000_000,
      sequence: 0xfffffffe,
      script: leafA,
      controlBlock: singleLeafControlBlock,
      witness: [hexToBytes('cc'.repeat(64))]
    })
    expect(outputKeyOfCw1(cw1)).toBe(singleLeafOutputKeyHex)
  })

  it('unused leaf B never leaks its own script from the multi-leaf proof', () => {
    // only leafB's TapLeaf hash (already folded into the control block's
    // sibling) is ever seen - the script itself stays private, exactly as
    // BIP341 intends for an unrevealed leaf
    expect(bytesToHex(multiLeafControlBlock)).not.toContain(bytesToHex(leafB))
  })

  it('never throws on a malformed control block, returns null instead', () => {
    expect(deriveScriptPathCommitment(leafA, new Uint8Array(0))).toBeNull()
    expect(deriveScriptPathCommitment(leafA, new Uint8Array(10))).toBeNull()
    expect(
      outputKeyOfScriptPath(leafA, hexToBytes('c0' + 'ab'.repeat(31)))
    ).toBeNull()
    expect(outputKeyOfCw1('cw1nonsense')).toBeNull()
    expect(outputKeyOfCw1(encodeCp1(hexToBytes('ab'.repeat(32))))).toBeNull()
  })
})

describe('cs1WithAmount (LUD-25 Part 2 "encode amount in offline sig")', () => {
  const bytes = hexToBytes('cd'.repeat(65))

  it('round-trips signature and amount together', () => {
    const cs1 = encodeCs1WithAmount(1000, bytes)
    // matches 25.md's own Encoding-section example verbatim
    expect(cs1.startsWith('cs10n1')).toBe(true)
    expect(decodeCs1WithAmount(cs1)).toEqual({
      amountMsat: 1000,
      signature: bytes
    })
    expect(isCs1WithAmount(cs1)).toBe(true)
  })

  // generated via lnurl-mint/.venv/bin/python3, calling
  // lnurl_mint.bech32m.encode_cs1(amount, bytes([0xcd]*65)) directly - these
  // are the actual mint's own output (not just self-generated fixtures), so
  // a match here means this wallet's encoding is byte-for-byte
  // interoperable with the real service, same cross-check discipline as
  // deriveNotePubkey's own vectors above
  it("matches lnurl-mint's own bech32m.encode_cs1 output byte-for-byte", () => {
    const VECTORS: {amountMsat: number; cs1: string}[] = [
      {
        amountMsat: 1000,
        cs1: 'cs10n1ehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwd9r35pa'
      },
      {
        amountMsat: 100_000,
        cs1: 'cs1u1ehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdjawcqs'
      },
      {
        amountMsat: 1_000_000_000,
        cs1: 'cs10m1ehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdry3c6p'
      },
      {
        amountMsat: 1,
        cs1: 'cs10p1ehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdsu3he6'
      },
      {
        amountMsat: 25_000,
        cs1: 'cs250n1ehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdlzgn44'
      },
      {
        amountMsat: 100_000_000_000,
        cs1: 'cs11ehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdgmtc8q'
      },
      {
        amountMsat: 0,
        cs1: 'cs01ehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwd2ptuwn'
      },
      {
        amountMsat: 21_000,
        cs1: 'cs210n1ehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwd87mvyq'
      }
    ]
    for (const v of VECTORS) {
      expect(encodeCs1WithAmount(v.amountMsat, bytes)).toBe(v.cs1)
      expect(decodeCs1WithAmount(v.cs1)).toEqual({
        amountMsat: v.amountMsat,
        signature: bytes
      })
    }
  })

  it('rejects the wrong prefix, garbage, or a truncated amount suffix', () => {
    expect(
      decodeCs1WithAmount(encodeCp1(hexToBytes('ab'.repeat(32))))
    ).toBeNull()
    expect(decodeCs1WithAmount('not bech32m at all')).toBeNull()
    expect(decodeCs1WithAmount('cs1garbage')).toBeNull()
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
