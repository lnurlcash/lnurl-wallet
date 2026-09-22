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
import {deriveScriptPathCommitment} from '../../lib/recoverableNotes'

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
// keeps its OP_ mnemonic. Exported: also the generic fallback view for an
// arbitrary/unrecognised leaf (see identifyLeaf below and
// components/ScriptPreviewDialog.tsx), not just this addon's own live
// per-row display.
export const opcodesOf = (script: Uint8Array): string =>
  Script.decode(script)
    .map(op =>
      op instanceof Uint8Array
        ? bytesToHex(op)
        : typeof op === 'number'
          ? String(op)
          : `OP_${op}`
    )
    .join(' ')

export type IdentifiedLeaf = {
  template: ScriptTemplate
  params: ScriptTemplateParams
}

// tries to recognise an arbitrary decoded script as one of SCRIPT_TEMPLATES'
// own fixed shapes - the read side of compileLeaf's write side. Not a
// general disassembler (opcodesOf above already is one): this only ever
// reports a positive match when the script is byte-for-byte what that
// template's own build() would produce for the recovered params, so a
// caller can trust the friendly description it hands back rather than
// treating it as a guess. Null for anything else (including a script this
// addon's own templates just don't cover - opcodesOf is always the
// fallback). Never throws.
export const identifyLeaf = (script: Uint8Array): IdentifiedLeaf | null => {
  let decoded: unknown[]
  try {
    decoded = Script.decode(script)
  } catch {
    return null
  }
  const push32 = (op: unknown): string | null =>
    op instanceof Uint8Array && op.length === 32 ? bytesToHex(op) : null
  const num = (op: unknown): number | null => {
    if (typeof op === 'number') return op
    if (!(op instanceof Uint8Array)) return null
    try {
      return Number(ScriptNum().decode(op))
    } catch {
      return null
    }
  }
  const params = (
    over: Partial<ScriptTemplateParams>
  ): ScriptTemplateParams => ({
    pubkeyHex: '',
    pubkey2Hex: '',
    hashHex: '',
    locktime: 0,
    ...over
  })
  const matches = (
    id: ScriptTemplateId,
    p: ScriptTemplateParams
  ): IdentifiedLeaf | null => {
    const template = scriptTemplateById(id)!
    try {
      return bytesToHex(template.build(p)) === bytesToHex(script)
        ? {template, params: p}
        : null
    } catch {
      return null
    }
  }

  if (decoded.length === 2 && decoded[1] === 'CHECKSIG') {
    const pk = push32(decoded[0])
    if (pk) {
      const hit = matches('pk', params({pubkeyHex: pk}))
      if (hit) return hit
    }
  }
  if (
    decoded.length === 5 &&
    decoded[2] === 'DROP' &&
    decoded[4] === 'CHECKSIG'
  ) {
    const locktime = num(decoded[0])
    const pk = push32(decoded[3])
    if (locktime !== null && pk) {
      if (decoded[1] === 'CHECKSEQUENCEVERIFY') {
        const hit = matches('csv', params({pubkeyHex: pk, locktime}))
        if (hit) return hit
      }
      if (decoded[1] === 'CHECKLOCKTIMEVERIFY') {
        const hit = matches('cltv', params({pubkeyHex: pk, locktime}))
        if (hit) return hit
      }
    }
  }
  if (
    decoded.length === 5 &&
    decoded[0] === 'SHA256' &&
    decoded[2] === 'EQUALVERIFY' &&
    decoded[4] === 'CHECKSIG'
  ) {
    const hash = push32(decoded[1])
    const pk = push32(decoded[3])
    if (hash && pk) {
      const hit = matches('hashlock', params({pubkeyHex: pk, hashHex: hash}))
      if (hit) return hit
    }
  }
  if (
    decoded.length === 6 &&
    decoded[1] === 'CHECKSIG' &&
    decoded[3] === 'CHECKSIGADD' &&
    decoded[4] === 2 &&
    decoded[5] === 'NUMEQUAL'
  ) {
    const pkA = push32(decoded[0])
    const pkB = push32(decoded[2])
    if (pkA && pkB) {
      const hit = matches(
        'multisig2',
        params({pubkeyHex: pkA, pubkey2Hex: pkB})
      )
      if (hit) return hit
    }
  }
  return null
}

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

// ---- script-tree rows ----
//
// One editable "script tree" entry: a (template, params) pair, compiled
// through compileLeaf above into a REAL Tapscript program. Lives here
// rather than in a manifest because two addons now build script trees -
// taproot's own playground, and musig2's "lock a note to ct1<Q>" flow -
// and both need the identical row -> compiled-leaf mapping. Only the pure
// mapping is shared; each manifest still owns its own UI for editing rows.

export type ScriptRow = {
  templateId: string
  pubkeyHex: string
  pubkey2Hex: string
  hashHex: string
  locktime: number
}

