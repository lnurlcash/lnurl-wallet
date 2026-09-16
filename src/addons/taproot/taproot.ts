// BIP341-style Taproot pubkey tweaking (@scure/btc-signer/utils.js) plus
// real Tapscript leaves (@scure/btc-signer/script.js's opcode-mnemonic
// Script coder and payment.js's p2tr tree builder) - a "play around"
// sandbox, not wired into this wallet's own note-signing anywhere. All key
// material lives in this addon's own page-local state (never persisted,
// gone on reload - see AddonRun.tsx/Renderer.tsx's 'run' mode), never
// cashSecrets.ts or the wallet's real seed. permissions: [] in manifest.ts
// is load-bearing, not decorative: this addon declares zero verbs, so it
// has no way to touch a real note, mint, or address regardless of what a
// holder pastes into it.
//
// Statically imported (not lazy, unlike raffle/pdf.ts's pdf-lib/qrcode) -
// this module is small and every exported function here must stay
// SYNCHRONOUS: a helper returning a Promise only gets awaited by the addon
// renderer when it's a verb's own arg (see Renderer.tsx's runVerb), never
// when it's the direct value of a plain Text/Show binding or a `set`
// action - a lazy import here would silently break the live Text displays
// this addon's UI relies on.
import {
  randomPrivateKeyBytes,
  pubSchnorr,
  tapTweak,
  taprootTweakPrivKey,
  taprootTweakPubkey
} from '@scure/btc-signer/utils.js'
import {p2tr, tapLeafHash, type P2TR_TREE} from '@scure/btc-signer/payment.js'
import {Script, ScriptNum} from '@scure/btc-signer/script.js'
import {schnorr} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'

const parseHex = (
  hex: string,
  expectedBytes: number,
  label: string
): Uint8Array => {
  const trimmed = hex.trim().toLowerCase()
  if (!/^[0-9a-f]*$/.test(trimmed) || trimmed.length !== expectedBytes * 2) {
    throw new Error(`${label} must be ${expectedBytes * 2} hex characters.`)
  }
  return hexToBytes(trimmed)
}

// ---- Script templates (real Bitcoin Script opcodes, BIP342 tapscript
// rules) - what a holder picks from instead of typing free-text placeholder
// "scripts" that were never real Script programs at all. Each build()
// compiles straight through @scure/btc-signer/script.js's own opcode-
// mnemonic Script coder (the exact coder real transaction-signing code in
// this library uses), so a compiled leaf here is byte-for-byte what a
// wallet or node would produce/accept, not an approximation.
export type ScriptTemplateId = 'pk' | 'csv' | 'cltv' | 'hashlock' | 'multisig2'

export type ScriptTemplateParams = {
  pubkeyHex: string
  pubkey2Hex: string
  hashHex: string
  locktime: number
}

export type ScriptTemplate = {
  id: ScriptTemplateId
  name: string
  // includes the literal opcode sequence in prose, deliberately - the
  // manifest's per-row display shows the SAME sequence compiled from the
  // holder's own inputs (see compileLeaf/opcodesOf), so this description is
  // checkable against real output rather than taken on faith
  description: string
  build: (params: ScriptTemplateParams) => Uint8Array
}

