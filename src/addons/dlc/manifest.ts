import type {Addon, AddonHelper, AddonManifest, UiNode} from '../types'
import {schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {
  generateOracleKeypair,
  generateNonce,
  outcomePoint,
  attest,
  verifyAttestation,
  attestationScalar,
  type OracleKeypair,
  type Attestation
} from './dlc'
import {compileLeaf, type CompiledLeaf} from '../taproot/taproot'

// DLC (Discreet Log Contract) playground - a "play around" sandbox for the
// oracle math a real bet is built from, same posture as the sibling
// taproot/musig2 playgrounds: permissions: [] below is load-bearing, this
// addon declares zero verbs, so it cannot touch a real note, mint, or
// address regardless of what a holder pastes into it. All key material
// (both the oracle's and the nonce's) lives in this addon's own
// page-local state, never persisted, gone on reload.
//
// See dlc.ts's own top comment for the actual cryptography and its
// sources. See the sibling `betlocker` addon for locking a REAL note to
// one of these outcome points.

const trimmed = (v: unknown): string => String(v ?? '').trim()

// ---- outcome list ----

const canAddOutcome = (outcomes: unknown, input: unknown): boolean => {
  const list = Array.isArray(outcomes) ? (outcomes as string[]) : []
  const value = trimmed(input)
  return value !== '' && !list.includes(value)
}

// a checkmark on whichever outcome button is currently selected - the
// outcomes list is already fixed and known once added above, so "which
// one happened" is a selection among THESE exact values, not free text
// that could drift from what's actually shown per-row below
const outcomeButtonLabel = (item: unknown, selected: unknown): string =>
  item === selected ? `✓ ${String(item)}` : String(item)

// ---- per-outcome leaf preview - reuses the taproot addon's own `pk`
// template directly (an outcome point is just a 32-byte x-only pubkey) ----

const compiledFor = (
  oracle: unknown,
  nonce: unknown,
  outcome: unknown
): CompiledLeaf | null => {
  const oraclePubkeyHex = trimmed((oracle as OracleKeypair | null)?.pubkeyHex)
  const nonceHex = trimmed((nonce as OracleKeypair | null)?.pubkeyHex)
  if (!oraclePubkeyHex || !nonceHex || !trimmed(outcome)) return null
  try {
    const pubkeyHex = outcomePoint(oraclePubkeyHex, nonceHex, String(outcome))
    return compileLeaf('pk', {
      pubkeyHex,
      pubkey2Hex: '',
      hashHex: '',
      locktime: 0
    })
  } catch {
    return null
  }
}

const outcomePointFor = (
  oracle: unknown,
  nonce: unknown,
  outcome: unknown
): string => {
  const oraclePubkeyHex = trimmed((oracle as OracleKeypair | null)?.pubkeyHex)
  const nonceHex = trimmed((nonce as OracleKeypair | null)?.pubkeyHex)
  if (!oraclePubkeyHex || !nonceHex || !trimmed(outcome)) return '-'
  try {
    return outcomePoint(oraclePubkeyHex, nonceHex, String(outcome))
  } catch {
    return '-'
  }
}

const rowOpcodes = (
  oracle: unknown,
  nonce: unknown,
  outcome: unknown
): string => compiledFor(oracle, nonce, outcome)?.opcodes ?? '-'

const rowLeafHash = (
  oracle: unknown,
  nonce: unknown,
  outcome: unknown
): string => compiledFor(oracle, nonce, outcome)?.leafHashHex ?? '-'

// ---- simulating the oracle ----

const canAttest = (
  oracle: unknown,
  nonce: unknown,
  outcomes: unknown
): boolean =>
  !!(oracle as OracleKeypair | null)?.secretKeyHex &&
  !!(nonce as OracleKeypair | null)?.secretKeyHex &&
  Array.isArray(outcomes) &&
  outcomes.length > 0

// a hand-edited pubkeyHex (pasting a real external oracle's value over a
// generated one) must not silently attest with the now-mismatched
// generated secret - that would produce an attestation that fails to
// verify against the field actually shown, confusingly. Cheap to check
// (one pubkey derivation) since this only runs on a deliberate click.
const matchesSecret = (keypair: OracleKeypair): boolean =>
  keypair.pubkeyHex ===
  bytesToHex(schnorr.getPublicKey(hexToBytes(keypair.secretKeyHex)))

const attestTo = (
  oracle: unknown,
  nonce: unknown,
  outcome: unknown
): Attestation => {
  const o = oracle as OracleKeypair
  const n = nonce as OracleKeypair
  if (!matchesSecret(o)) {
    throw new Error(
      "The oracle pubkey shown no longer matches its generated secret key (did you paste over it?) - click 'Generate oracle keypair' again, or attest externally."
    )
  }
  if (!matchesSecret(n)) {
    throw new Error(
      "The nonce shown no longer matches its generated secret (did you paste over it?) - click 'Generate nonce' again, or attest externally."
    )
  }
  return attest(o.secretKeyHex, n.secretKeyHex, String(outcome))
}

// ---- checking redeemability from the holder's side (no secret keys
// needed here - only what a real redeemer would ever see: the
// announcement and a published attestation) ----

const isRedeemable = (
  oracle: unknown,
  nonce: unknown,
  outcome: unknown,
  attestation: unknown
): boolean => {
  if (!attestation) return false
  const oraclePubkeyHex = trimmed((oracle as OracleKeypair | null)?.pubkeyHex)
  const nonceHex = trimmed((nonce as OracleKeypair | null)?.pubkeyHex)
  if (!oraclePubkeyHex || !nonceHex) return false
  const a = attestation as Attestation
  return (
    a.outcome === outcome && verifyAttestation(oraclePubkeyHex, nonceHex, a)
  )
}

const redeemingScalar = (attestation: unknown): string => {
  const a = attestation as Attestation | null
  if (!a) return '-'
  try {
    return attestationScalar(a.signatureHex)
  } catch {
    return '-'
  }
}

const outcomeRow: UiNode = {
  type: 'View',
  style: 'row',
  children: [
    {type: 'Text', value: {var: 'item'}, style: 'subheading'},
    {
      type: 'Text',
      value: {
        cat: [
          'Outcome point: ',
          {
            helper: 'outcomePointFor',
            args: [{var: 'oracle'}, {var: 'nonce'}, {var: 'item'}]
          }
        ]
      },
      style: 'response-block'
    },
    {
      type: 'Text',
      value: {
        cat: [
          'Leaf (existing pk template): ',
          {
            helper: 'rowOpcodes',
            args: [{var: 'oracle'}, {var: 'nonce'}, {var: 'item'}]
          }
        ]
      }
    },
    {
      type: 'Text',
      value: {
        cat: [
          'TapLeaf hash: ',
          {
            helper: 'rowLeafHash',
            args: [{var: 'oracle'}, {var: 'nonce'}, {var: 'item'}]
          }
        ]
      }
    },
    {
      type: 'Show',
      when: {
        helper: 'isRedeemable',
        args: [
          {var: 'oracle'},
          {var: 'nonce'},
          {var: 'item'},
          {var: 'attestation'}
        ]
      },
      children: [
        {
          type: 'Text',
          value: {
            cat: [
              '✓ Redeemable now - revealed key: ',
              {helper: 'redeemingScalar', args: [{var: 'attestation'}]}
            ]
          },
          style: 'response-block'
        }
      ]
    },
    {
      type: 'Button',
      label: 'Remove',
      onClick: {action: 'removeAt', path: 'outcomes', index: {var: 'index'}}
    }
  ]
}

const builderUi: UiNode[] = [
  {type: 'Text', value: '1. The oracle', style: 'subheading'},
  {
    type: 'Text',
    value:
      'An oracle is just a pubkey plus a per-event nonce, published ahead of time. Generate both here to play with the full loop yourself, or paste in a real oracle’s own published values (no secret key needed just to compute outcome points or check a real attestation).'
  },
  {
    type: 'Button',
    label: 'Generate oracle keypair',
    onClick: {
      action: 'set',
      path: 'oracle',
      value: {helper: 'generateOracleKeypair', args: []}
    }
  },
  {
    type: 'Input',
    bind: 'oracle.pubkeyHex',
    label: 'Oracle pubkey (32-byte hex)'
  },
  {
    type: 'Button',
    label: 'Generate nonce',
    onClick: {
      action: 'set',
      path: 'nonce',
      value: {helper: 'generateNonce', args: []}
    }
  },
  {type: 'Input', bind: 'nonce.pubkeyHex', label: 'Nonce (32-byte hex)'},

  {type: 'Text', value: '2. Possible outcomes', style: 'subheading'},
  {
    type: 'Text',
    value:
      'Add every outcome this event could resolve to. Each one’s own leaf compiles and previews live below, before the event ever resolves - that’s the whole point: everyone can agree on the contract terms up front.'
  },
  {type: 'For', each: {var: 'outcomes'}, children: [outcomeRow]},
  {
    type: 'Input',
    bind: 'newOutcome',
    label: 'Outcome (e.g. "yes", "Lakers win")'
  },
  {
    type: 'Show',
    when: {
      helper: 'canAddOutcome',
      args: [{var: 'outcomes'}, {var: 'newOutcome'}]
    },
    children: [
      {
        type: 'Button',
        label: 'Add outcome',
        onClick: {
          action: 'push',
          path: 'outcomes',
          value: {var: 'newOutcome'}
        }
      }
    ]
  },

  {
    type: 'Text',
    value: '3. Simulate the oracle (optional)',
    style: 'subheading'
  },
  {
    type: 'Text',
    value:
      'Only possible when you generated the oracle and nonce above yourself (a real oracle keeps its secret key to itself - you’d wait for it to publish an attestation instead). Pick whichever outcome "actually happened" and attest to it.'
  },
  {
    type: 'Show',
    when: {
      helper: 'canAttest',
      args: [{var: 'oracle'}, {var: 'nonce'}, {var: 'outcomes'}]
    },
    children: [
      {type: 'Text', value: 'Which outcome happened?'},
      {
        type: 'View',
        style: 'row',
        children: [
          {
            type: 'For',
            each: {var: 'outcomes'},
            children: [
              {
                type: 'Button',
                label: {
                  helper: 'outcomeButtonLabel',
                  args: [{var: 'item'}, {var: 'outcomeToAttest'}]
                },
                onClick: {
                  action: 'set',
                  path: 'outcomeToAttest',
                  value: {var: 'item'}
                }
              }
            ]
          }
        ]
      },
      {
        type: 'Button',
        label: 'Attest',
        onClick: {
          action: 'set',
          path: 'attestation',
          value: {
            helper: 'attestTo',
            args: [{var: 'oracle'}, {var: 'nonce'}, {var: 'outcomeToAttest'}]
          }
        }
      },
      {
        type: 'Show',
        when: {var: 'attestation'},
        children: [
          {
            type: 'Text',
            value: {
              cat: [
                'Attestation signature: ',
                {var: 'attestation.signatureHex'}
              ]
            },
            style: 'response-block'
          },
          {
            type: 'Button',
            label: 'Copy',
            onClick: {
              verb: 'clipboard.copy',
              args: {text: {var: 'attestation.signatureHex'}}
            }
          }
        ]
      }
    ]
  }
]

const docsUi: UiNode[] = [
  {type: 'Text', value: 'How a DLC oracle works', style: 'subheading'},
  {
    type: 'List',
    ordered: true,
    each: [
      'An oracle publishes its pubkey P and a fresh nonce R for one specific future event, plus the list of outcomes it will eventually attest to - all of this BEFORE the event resolves.',
      'Anyone can now compute, for any outcome m, its own "outcome point" T = R + e·P (e is a tagged hash of R, P and m) - a real 32-byte pubkey, the same shape as any other. Nothing about the actual result is known yet.',
      'When the event resolves, the oracle signs whichever outcome really happened - a real BIP340 signature (R, s) using the SAME nonce it already announced. That signature satisfies s·G = T: s is now a real private key for that one outcome’s point.',
      'Every OTHER outcome never gets signed, so nobody ever learns a private key for its point - not because the oracle chooses not to reveal it, but because the discrete log problem makes it infeasible to compute without the signature.',
      'A leaf locked to an outcome point (the sibling `betlocker` addon does exactly this, via the same `pk` template shown above) becomes signable the instant - and only the instant - the oracle attests to that outcome.'
    ],
    children: [{type: 'Text', value: {var: 'item'}}]
  },
  {
    type: 'Text',
    value:
      'This is a single-oracle model: whoever holds that one oracle’s secret key can attest to anything it likes, honestly or not - the same trust you’re placing in any one source of truth. Multi-oracle threshold schemes (2-of-3 oracles must agree) exist and are a real DLC feature, just not this playground’s.'
  }
]

const dlcManifest: AddonManifest = {
  id: 'dlc',
  name: 'DLC Playground',
  version: '1',
  icon: 'telescope',
  experimental: true,
  description:
    'Play around with Discreet Log Contract oracle math - compute outcome points, simulate an oracle attesting to an event, and watch a leaf go from inert to signable. A sandbox, never wired into this wallet’s own notes. See the sibling Betlocker addon for a real bet.',
  permissions: [],
  nav: {position: 'right', icon: 'telescope', label: 'DLC'},
  state: {
    // plain objects from the start, never null - both are bound directly
    // by an Input below (oracle.pubkeyHex/nonce.pubkeyHex), and Solid's
    // store setter needs a real object to descend into for a nested path
    // to be writable at all. (Contrast the sibling taproot addon's own
    // `generated` field, which stays null until first written - safe
    // there only because it's read-only, via Text, never an Input target.)
    oracle: {secretKeyHex: '', pubkeyHex: ''},
    nonce: {secretKeyHex: '', pubkeyHex: ''},
    outcomes: [],
    newOutcome: '',
    outcomeToAttest: '',
    attestation: null
  },
  ui: {
    type: 'View',
    children: [
      {type: 'Text', value: 'DLC Playground', style: 'heading'},
      {
        type: 'View',
        style: 'columns',
        children: [
          {type: 'View', style: 'col-left', children: builderUi},
          {type: 'View', style: 'col-right', children: docsUi}
        ]
      }
    ]
  }
}

const dlcHelpers: Record<string, AddonHelper> = {
  generateOracleKeypair: generateOracleKeypair as AddonHelper,
  generateNonce: generateNonce as AddonHelper,
  canAddOutcome: canAddOutcome as AddonHelper,
  outcomeButtonLabel: outcomeButtonLabel as AddonHelper,
  outcomePointFor: outcomePointFor as AddonHelper,
  rowOpcodes: rowOpcodes as AddonHelper,
  rowLeafHash: rowLeafHash as AddonHelper,
  canAttest: canAttest as AddonHelper,
  attestTo: attestTo as AddonHelper,
  isRedeemable: isRedeemable as AddonHelper,
  redeemingScalar: redeemingScalar as AddonHelper
}

export const dlcAddon: Addon = {
  manifest: dlcManifest,
  helpers: dlcHelpers
}
