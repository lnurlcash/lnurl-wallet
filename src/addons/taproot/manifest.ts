import type {Addon, AddonHelper, AddonManifest, UiNode} from '../types'
import {
  generateKeypair,
  tweakPubkey,
  signWithTweakedKey,
  scriptTemplateById,
  newScriptRow,
  rowCompiled,
  leafScriptsFor,
  SCRIPT_TEMPLATES,
  type ScriptTemplateId,
  type TweakResult,
  type SignResult
} from './taproot'

// Taproot pubkey tweaking (BIP341) - a "play around" sandbox, not wired
// into this wallet's own note-signing anywhere. All key material lives in
// this addon's own page-local state (never persisted, gone on reload - see
// AddonRun.tsx/Renderer.tsx's 'run' mode), never cashSecrets.ts or the
// wallet's real seed. permissions: [] below is load-bearing, not
// decorative: this addon declares zero verbs, so it has no way to touch a
// real note, mint, or address regardless of what a holder pastes into it.
// See the sibling `musig2` addon for BIP327 joint signatures - split out
// separately since the two BIPs are genuinely different specs, not one
// feature (and this file alone was already pushing 500+ lines combined).
const trimmedString = (value: unknown): string => String(value ?? '').trim()
const isHex32 = (value: unknown): boolean =>
  /^[0-9a-fA-F]{64}$/.test(trimmedString(value))

// A "script tree" entry used to be a free-text field folded into a fake
// sha256(joined-text) merkle root - illustrative, never a real Tapscript
// program. It's now a (template, params) row compiled through taproot.ts's
// own compileLeaf into a REAL Bitcoin Script program (real opcodes, via
// @scure/btc-signer/script.js's own encoder) and folded into a REAL BIP341
// merkle root (via @scure/btc-signer/payment.js's own p2tr tree builder,
// see taproot.ts's merkleRootFor) - the same machinery a real wallet uses,
// not an approximation of it. The row shape and its compilation live in
// taproot.ts, shared with the musig2 addon's own tweaked lock flow.

const templateName = (templateId: unknown): string =>
  scriptTemplateById(trimmedString(templateId))?.name ?? 'Unknown template'

const templateDescription = (templateId: unknown): string =>
  scriptTemplateById(trimmedString(templateId))?.description ?? ''

const rowOpcodes = (item: unknown): string => rowCompiled(item)?.opcodes ?? '-'

const rowScriptHex = (item: unknown): string =>
  rowCompiled(item)?.scriptHex ?? '-'

const rowLeafHash = (item: unknown): string =>
  rowCompiled(item)?.leafHashHex ?? '-'

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

const taprootDocsUi: UiNode[] = [
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
  }
]

const taprootBuilderUi: UiNode[] = [
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

// builder (interactive) on the left, reference docs on the right - see
// style.scss's own .addon-columns for the grid/collapse behaviour, and the
// sibling musig2 addon's manifest for the same split
const taprootUi: UiNode[] = [
  {type: 'Text', value: 'Taproot pubkey tweaking (BIP341)', style: 'heading'},
  {
    type: 'View',
    style: 'columns',
    children: [
      {type: 'View', style: 'col-left', children: taprootBuilderUi},
      {type: 'View', style: 'col-right', children: taprootDocsUi}
    ]
  }
]

const taprootManifest: AddonManifest = {
  id: 'taproot',
  name: 'Taproot Playground',
  version: '1',
  icon: 'gitmerge',
  description:
    'Play around with BIP341 Taproot pubkey tweaking - real Tapscript leaf templates (pay-to-pubkey, CSV/CLTV timelocks, hashlock, 2-of-2 multisig) - a sandbox, never wired into this wallet’s own notes. See the separate MuSig2 addon for BIP327 joint signatures.',
  permissions: [],
  nav: {position: 'right', icon: 'gitmerge', label: 'Taproot'},
  state: {
    generated: null,
    scripts: [],
    pubkeyInput: '',
    secretKeyInput: '',
    taprootMessage: 'hello tapscript',
    taprootSignResult: null
  },
  ui: {
    type: 'View',
    children: taprootUi
  }
}

const taprootHelpers: Record<string, AddonHelper> = {
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
  signDemo: signDemo as AddonHelper
}

export const taprootAddon: Addon = {
  manifest: taprootManifest,
  helpers: taprootHelpers
}