// tapscript (BIP342) disables OP_CHECKMULTISIG(VERIFY) outright - the
// multisig2 template below uses OP_CHECKSIGADD, the idiom BIP342 actually
// introduced to replace it, not a legacy construction that would simply
// fail to validate on-chain.
export const SCRIPT_TEMPLATES: readonly ScriptTemplate[] = [
  {
    id: 'pk',
    name: 'Pay-to-pubkey',
    description: '<pubkey> OP_CHECKSIG - spendable with a single signature.',
    build: ({pubkeyHex}) =>
      Script.encode([parseHex(pubkeyHex, 32, 'Pubkey'), 'CHECKSIG'])
  },
  {
    id: 'csv',
    name: 'Relative timelock (CSV)',
    description:
      '<sequence> OP_CHECKSEQUENCEVERIFY OP_DROP <pubkey> OP_CHECKSIG - spendable only once `sequence` blocks (BIP68 units) have passed since this output confirmed.',
    build: ({pubkeyHex, locktime}) =>
      Script.encode([
        ScriptNum().encode(BigInt(Math.max(0, Math.trunc(locktime)))),
        'CHECKSEQUENCEVERIFY',
        'DROP',
        parseHex(pubkeyHex, 32, 'Pubkey'),
        'CHECKSIG'
      ])
  },
  {
    id: 'cltv',
    name: 'Absolute timelock (CLTV)',
    description:
      '<locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <pubkey> OP_CHECKSIG - spendable only once the chain reaches block height (or time) `locktime`.',
    build: ({pubkeyHex, locktime}) =>
      Script.encode([
        ScriptNum().encode(BigInt(Math.max(0, Math.trunc(locktime)))),
        'CHECKLOCKTIMEVERIFY',
        'DROP',
        parseHex(pubkeyHex, 32, 'Pubkey'),
        'CHECKSIG'
      ])
  },
  {
    id: 'hashlock',
    name: 'Hashlock (SHA256)',
    description:
      'OP_SHA256 <hash> OP_EQUALVERIFY <pubkey> OP_CHECKSIG - spendable by whoever can produce the sha256 preimage of `hash` AND sign with `pubkey` (the shape an HTLC leaf takes).',
    build: ({pubkeyHex, hashHex}) =>
      Script.encode([
        'SHA256',
        parseHex(hashHex, 32, 'Hash'),
        'EQUALVERIFY',
        parseHex(pubkeyHex, 32, 'Pubkey'),
        'CHECKSIG'
      ])
  },
  {
    id: 'multisig2',
    name: '2-of-2 multisig (CHECKSIGADD)',
    description:
      '<pubkeyA> OP_CHECKSIG <pubkeyB> OP_CHECKSIGADD OP_2 OP_NUMEQUAL - tapscript’s own multisig idiom (BIP342 disables legacy OP_CHECKMULTISIG) - spendable only with signatures from BOTH keys.',
    build: ({pubkeyHex, pubkey2Hex}) =>
      Script.encode([
        parseHex(pubkeyHex, 32, 'Pubkey A'),
        'CHECKSIG',
        parseHex(pubkey2Hex, 32, 'Pubkey B'),
        'CHECKSIGADD',
        'OP_2',
        'NUMEQUAL'
      ])
  }
] as const

export const scriptTemplateById = (id: string): ScriptTemplate | undefined =>
  SCRIPT_TEMPLATES.find(t => t.id === id)

// human-readable opcode mnemonics for a compiled script - Script.decode is
// the exact inverse of Script.encode above, so this is what the bytes
// really contain, not a hand-maintained description that could drift from
// it. A single-byte small-int push (OP_0..OP_16, e.g. multisig2's OP_2)
// decodes to a plain JS number - shown as decimal, same as Bitcoin Core's
// own script disassembly. A multi-byte numeric push (e.g. csv/cltv's
// locktime, once it needs more than one byte) decodes as raw bytes instead,
// same as any other data push - both cases hex-show data, everything else
// keeps its OP_ mnemonic.
const opcodesOf = (script: Uint8Array): string =>
  Script.decode(script)
    .map(op =>
      op instanceof Uint8Array
        ? bytesToHex(op)
        : typeof op === 'number'
          ? String(op)
          : `OP_${op}`
    )
    .join(' ')

export type CompiledLeaf = {
  scriptHex: string
  opcodes: string
  leafHashHex: string
}

// compiles one script-tree row's (template, params) into the real leaf a
// p2tr() tree below actually uses - the addon's live-typing counterpart to
// merkleRootAndLeaves. Returns null (never throws) on an unknown template
// id or incomplete/malformed params, same "not an error, just not ready
// yet" contract as tweakPreview in manifest.ts, since this runs on every
// keystroke while a holder is still typing a pubkey/hash/locktime.
export const compileLeaf = (
  templateId: string,
  params: ScriptTemplateParams
): CompiledLeaf | null => {
  const template = scriptTemplateById(templateId)
  if (!template) return null
  try {
    const script = template.build(params)
    return {
      scriptHex: bytesToHex(script),
      opcodes: opcodesOf(script),
      leafHashHex: bytesToHex(tapLeafHash(script))
    }
  } catch {
    return null
  }
}

export type TweakResult = {
  tweakedPubkeyHex: string
  tweakScalarHex: string
  parity: 'even' | 'odd'
  merkleRootHex: string
}

