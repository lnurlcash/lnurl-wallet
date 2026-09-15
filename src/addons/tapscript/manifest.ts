import type {Addon, AddonHelper, AddonManifest, UiNode} from '../types'
import {hexToBytes} from '@noble/hashes/utils.js'
import {
  generateKeypair,
  tweakPubkey,
  signWithTweakedKey,
  compileLeaf,
  scriptTemplateById,
  SCRIPT_TEMPLATES,
  type ScriptTemplateId,
  type ScriptTemplateParams,
  type CompiledLeaf,
  type TweakResult,
  type SignResult
} from './taproot'
import {
  newParticipant,
  aggregatePubkeys,
  aggregateAndSign,
  type Musig2Participant,
  type Musig2Result
} from './musig2'
// pure, permission-free math (encoding + local signature verification, no
// network/wallet-state access) - same "sandbox stays a sandbox" reasoning
// bech32Decoder's own addon already relies on for verifyNoteSignature
import {encodeCk1, recoverNoteOwnershipPubkey} from '../../lnurlcash'

// Taproot pubkey tweaking (BIP341) and MuSig2 (BIP327) - a "play around"
// sandbox, not wired into this wallet's own note-signing anywhere. All key
// material lives in this addon's own page-local state (never persisted,
// gone on reload - see AddonRun.tsx/Renderer.tsx's 'run' mode), never
// cashSecrets.ts or the wallet's real seed. permissions: [] below is load-
// bearing, not decorative: this addon declares zero verbs, so it has no
// way to touch a real note, mint, or address regardless of what a holder
// pastes into it.
const trimmedString = (value: unknown): string => String(value ?? '').trim()
const isHex32 = (value: unknown): boolean =>
  /^[0-9a-fA-F]{64}$/.test(trimmedString(value))

// ---- Taproot tweak section ----
//
// A "script tree" entry used to be a free-text field folded into a fake
// sha256(joined-text) merkle root - illustrative, never a real Tapscript
// program. It's now a (template, params) row compiled through taproot.ts's
// own compileLeaf into a REAL Bitcoin Script program (real opcodes, via
// @scure/btc-signer/script.js's own encoder) and folded into a REAL BIP341
// merkle root (via @scure/btc-signer/payment.js's own p2tr tree builder,
// see taproot.ts's merkleRootFor) - the same machinery a real wallet uses,
// not an approximation of it.
type ScriptRow = {
  templateId: string
  pubkeyHex: string
  pubkey2Hex: string
  hashHex: string
  locktime: number
}

