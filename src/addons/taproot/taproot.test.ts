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
  scriptPathProofs,
  verifyScriptPath,
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

describe('script-path proofs (what a ct1 redemption reveals)', () => {
  const leafFor = (id: 'pk' | 'cltv' | 'hashlock', pubkeyHex: string) =>
    scriptTemplateById(id)!.build({
      pubkeyHex,
      pubkey2Hex: '',
      hashHex: 'ab'.repeat(32),
      locktime: 1_800_000_000
    })

  it('a genuine proof commits to Q, for every leaf of a multi-leaf tree', () => {
    const internal = generateKeypair()
    const fallback = generateKeypair()
    const leaves = [
      leafFor('cltv', fallback.pubkeyHex),
      leafFor('pk', fallback.pubkeyHex),
      leafFor('hashlock', fallback.pubkeyHex)
    ]
    const {tweakedPubkeyHex} = tweakPubkey(internal.pubkeyHex, leaves)
    const proofs = scriptPathProofs(hexToBytes(internal.pubkeyHex), leaves)

    expect(proofs).toHaveLength(3)
    for (const proof of proofs) {
      expect(verifyScriptPath(tweakedPubkeyHex, proof)).toBe(true)
    }
    // proofs come back in the SAME order as the leaves they were asked for
    proofs.forEach((proof, i) => {
      expect(bytesToHex(proof.script)).toBe(bytesToHex(leaves[i]!))
    })
  })

  it('works for the single-leaf case, where the merkle root is just that leaf', () => {
    const internal = generateKeypair()
    const leaves = [leafFor('cltv', generateKeypair().pubkeyHex)]
    const {tweakedPubkeyHex} = tweakPubkey(internal.pubkeyHex, leaves)
    const [proof] = scriptPathProofs(hexToBytes(internal.pubkeyHex), leaves)
    // no siblings: control block is exactly version byte + internal key
    expect(proof!.controlBlock).toHaveLength(33)
    expect(verifyScriptPath(tweakedPubkeyHex, proof!)).toBe(true)
  })

  it('a key-path-only output has nothing to reveal', () => {
    const internal = generateKeypair()
    expect(scriptPathProofs(hexToBytes(internal.pubkeyHex), [])).toEqual([])
  })

  // The soundness argument the whole ct1 design rests on: a mint given
  // nothing but Q can trust a revealed leaf, because nobody can fabricate
  // one for a key they did not build forward from a real tree.
  describe('forgery is rejected', () => {
    const setup = () => {
      const internal = generateKeypair()
      const owner = generateKeypair()
      const leaves = [leafFor('cltv', owner.pubkeyHex)]
      const {tweakedPubkeyHex} = tweakPubkey(internal.pubkeyHex, leaves)
      const [proof] = scriptPathProofs(hexToBytes(internal.pubkeyHex), leaves)
      return {internal, owner, tweakedPubkeyHex, proof: proof!}
    }

    it("an attacker's own script under the victim's control block", () => {
      const {tweakedPubkeyHex, proof} = setup()
      // swap in a script that pays the attacker, keep the real control block
      const attackerScript = leafFor('pk', generateKeypair().pubkeyHex)
      expect(
        verifyScriptPath(tweakedPubkeyHex, {
          script: attackerScript,
          controlBlock: proof.controlBlock
        })
      ).toBe(false)
    })

    it("an attacker's fully self-built tree, presented against the victim's Q", () => {
      const {tweakedPubkeyHex} = setup()
      const attackerInternal = generateKeypair()
      const attackerLeaves = [leafFor('pk', attackerInternal.pubkeyHex)]
      const [forged] = scriptPathProofs(
        hexToBytes(attackerInternal.pubkeyHex),
        attackerLeaves
      )
      // internally consistent - it commits to the ATTACKER's own key, not Q
      expect(
        verifyScriptPath(
          tweakPubkey(attackerInternal.pubkeyHex, attackerLeaves)
            .tweakedPubkeyHex,
          forged!
        )
      ).toBe(true)
      // ...but it does not commit to the victim's
      expect(verifyScriptPath(tweakedPubkeyHex, forged!)).toBe(false)
    })

    it('tampering with any byte of the control block', () => {
      const {tweakedPubkeyHex, proof} = setup()
      for (let i = 0; i < proof.controlBlock.length; i++) {
        const tampered = Uint8Array.from(proof.controlBlock)
        tampered[i] = tampered[i]! ^ 0x01
        expect(
          verifyScriptPath(tweakedPubkeyHex, {
            script: proof.script,
            controlBlock: tampered
          })
        ).toBe(false)
      }
    })

    it('a valid proof against a different output key', () => {
      const {proof} = setup()
      expect(verifyScriptPath(generateKeypair().pubkeyHex, proof)).toBe(false)
    })

    it('malformed control blocks are rejected, never thrown', () => {
      const {tweakedPubkeyHex, proof} = setup()
      for (const controlBlock of [
        new Uint8Array(0),
        new Uint8Array(32),
        new Uint8Array(34),
        new Uint8Array(65)
      ]) {
        expect(
          verifyScriptPath(tweakedPubkeyHex, {
            script: proof.script,
            controlBlock
          })
        ).toBe(false)
      }
      expect(verifyScriptPath('not hex', proof)).toBe(false)
    })
  })
})