const trimmedString = (value: unknown): string => String(value ?? '').trim()

export const newScriptRow = (templateId: unknown): ScriptRow => ({
  templateId: trimmedString(templateId) || SCRIPT_TEMPLATES[0]!.id,
  pubkeyHex: '',
  pubkey2Hex: '',
  hashHex: '',
  locktime: 0
})

const rowParams = (
  row: Partial<ScriptRow> | undefined
): ScriptTemplateParams => ({
  pubkeyHex: trimmedString(row?.pubkeyHex),
  pubkey2Hex: trimmedString(row?.pubkey2Hex),
  hashHex: trimmedString(row?.hashHex),
  locktime: Number(row?.locktime) || 0
})

// compiles one row's own (template, params) - every per-row live preview
// (opcodes/script hex/leaf hash) reads through this, with the same "swallow
// throws, not-ready-yet reads as null" contract the tweak previews use,
// since it reruns on every keystroke while a holder is still typing a
// pubkey/hash/locktime.
export const rowCompiled = (item: unknown): CompiledLeaf | null => {
  const row = item as Partial<ScriptRow> | undefined
  if (!row?.templateId) return null
  return compileLeaf(row.templateId, rowParams(row))
}

// every row's compiled leaf script bytes, in order - null (incomplete/
// malformed) rows are dropped rather than blocking the whole tweak, so a
// holder mid-way through typing a second leaf's pubkey still sees the
// first leaf's tweak update live
export const leafScriptsFor = (scripts: unknown): Uint8Array[] =>
  Array.isArray(scripts)
    ? (scripts as unknown[])
        .map(rowCompiled)
        .filter((c): c is CompiledLeaf => c !== null)
        .map(c => hexToBytes(c.scriptHex))
    : []

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

// ---- script-path proofs ----
//
// What a script-path redemption actually reveals: the leaf script plus
// BIP341's control block (leaf version + output-key parity, the internal
// key P, and the merkle path up to the committed root). @scure/btc-signer's
// p2tr() already computes a control block for every leaf as part of
// building the tree - merkleRootFor above only ever kept its merkle root -
// so producing a proof is a matter of not discarding it, not new crypto.

export type ScriptPathProof = {
  script: Uint8Array
  controlBlock: Uint8Array
}

// one proof per leaf, in the SAME order as leafScripts. Empty for a
// key-path-only output (no leaves, nothing to reveal).
export const scriptPathProofs = (
  internalPubkey: Uint8Array,
  leafScripts: Uint8Array[]
): ScriptPathProof[] => {
  if (leafScripts.length === 0) return []
  const tree = leafScripts.map(script => ({script}))
  const out = p2tr(internalPubkey, tree, undefined, true) as P2TR_TREE
  // p2tr() attaches an already BIP341-encoded controlBlock (parity bit
  // included, via the library's own TaprootControlBlock coder) to every
  // leaf it returns, but its declared TaprootLeaf type omits the field -
  // a gap in the library's typings, not something to re-derive by hand
  const leaves = out.leaves as (P2TR_TREE['leaves'][number] & {
    controlBlock?: Uint8Array
  })[]
  // p2tr() may reorder/rebalance leaves while building the tree, so match
  // each requested script back to ITS OWN control block by content rather
  // than trusting positional order
  return leafScripts.map(script => {
    const leaf = leaves.find(l => bytesToHex(l.script) === bytesToHex(script))
    if (!leaf?.controlBlock) {
      throw new Error('p2tr() returned no control block for a requested leaf.')
    }
    return {script, controlBlock: leaf.controlBlock}
  })
}

// BIP341 script-path verification, as a mint would run it BEFORE ever
// evaluating the script itself: does this (script, control block) really
// commit to the already-known output key Q, with the parity the control
// block claims? The merkle-walk + tweak itself is shared, general-purpose
// crypto (lib/recoverableNotes.ts's deriveScriptPathCommitment - also what
// resolves a bare cw1 note back to its Q with no addon involved); this
// just adds the "matches an already-known key" comparison a lock's own
// self-check wants. This is pure crypto - no opcode is executed and no
// clock is consulted - and it is the whole reason a ct1 needs to carry
// nothing but Q: nobody can satisfy it for a key they didn't build
// forward from a real tree.
//
// Never throws: a malformed proof is simply "not committed to Q".
export const verifyScriptPath = (
  outputKeyHex: string,
  proof: ScriptPathProof
): boolean => {
  try {
    const outputKey = parseHex(outputKeyHex, 32, 'Output key')
    const commitment = deriveScriptPathCommitment(
      proof.script,
      proof.controlBlock
    )
    if (!commitment) return false
    const claimedParity = proof.controlBlock[0]! & 1
    return (
      bytesToHex(commitment.outputKey) === bytesToHex(outputKey) &&
      commitment.parity === claimedParity
    )
  } catch {
    return false
  }
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