const newScriptRow = (templateId: unknown): ScriptRow => ({
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

// compiles one row's own (template, params) - the per-row live preview
// (opcodes/script hex/leaf hash) below all read through this, same
// "swallow throws, not-ready-yet reads as null" contract as tweakPreview
// further down, since this reruns on every keystroke while a holder is
// still typing a pubkey/hash/locktime.
const rowCompiled = (item: unknown): CompiledLeaf | null => {
  const row = item as Partial<ScriptRow> | undefined
  if (!row?.templateId) return null
  return compileLeaf(row.templateId, rowParams(row))
}

const templateName = (templateId: unknown): string =>
  scriptTemplateById(trimmedString(templateId))?.name ?? 'Unknown template'

const templateDescription = (templateId: unknown): string =>
  scriptTemplateById(trimmedString(templateId))?.description ?? ''

const rowOpcodes = (item: unknown): string => rowCompiled(item)?.opcodes ?? '-'

const rowScriptHex = (item: unknown): string =>
  rowCompiled(item)?.scriptHex ?? '-'

const rowLeafHash = (item: unknown): string =>
  rowCompiled(item)?.leafHashHex ?? '-'

// every row's compiled leaf script bytes, in order - null (incomplete/
// malformed) rows are dropped rather than blocking the whole tweak, so a
// holder mid-way through typing a second leaf's pubkey still sees the
// first leaf's tweak update live
const leafScriptsFor = (scripts: unknown): Uint8Array[] =>
  Array.isArray(scripts)
    ? (scripts as unknown[])
        .map(rowCompiled)
        .filter((c): c is CompiledLeaf => c !== null)
        .map(c => hexToBytes(c.scriptHex))
    : []

// swallows tweakPubkey's own throws (bad/incomplete hex) rather than
// letting a live Text binding crash mid-typing - see this file's own
// ErrorBoundary note in Renderer.tsx for why that would otherwise show
// the addon's scoped-error fallback for something as ordinary as "hasn't
// finished pasting a pubkey yet"
const tweakPreview = (
  pubkeyHex: unknown,
  scripts: unknown
): TweakResult | null => {
  if (!isHex32(pubkeyHex)) return null
  try {
    return tweakPubkey(trimmedString(pubkeyHex), leafScriptsFor(scripts))
  } catch {
    return null
  }
}

const hasTweakPreview = (pubkeyHex: unknown, scripts: unknown): boolean =>
  tweakPreview(pubkeyHex, scripts) !== null

const tweakedPubkeyDisplay = (pubkeyHex: unknown, scripts: unknown): string =>
  tweakPreview(pubkeyHex, scripts)?.tweakedPubkeyHex ?? '-'

const tweakScalarDisplay = (pubkeyHex: unknown, scripts: unknown): string =>
  tweakPreview(pubkeyHex, scripts)?.tweakScalarHex ?? '-'

const tweakParityDisplay = (pubkeyHex: unknown, scripts: unknown): string =>
  tweakPreview(pubkeyHex, scripts)?.parity ?? '-'

const merkleRootDisplay = (pubkeyHex: unknown, scripts: unknown): string => {
  const result = tweakPreview(pubkeyHex, scripts)
  if (!result) return '-'
  return result.merkleRootHex === ''
    ? '(none - key-path only)'
    : result.merkleRootHex
}

// the Sign button's own helper - deliberately throws straight through on
// bad input (unlike the live preview above) since a Button's onClick
// already runs inside Renderer.tsx's own try/catch (see runAction), which
// turns a thrown Error into a plain toast notification - exactly the
// right feedback for a deliberate button click, unlike a live binding
const signDemo = (
  secretKeyHex: unknown,
  scripts: unknown,
  message: unknown
): SignResult =>
  signWithTweakedKey(
    trimmedString(secretKeyHex),
    leafScriptsFor(scripts),
    trimmedString(message)
  )

const addTemplateButton = (id: ScriptTemplateId): UiNode => ({
  type: 'Button',
  label: `Add "${scriptTemplateById(id)!.name}"`,
  onClick: {
    action: 'push',
    path: 'scripts',
    value: {helper: 'newScriptRow', args: [id]}
  }
})

const scriptRow: UiNode = {
  type: 'View',
  style: 'row',
  children: [
    {
      type: 'Text',
      value: {helper: 'templateName', args: [{var: 'item.templateId'}]},
      style: 'subheading'
    },
    {
      type: 'Text',
      value: {helper: 'templateDescription', args: [{var: 'item.templateId'}]}
    },
    {
      type: 'Input',
      bind: 'item.pubkeyHex',
      label: 'Pubkey (every template uses this one - multisig2’s FIRST key)'
    },
    {
      type: 'Input',
      bind: 'item.pubkey2Hex',
      label: 'Pubkey B (multisig2 only)'
    },
    {
      type: 'Input',
      bind: 'item.hashHex',
      label: 'SHA256 hash of a secret, hex (hashlock only)'
    },
    {
      type: 'Input',
      bind: 'item.locktime',
      kind: 'number',
      label: 'Locktime / sequence number (csv/cltv only)'
    },
    {
      type: 'Text',
      value: {
        cat: ['Opcodes: ', {helper: 'rowOpcodes', args: [{var: 'item'}]}]
      },
      style: 'response-block'
    },
    {
      type: 'Text',
      value: {
        cat: ['Script hex: ', {helper: 'rowScriptHex', args: [{var: 'item'}]}]
      }
    },
    {
      type: 'Text',
      value: {
        cat: ['TapLeaf hash: ', {helper: 'rowLeafHash', args: [{var: 'item'}]}]
      }
    },
    {
      type: 'Button',
      label: 'Remove',
      onClick: {action: 'removeAt', path: 'scripts', index: {var: 'index'}}
    }
  ]
}

const taprootUi: UiNode[] = [
  {type: 'Text', value: 'Taproot pubkey tweaking (BIP341)', style: 'heading'},
  {
    type: 'Text',
    value:
      "Ephemeral - held only on this page, never connected to this wallet's real seed or notes. Reloading or leaving this page discards it."
  },
  {type: 'Text', value: 'How to use this', style: 'subheading'},
  {
    type: 'List',
    ordered: true,
    each: [
      "Generate a keypair below (or skip this - you only need a pubkey for the tweak itself, the secret key is only for the last, optional 'sign' step).",
      "Optionally click one or more 'Add \"...\"' buttons under 'Script tree' to try a script-path tweak with a real Tapscript leaf - leave it empty for a plain key-path tweak.",
      'Each added leaf needs a pubkey (paste the one generated above, or any 32-byte x-only hex) - some templates also need a second pubkey, a SHA256 hash, or a locktime/sequence number; its compiled opcodes, script hex, and TapLeaf hash appear automatically as you fill them in.',
      "Paste the x-only pubkey you want to tweak into 'Tweak a pubkey' - the tweaked pubkey, tweak scalar, parity, and merkle root (folding in every leaf above via a real BIP341 tree, not an approximation) appear automatically as you type.",
      "To prove the tweaked key is a real, usable keypair (not just hex), paste the SAME key's secret key, type any message, and click 'Sign with tweaked key'."
    ],
    children: [{type: 'Text', value: {var: 'item'}}]
  },
  {type: 'Text', value: 'Generate a keypair', style: 'subheading'},
  {
    type: 'Button',
    label: 'Generate new keypair',
    onClick: {
      action: 'set',
      path: 'generated',
      value: {helper: 'generateKeypair', args: []}
    }
  },
  {
    type: 'Show',
    when: {var: 'generated'},
    children: [
      {
        type: 'Text',
        value: {cat: ['secret key: ', {var: 'generated.secretKeyHex'}]},
        style: 'seed-block'
      },
      {
        type: 'Button',
        label: 'Copy secret key',
        onClick: {
          verb: 'clipboard.copy',
          args: {text: {var: 'generated.secretKeyHex'}}
        }
      },
      {
        type: 'Text',
        value: {cat: ['pubkey: ', {var: 'generated.pubkeyHex'}]},
        style: 'seed-block'
      },
      {
        type: 'Button',
        label: 'Copy pubkey',
        onClick: {
          verb: 'clipboard.copy',
          args: {text: {var: 'generated.pubkeyHex'}}
        }
      }
    ]
  },
  {
    type: 'Text',
    value: 'Script tree (optional - empty means key-path only)',
    style: 'subheading'
  },
  {
    type: 'Text',
    value:
      'Each entry below is a REAL Tapscript leaf, compiled from real Bitcoin Script opcodes (via @scure/btc-signer’s own Script encoder) - not illustrative placeholder text. Pick a template to add one, fill in its pubkey(s)/hash/locktime, and its opcodes, script hex, and individual TapLeaf hash (BIP341’s own tagged hash) appear below it. Multiple leaves fold into one real BIP341 merkle root via @scure/btc-signer’s own script-tree builder, the same code path a real wallet uses.'
  },
  {type: 'For', each: {var: 'scripts'}, children: [scriptRow]},
  {
    type: 'View',
    style: 'row',
    children: SCRIPT_TEMPLATES.map(t => addTemplateButton(t.id))
  },
  {type: 'Text', value: 'Tweak a pubkey', style: 'subheading'},
  {
    type: 'Input',
    bind: 'pubkeyInput',
    label: 'x-only pubkey to tweak (32-byte hex)'
  },
  {
    type: 'Show',
    when: {
      helper: 'hasTweakPreview',
      args: [{var: 'pubkeyInput'}, {var: 'scripts'}]
    },
    children: [
      {
        type: 'Text',
        value: {
          cat: [
            'Tweaked pubkey: ',
            {
              helper: 'tweakedPubkeyDisplay',
              args: [{var: 'pubkeyInput'}, {var: 'scripts'}]
            }
          ]
        },
        style: 'response-block'
      },
      {
        type: 'Text',
        value: {
          cat: [
            'Tweak scalar: ',
            {
              helper: 'tweakScalarDisplay',
              args: [{var: 'pubkeyInput'}, {var: 'scripts'}]
            }
          ]
        }
      },
      {
        type: 'Text',
        value: {
          cat: [
            'Tweaked key parity: ',
            {
              helper: 'tweakParityDisplay',
              args: [{var: 'pubkeyInput'}, {var: 'scripts'}]
            }
          ]
        }
      },
      {
        type: 'Text',
        value: {
          cat: [
            'Merkle root: ',
            {
              helper: 'merkleRootDisplay',
              args: [{var: 'pubkeyInput'}, {var: 'scripts'}]
            }
          ]
        }
      }
    ]
  },
  {type: 'Text', value: 'Sign with a tweaked key', style: 'subheading'},
  {
    type: 'Text',
    value:
      'Proves the tweak really is a usable keypair, not just abstract hex - signs a message with the tweaked secret key and verifies it against the tweaked pubkey above.'
  },
  {
    type: 'Input',
    bind: 'secretKeyInput',
    label: 'Secret key matching the pubkey above (32-byte hex)'
  },
  {type: 'Input', bind: 'taprootMessage', label: 'Message to sign'},
  {
    type: 'Button',
    label: 'Sign with tweaked key',
    onClick: {
      action: 'set',
      path: 'taprootSignResult',
      value: {
        helper: 'signDemo',
        args: [
          {var: 'secretKeyInput'},
          {var: 'scripts'},
          {var: 'taprootMessage'}
        ]
      }
    }
  },
  {
    type: 'Show',
    when: {var: 'taprootSignResult'},
    children: [
      {
        type: 'Text',
        value: {cat: ['Signature: ', {var: 'taprootSignResult.signatureHex'}]},
        style: 'response-block'
      },
      {
        type: 'Show',
        when: {var: 'taprootSignResult.verified'},
        children: [{type: 'Text', value: '✓ verified'}]
      },
      {
        type: 'Show',
        when: {helper: 'not', args: [{var: 'taprootSignResult.verified'}]},
        children: [{type: 'Text', value: '✗ not verified'}]
      }
    ]
  }
]

// ---- MuSig2 section ----

const MAX_PARTICIPANTS = 3

const participantCount = (participants: unknown): number =>
  Array.isArray(participants) ? participants.length : 0

const canAddParticipant = (participants: unknown): boolean =>
  participantCount(participants) < MAX_PARTICIPANTS

const canAggregate = (participants: unknown): boolean =>
  participantCount(participants) >= 2

const musigPreview = (participants: unknown): string => {
  if (!Array.isArray(participants) || participants.length < 2) return '-'
  try {
    return aggregatePubkeys(
      (participants as Musig2Participant[]).map(p => p.pubkeyHex)
    )
  } catch {
    return '-'
  }
}

// the Aggregate & sign button's own helper - deliberately throws straight
// through on bad input, same reasoning as taproot's signDemo above
const runMusigRound = (participants: unknown, message: unknown): Musig2Result =>
  aggregateAndSign(
    Array.isArray(participants) ? (participants as Musig2Participant[]) : [],
    trimmedString(message)
  )

// ck1's own fixed message (src/lib/signature.ts's NOTE_OWNERSHIP_MESSAGE) -
// hardcoded rather than reading `musigMessage`, so the worked example below
// only lights up once the group has actually signed THIS exact message, the
// one thing a real ck1 ownership proof is ever checked against
const CK1_OWNERSHIP_MESSAGE = 'LNURLcash'

const isCk1DemoMessage = (message: unknown): boolean =>
  trimmedString(message) === CK1_OWNERSHIP_MESSAGE

// takes a completed MuSig2 round and encodes its (group pubkey, final
// signature) pair exactly the way a real note's ck1 does (see
// src/lib/recoverableNotes.ts's encodeCk1) - both are already the right
// shape (32-byte x-only pubkey, 64-byte BIP-340 signature), no reformatting
// needed. `recoverNoteOwnershipPubkey` is the SAME check src/lib/signature.ts
// runs on every note this wallet holds; running it here against a value
// that never touched cashSecrets.ts or a real seed is what actually proves
// the claim above, rather than just asserting it in prose.
const ck1FromMusigResult = (result: unknown): string | null => {
  const r = result as Musig2Result | null
  if (!r) return null
  try {
    return encodeCk1(hexToBytes(r.groupPubkeyHex), hexToBytes(r.finalSigHex))
  } catch {
    return null
  }
}

const ck1Display = (result: unknown): string =>
  ck1FromMusigResult(result) ?? '-'

const ck1Accepted = (result: unknown): boolean => {
  const ck1 = ck1FromMusigResult(result)
  return ck1 !== null && recoverNoteOwnershipPubkey(ck1) !== null
}

const participantRow: UiNode = {
  type: 'View',
  style: 'row',
  children: [
    {type: 'Text', value: {var: 'item.pubkeyHex'}},
    {
      type: 'Button',
      label: 'Remove',
      onClick: {action: 'removeAt', path: 'participants', index: {var: 'index'}}
    }
  ]
}

const signerRow: UiNode = {
  type: 'View',
  style: 'row',
  children: [
    {
      type: 'Text',
      value: {cat: [{var: 'item.pubkeyHex'}, ': ', {var: 'item.partialSigHex'}]}
    },
    {
      type: 'Show',
      when: {var: 'item.partialVerified'},
      children: [{type: 'Text', value: '✓'}]
    },
    {
      type: 'Show',
      when: {helper: 'not', args: [{var: 'item.partialVerified'}]},
      children: [{type: 'Text', value: '✗'}]
    }
  ]
}

const musigUi: UiNode[] = [
  {type: 'Text', value: 'MuSig2 (BIP327)', style: 'heading'},
  {
    type: 'Text',
    value:
      'Aggregate 2-3 local, ephemeral keypairs into one pubkey, then produce ONE joint Schnorr signature - a verifier only ever sees a single ordinary-looking key and a single ordinary-looking signature, never that multiple people were involved. This is a real, spec-checked implementation (see this addon’s own tests). A cp1 note’s own ownership proof (ck1) is the same algorithm - a BIP-340 Schnorr signature over a fixed message, checked directly against the note’s own pubkey (src/lib/signature.ts) - so an aggregate key produced here is cryptographically capable of owning a spendable note; sign the message "LNURLcash" below to see that proven directly against this wallet’s own verification code, not just asserted here. This playground still never touches this wallet’s real notes, seed, or mints, by design (permissions: [] above, not a crypto limitation): wiring an aggregate key into an actual mint/spend flow would be separate, deliberate work.'
  },
  {type: 'Text', value: 'How to use this', style: 'subheading'},
  {
    type: 'List',
    ordered: true,
    each: [
      "Click 'Add participant' 2 or 3 times - each click generates one fresh, ephemeral keypair locally.",
      'Once there are 2 or more participants, the aggregated group pubkey appears automatically below the list.',
      'Type a message for the group to sign together - or type exactly "LNURLcash" to also see the ck1 worked example below.',
      "Click 'Aggregate & sign' - this runs the entire MuSig2 round in one step (nonce generation, nonce aggregation, every participant's partial signature, and final aggregation).",
      "Check the result: the final signature's own ✓ verified line, and each signer's individual partial-signature ✓ underneath."
    ],
    children: [{type: 'Text', value: {var: 'item'}}]
  },
  {type: 'For', each: {var: 'participants'}, children: [participantRow]},
  {
    type: 'Show',
    when: {helper: 'canAddParticipant', args: [{var: 'participants'}]},
    children: [
      {
        type: 'Button',
        label: 'Add participant',
        onClick: {
          action: 'push',
          path: 'participants',
          value: {helper: 'newParticipant', args: []}
        }
      }
    ]
  },
  {
    type: 'Show',
    when: {helper: 'canAggregate', args: [{var: 'participants'}]},
    children: [
      {
        type: 'Text',
        value: {
          cat: [
            'Group pubkey: ',
            {helper: 'musigPreview', args: [{var: 'participants'}]}
          ]
        },
        style: 'response-block'
      },
      {type: 'Input', bind: 'musigMessage', label: 'Message to sign together'},
      {
        type: 'Button',
        label: 'Aggregate & sign',
        onClick: {
          action: 'set',
          path: 'musigResult',
          value: {
            helper: 'runMusigRound',
            args: [{var: 'participants'}, {var: 'musigMessage'}]
          }
        }
      }
    ]
  },
  {
    type: 'Show',
    when: {var: 'musigResult'},
    children: [
      {
        type: 'Text',
        value: {cat: ['Final signature: ', {var: 'musigResult.finalSigHex'}]},
        style: 'response-block'
      },
      {
        type: 'Show',
        when: {var: 'musigResult.verified'},
        children: [
          {type: 'Text', value: '✓ verified (independent @noble/curves check)'}
        ]
      },
      {
        type: 'Show',
        when: {helper: 'not', args: [{var: 'musigResult.verified'}]},
        children: [{type: 'Text', value: '✗ not verified'}]
      },
      {
        type: 'Text',
        value: 'Per-signer partial signatures',
        style: 'subheading'
      },
      {type: 'For', each: {var: 'musigResult.signers'}, children: [signerRow]},
      {
        type: 'Text',
        value: 'As a ck1 note-ownership proof',
        style: 'subheading'
      },
      {
        type: 'Show',
        when: {helper: 'isCk1DemoMessage', args: [{var: 'musigMessage'}]},
        children: [
          {
            type: 'Text',
            value:
              'The group pubkey and final signature above are already the exact shape a real ck1 needs (32-byte x-only pubkey, 64-byte BIP-340 signature) - encoded below and run through this wallet’s own recoverNoteOwnershipPubkey, unchanged.'
          },
          {
            type: 'Text',
            value: {
              cat: [
                'ck1: ',
                {helper: 'ck1Display', args: [{var: 'musigResult'}]}
              ]
            },
            style: 'response-block'
          },
          {
            type: 'Show',
            when: {helper: 'ck1Accepted', args: [{var: 'musigResult'}]},
            children: [
              {
                type: 'Text',
                value:
                  '✓ accepted - this wallet’s note-verification code cannot tell this apart from an ordinary single-signer ck1'
              }
            ]
          },
          {
            type: 'Show',
            when: {
              helper: 'not',
              args: [{helper: 'ck1Accepted', args: [{var: 'musigResult'}]}]
            },
            children: [{type: 'Text', value: '✗ not accepted'}]
          }
        ]
      },
      {
        type: 'Show',
        when: {
          helper: 'not',
          args: [{helper: 'isCk1DemoMessage', args: [{var: 'musigMessage'}]}]
        },
        children: [
          {
            type: 'Text',
            value:
              'Set "Message to sign together" above to exactly "LNURLcash" (ck1’s own fixed message) and sign again to see this pair encoded and accepted as a real ck1 ownership proof.'
          }
        ]
      }
    ]
  }
]

const tapscriptManifest: AddonManifest = {
  id: 'tapscript',
  name: 'Tapscript Playground',
  version: '1',
  icon: 'gitmerge',
  description:
    'Play around with BIP341 Taproot pubkey tweaking (real Tapscript leaf templates - pay-to-pubkey, CSV/CLTV timelocks, hashlock, 2-of-2 multisig) and BIP327 MuSig2 joint signatures - a sandbox, never wired into this wallet’s own notes.',
  permissions: [],
  nav: {position: 'right', icon: 'gitmerge', label: 'Tapscript'},
  state: {
    generated: null,
    scripts: [],
    pubkeyInput: '',
    secretKeyInput: '',
    taprootMessage: 'hello tapscript',
    taprootSignResult: null,
    participants: [],
    musigMessage: 'hello musig2',
    musigResult: null
  },
  ui: {
    type: 'View',
    children: [...taprootUi, ...musigUi]
  }
}

// 'not' comes from GLOBAL_HELPERS (see globalHelpers.ts), merged in ahead
// of this addon's own helpers by Renderer.tsx - no need to redefine it
const tapscriptHelpers: Record<string, AddonHelper> = {
  generateKeypair: generateKeypair as AddonHelper,
  newScriptRow: newScriptRow as AddonHelper,
  templateName: templateName as AddonHelper,
  templateDescription: templateDescription as AddonHelper,
  rowOpcodes: rowOpcodes as AddonHelper,
  rowScriptHex: rowScriptHex as AddonHelper,
  rowLeafHash: rowLeafHash as AddonHelper,
  hasTweakPreview: hasTweakPreview as AddonHelper,
  tweakedPubkeyDisplay: tweakedPubkeyDisplay as AddonHelper,
  tweakScalarDisplay: tweakScalarDisplay as AddonHelper,
  tweakParityDisplay: tweakParityDisplay as AddonHelper,
  merkleRootDisplay: merkleRootDisplay as AddonHelper,
  signDemo: signDemo as AddonHelper,
  newParticipant: newParticipant as AddonHelper,
  canAddParticipant: canAddParticipant as AddonHelper,
  canAggregate: canAggregate as AddonHelper,
  musigPreview: musigPreview as AddonHelper,
  runMusigRound: runMusigRound as AddonHelper,
  isCk1DemoMessage: isCk1DemoMessage as AddonHelper,
  ck1Display: ck1Display as AddonHelper,
  ck1Accepted: ck1Accepted as AddonHelper
}

export const tapscriptAddon: Addon = {
  manifest: tapscriptManifest,
  helpers: tapscriptHelpers
}
