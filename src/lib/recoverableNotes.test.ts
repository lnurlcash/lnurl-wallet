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
  deriveNoteSecretKey,
  NOTE_PURPOSE_WALLET,
  NOTE_PURPOSE_CHANGE,
  NOTE_PURPOSE_LIGHTNING_ADDRESS
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

describe('cs1WithAmount (LUD-25 "encode amount in offline sig")', () => {
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
  // lnurl_mint.derivation.derive_pubkey(P, chain_code, PURPOSE_WALLET,
  // index) directly for 3 real secp256k1 x-only pubkeys (from
  // PrivateKey(bytes([s])*32) for s in 1,2,3) x 5 (chain_code, index) pairs
  // - these are NOT self-generated fixtures, they're the actual mint's own
  // output, so a match here means this wallet's derivation is byte-for-byte
  // interoperable with the real service, not just internally consistent
  const VECTORS: {P: string; chainCode: string; index: number; pk: string}[] = [
    {
      P: '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f',
      chainCode:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      index: 0,
      pk: 'a32cea9bfa3c2fd8ba9185ec306bd4373471d0a6915858645acfada3ff814072'
    },
    {
      P: '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f',
      chainCode:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      index: 1,
      pk: 'ab96f0a837891286735fa5bf9fe59d20d7f00bc23b75292936d788b15415ba31'
    },
    {
      P: '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f',
      chainCode:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      index: 255,
      pk: 'a10547072442eec51530bdf29ec8f1267289d461cfd39b94121c742a6b11cd51'
    },
    {
      P: '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f',
      chainCode:
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      index: 4294967295,
      pk: '65e05e361b39d1fc2e448540742212db8829ed6aa002054f080c23f44d6b2342'
    },
    {
      P: '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f',
      chainCode:
        'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'.slice(
          0,
          64
        ),
      index: 42,
      pk: '1c7b1789c0b7962ba484281a24bc57651eb9d966227f38e87812b64e8b0cd644'
    },
    {
      P: '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766',
      chainCode:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      index: 0,
      pk: '993002d8bd83d44f1a303c79a650e3f91f36d13cce0781f6d7425adddf6196ce'
    },
    {
      P: '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766',
      chainCode:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      index: 1,
      pk: 'c9b1b2a277e4e02a82eef127d1c35b0fc02c1cb81c263c8c283dbfb3ef92abd4'
    },
    {
      P: '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766',
      chainCode:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      index: 255,
      pk: 'aa9686d3acb53914d16882d9e3262e1711af10b21a30095007e5d2fff5fccc41'
    },
    {
      P: '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766',
      chainCode:
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      index: 4294967295,
      pk: 'cdf00ce40118096bfb3183d9bf8a59e4bdf0d845853d9ebb1feeeadd152314e5'
    },
    {
      P: '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766',
      chainCode:
        'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'.slice(
          0,
          64
        ),
      index: 42,
      pk: '85bbe7df864b020fbc6f495a91caffe820436cadef69f68a58a152ccd3a77d5d'
    },
    {
      P: '531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337',
      chainCode:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      index: 0,
      pk: 'e869c464a2362e6c46b4ea44dd34a9242e7e87cd5833ee31a2d194dccfba9ae5'
    },
    {
      P: '531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337',
      chainCode:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      index: 1,
      pk: 'c8b6163974ff6036c900fbaa994f9c4eaf719782046b13bb2903df329ea9196f'
    },
    {
      P: '531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337',
      chainCode:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      index: 255,
      pk: '5950166e0e6179b4544be0d310b2bcc41e22724d41d4ee1c10bb5709c9751c6d'
    },
    {
      P: '531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337',
      chainCode:
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      index: 4294967295,
      pk: '551c18ff38c5481aa0d86cea67b08342e32bacecf22709a9afd888eb41821cc3'
    },
    {
      P: '531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337',
      chainCode:
        'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'.slice(
          0,
          64
        ),
      index: 42,
      pk: '28df0c1bae37bf16ac4dfb6019be0a152d3bdb6a979a494236fd530a1d47e74c'
    }
  ]

  it("matches the mint's output for every cross-validated vector", () => {
    for (const v of VECTORS) {
      const got = bytesToHex(
        deriveNotePubkey(
          hexToBytes(v.P),
          hexToBytes(v.chainCode),
          NOTE_PURPOSE_WALLET,
          v.index
        )
      )
      expect(got).toBe(v.pk)
    }
  })

  it('a different purpose changes the derived pubkey at the same (P, chainCode, index)', () => {
    const P = hexToBytes(
      '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f'
    )
    const chainCode = hexToBytes(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    )
    const keys = new Set(
      [
        NOTE_PURPOSE_WALLET,
        NOTE_PURPOSE_CHANGE,
        NOTE_PURPOSE_LIGHTNING_ADDRESS
      ].map(purpose => bytesToHex(deriveNotePubkey(P, chainCode, purpose, 0)))
    )
    expect(keys.size).toBe(3)
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
      for (const purpose of [
        NOTE_PURPOSE_WALLET,
        NOTE_PURPOSE_CHANGE,
        NOTE_PURPOSE_LIGHTNING_ADDRESS
      ]) {
        for (const index of [0, 1, 42, 255, 4294967295]) {
          const secretKey = deriveNoteSecretKey(
            branchPrivateKey,
            chainCode,
            purpose,
            index
          )
          const pubkeyFromSecret = schnorr.getPublicKey(secretKey)
          const pubkeyWatchOnly = deriveNotePubkey(
            branchPubkeyXOnly,
            chainCode,
            purpose,
            index
          )
          expect(bytesToHex(pubkeyFromSecret)).toBe(bytesToHex(pubkeyWatchOnly))
        }
      }
    }
  })

  it('is deterministic', () => {
    const branchPrivateKey = schnorr.utils.randomSecretKey()
    const chainCode = hexToBytes('9'.repeat(64))
    const a = deriveNoteSecretKey(
      branchPrivateKey,
      chainCode,
      NOTE_PURPOSE_WALLET,
      7
    )
    const b = deriveNoteSecretKey(
      branchPrivateKey,
      chainCode,
      NOTE_PURPOSE_WALLET,
      7
    )
    expect(bytesToHex(a)).toBe(bytesToHex(b))
  })

  it('produces a different secret for a different index', () => {
    const branchPrivateKey = schnorr.utils.randomSecretKey()
    const chainCode = hexToBytes('9'.repeat(64))
    const a = deriveNoteSecretKey(
      branchPrivateKey,
      chainCode,
      NOTE_PURPOSE_WALLET,
      0
    )
    const b = deriveNoteSecretKey(
      branchPrivateKey,
      chainCode,
      NOTE_PURPOSE_WALLET,
      1
    )
    expect(bytesToHex(a)).not.toBe(bytesToHex(b))
  })
})