// folds compiled leaf scripts into a REAL BIP341 script tree via
// @scure/btc-signer/payment.js's own p2tr() - the same tree-building code
// path (weighted-list -> binary tree -> per-branch TapBranch tagged hashes)
// a real wallet would use, not a hand-rolled or approximated merkle root.
// allowUnknownOutputs=true because these leaves are holder-authored
// Tapscript, not one of p2tr()'s own recognized descriptor shapes
// (tr_ns/tr_ms) - see checkTaprootScript in @scure/btc-signer/payment.js.
// Empty leaf list = key-path-only, merkle root omitted entirely per BIP341
// (not a zero-filled commitment).
const merkleRootFor = (
  internalPubkey: Uint8Array,
  leafScripts: Uint8Array[]
): Uint8Array => {
  if (leafScripts.length === 0) return new Uint8Array(0)
  const tree = leafScripts.map(script => ({script}))
  const out = p2tr(internalPubkey, tree, undefined, true) as P2TR_TREE
  return out.tapMerkleRoot
}

// pubkeyHex: 32-byte x-only hex (the BIP340/Taproot "internal key" P).
// leafScripts: compiled Tapscript leaves (see compileLeaf), already-encoded
// bytes rather than template ids - this function only tweaks a key, it
// doesn't know or care how a script leaf was authored. Throws on bad hex or
// if the tweak scalar is >= the curve order (BIP341's own reject-don't-
// reduce contract - taprootTweakPubkey/tapTweak both already enforce this).
export const tweakPubkey = (
  pubkeyHex: string,
  leafScripts: Uint8Array[]
): TweakResult => {
  const pubkey = parseHex(pubkeyHex, 32, 'Pubkey')
  const merkleRoot = merkleRootFor(pubkey, leafScripts)
  const tweakScalar = tapTweak(pubkey, merkleRoot)
  const [tweakedPubkey, parity] = taprootTweakPubkey(pubkey, merkleRoot)
  return {
    tweakedPubkeyHex: bytesToHex(tweakedPubkey),
    tweakScalarHex: tweakScalar.toString(16).padStart(64, '0'),
    parity: parity === 0 ? 'even' : 'odd',
    merkleRootHex: bytesToHex(merkleRoot)
  }
}

export const tweakSecretKey = (
  secretKeyHex: string,
  leafScripts: Uint8Array[]
): string => {
  const secretKey = parseHex(secretKeyHex, 32, 'Secret key')
  const merkleRoot = merkleRootFor(pubSchnorr(secretKey), leafScripts)
  return bytesToHex(taprootTweakPrivKey(secretKey, merkleRoot))
}

// generates a fresh random keypair entirely client-side - ephemeral, same
// pattern as nostrTools.generateNostrKeypair / seedGenerator's own seed
// generation. Never touches this wallet's real seed or note secrets.
export const generateKeypair = (): {
  secretKeyHex: string
  pubkeyHex: string
} => {
  const secretKey = randomPrivateKeyBytes()
  return {
    secretKeyHex: bytesToHex(secretKey),
    pubkeyHex: bytesToHex(pubSchnorr(secretKey))
  }
}

export type SignResult = {signatureHex: string; verified: boolean}

// proves a tweaked key is a real, usable keypair (not just abstract hex) -
// signs a holder-typed message with the tweaked secret key using this
// repo's own @noble/curves schnorr (BIP340), then verifies against the
// tweaked pubkey. Not @scure/btc-signer's Signer tool - that's shaped
// around signing a Bitcoin transaction input, not an arbitrary message.
export const signWithTweakedKey = (
  secretKeyHex: string,
  leafScripts: Uint8Array[],
  messageUtf8: string
): SignResult => {
  const tweakedSecretKey = hexToBytes(tweakSecretKey(secretKeyHex, leafScripts))
  const tweakedPubkey = schnorr.getPublicKey(tweakedSecretKey)
  // @noble/curves' schnorr.sign/verify accept an arbitrary-length message
  // (BIP340 doesn't mandate a fixed size) - hashed first anyway, matching
  // how a real signer almost always signs a fixed-size digest (a sighash,
  // a challenge hash, ...) rather than raw holder-typed text
  const digest = sha256(utf8ToBytes(messageUtf8))
  const signature = schnorr.sign(digest, tweakedSecretKey)
  return {
    signatureHex: bytesToHex(signature),
    verified: schnorr.verify(signature, digest, tweakedPubkey)
  }
}
