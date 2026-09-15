import {describe, expect, it} from 'vitest'
import {schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {Script} from '@scure/btc-signer/script.js'
import {
  generateKeypair,
  tweakPubkey,
  tweakSecretKey,
  signWithTweakedKey,
  compileLeaf,
  scriptTemplateById,
  SCRIPT_TEMPLATES
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

  it('round-trips with a real tapscript leaf (script-path)', () => {
    const {secretKeyHex, pubkeyHex} = generateKeypair()
    const leaf = scriptTemplateById('pk')!.build({
      pubkeyHex,
      pubkey2Hex: '',
      hashHex: '',
      locktime: 0
    })
    const {tweakedPubkeyHex} = tweakPubkey(pubkeyHex, [leaf])
    const tweakedSecretHex = tweakSecretKey(secretKeyHex, [leaf])
    const derivedPubkeyHex = bytesToHex(
      schnorr.getPublicKey(hexToBytes(tweakedSecretHex))
    )
    expect(derivedPubkeyHex).toBe(tweakedPubkeyHex)
  })

  it('empty vs non-empty leaf list produces an empty vs non-empty merkle root', () => {
    const {pubkeyHex} = generateKeypair()
    const leaf = Script.encode(['OP_1'])
    expect(tweakPubkey(pubkeyHex, []).merkleRootHex).toBe('')
    expect(tweakPubkey(pubkeyHex, [leaf]).merkleRootHex).toHaveLength(64)
  })

  it('key-path and script-path tweaks differ for the same key', () => {
    const {pubkeyHex} = generateKeypair()
    const leaf = Script.encode([hexToBytes(pubkeyHex), 'CHECKSIG'])
    const keyPath = tweakPubkey(pubkeyHex, [])
    const scriptPath = tweakPubkey(pubkeyHex, [leaf])
    expect(keyPath.tweakedPubkeyHex).not.toBe(scriptPath.tweakedPubkeyHex)
  })

  it('multiple leaves fold into one real BIP341 merkle root, order-independent per leaf identity', () => {
    const {pubkeyHex: a} = generateKeypair()
    const {pubkeyHex: b} = generateKeypair()
    const leafA = Script.encode([hexToBytes(a), 'CHECKSIG'])
    const leafB = Script.encode([hexToBytes(b), 'CHECKSIG'])
    const {pubkeyHex: internal} = generateKeypair()
    const forward = tweakPubkey(internal, [leafA, leafB])
    const backward = tweakPubkey(internal, [leafB, leafA])
    // p2tr's own weighted-list tree builder is order-independent for two
    // equal-weight leaves - same merkle root regardless of push order
    expect(forward.merkleRootHex).toBe(backward.merkleRootHex)
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
    const {secretKeyHex, pubkeyHex} = generateKeypair()
    const leaf = Script.encode([hexToBytes(pubkeyHex), 'CHECKSIG'])
    const result = signWithTweakedKey(secretKeyHex, [leaf], 'hello')
    expect(result.verified).toBe(true)
  })
})

describe('script templates', () => {
  it('every template compiles to a real, decodable Tapscript program', () => {
    const {pubkeyHex} = generateKeypair()
    const {pubkeyHex: pubkey2Hex} = generateKeypair()
    const hashHex = '00'.repeat(32)
    for (const template of SCRIPT_TEMPLATES) {
      const compiled = compileLeaf(template.id, {
        pubkeyHex,
        pubkey2Hex,
        hashHex,
        locktime: 144
      })
      expect(compiled).not.toBeNull()
      expect(compiled!.scriptHex.length).toBeGreaterThan(0)
      expect(compiled!.leafHashHex).toHaveLength(64)
      // decodable via the exact inverse coder - opcodesOf's own contract
      expect(() => Script.decode(hexToBytes(compiled!.scriptHex))).not.toThrow()
    }
  })

  it('pk template opcodes read back as "<pubkey> OP_CHECKSIG"', () => {
    const {pubkeyHex} = generateKeypair()
    const compiled = compileLeaf('pk', {
      pubkeyHex,
      pubkey2Hex: '',
      hashHex: '',
      locktime: 0
    })
    expect(compiled!.opcodes).toBe(`${pubkeyHex} OP_CHECKSIG`)
  })

  it('multisig2 template uses CHECKSIGADD, never legacy CHECKMULTISIG', () => {
    const {pubkeyHex: a} = generateKeypair()
    const {pubkeyHex: b} = generateKeypair()
    const compiled = compileLeaf('multisig2', {
      pubkeyHex: a,
      pubkey2Hex: b,
      hashHex: '',
      locktime: 0
    })
    expect(compiled!.opcodes).toContain('OP_CHECKSIGADD')
    expect(compiled!.opcodes).not.toContain('CHECKMULTISIG')
    // OP_2 is a single-byte small-int push - Script.decode gives it back as
    // the plain number 2, not the OP_2 mnemonic (see opcodesOf's own
    // comment in taproot.ts), so the disassembly ends "...2 OP_NUMEQUAL"
    expect(compiled!.opcodes.endsWith('2 OP_NUMEQUAL')).toBe(true)
  })

  it('two different template ids for the same params compile to different leaf hashes', () => {
    const {pubkeyHex} = generateKeypair()
    const params = {pubkeyHex, pubkey2Hex: '', hashHex: '', locktime: 100}
    const pk = compileLeaf('pk', params)!
    const cltv = compileLeaf('cltv', params)!
    expect(pk.leafHashHex).not.toBe(cltv.leafHashHex)
  })

  it('returns null (never throws) for an unknown template id or malformed params', () => {
    expect(
      compileLeaf('nonsense', {
        pubkeyHex: '',
        pubkey2Hex: '',
        hashHex: '',
        locktime: 0
      })
    ).toBeNull()
    expect(
      compileLeaf('pk', {
        pubkeyHex: 'not-hex',
        pubkey2Hex: '',
        hashHex: '',
        locktime: 0
      })
    ).toBeNull()
  })
})
