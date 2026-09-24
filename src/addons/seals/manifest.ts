import type {Addon, AddonHelper, AddonManifest, UiNode} from '../types'
import {schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {
  consignmentProblem,
  decodeSealConsignment,
  encodeSealConsignment,
  genesisState,
  planSealLock,
  type SealState
} from './seals'

// Seals: prove and transfer ownership of an off-chain, non-fungible
// "asset" using an LNURLcash note as its bearer anchor - RGB/Taproot
// Assets' own core idea (state lives off-chain, a taproot commitment
// binds it to something spendable, every holder validates the WHOLE
// history themselves rather than trusting whoever handed it to them)
// adapted to bearer notes instead of real on-chain UTXOs. See seals.ts's
// own top comment for the full design and its honest limitations -
// particularly: transfers always go to a NAMED recipient (never
// race-to-claim), and an unredeemed transition is a promise, not a
// guarantee, until it actually lands at the mint.
//
// Two independent things happen here, deliberately kept separate:
//   ISSUE - create a brand new seal (note.lockToPubkey to a fresh
//   genesis leaf).
//   MANAGE - paste ANY consignment (your own, or someone else's) to
//   client-side validate its whole history for free, with no permission
//   and no secret needed at all; ONLY if you also enter the current
//   state's own owner secret key does a "transition to a new owner"
//   option appear.
//
// This addon never adds a Seal's own note to this wallet's Bearer list -
// see verbs.ts's own seal.transition for why (redeeming it later needs
// the NEXT owner's own secret key, which whoever transitions it never
// sees). The consignment itself is the one thing that carries custody
// forward - keep it, same as every other addon's own receipt in this
// wallet.

const xOnlyPubkeyHex = (value: unknown): string => {
  const v = String(value ?? '')
    .trim()
    .toLowerCase()
  if (/^[0-9a-f]{64}$/.test(v)) return v
  if (/^0[23][0-9a-f]{64}$/.test(v)) return v.slice(2)
  return v
}

type LockedNote = {
  urlTemplate: string
  amountMsat: number
  signature: string
  groupPubkeyHex: string
}

// ---- Issue ----

type GenesisPlan = {state: SealState; outputKeyHex: string}

const prepareGenesis = (
  name: unknown,
  description: unknown,
  ownerPubkeyHex: unknown
): GenesisPlan => {
  const state = genesisState(name, description, xOnlyPubkeyHex(ownerPubkeyHex))
  return {state, outputKeyHex: planSealLock(state).outputKeyHex}
}

const issuedConsignment = (
  issuedNote: unknown,
  genesisPlan: unknown
): string | null => {
  const plan = genesisPlan as GenesisPlan | null
  if (!plan) return null
  return encodeSealConsignment(issuedNote, [plan.state])
}

const issuedConsignmentText = (
  issuedNote: unknown,
  genesisPlan: unknown
): string => {
  const plan = genesisPlan as GenesisPlan | null
  const locked = issuedNote as LockedNote | null
  const consignment = plan
    ? encodeSealConsignment(issuedNote, [plan.state])
    : null
  if (!consignment || !plan || !locked) return ''
  return [
    'Seals consignment',
    `Asset: ${plan.state.name}`,
    plan.state.description ? `Description: ${plan.state.description}` : '',
    `Owner pubkey: ${plan.state.ownerPubkeyHex}`,
    'This consignment carries the WHOLE ownership history - validate it',
    'yourself (never just trust who handed it to you) before relying on it.',
    '',
    consignment
  ]
    .filter(Boolean)
    .join('\n')
}

const issueUi: UiNode[] = [
  {type: 'Text', value: 'Issue a new seal', style: 'subheading'},
  {
    type: 'Show',
    when: {helper: 'not', args: [{var: 'issuedNote'}]},
    children: [
      {type: 'Input', bind: 'name', label: 'Asset name'},
      {type: 'Input', bind: 'description', label: 'Description (optional)'},
      {type: 'Text', value: 'First owner'},
      {
        type: 'Input',
        bind: 'firstOwnerAddress',
        label: 'Their Lightning Address, cx1/cp1 address, or username'
      },
      {
        type: 'NotePicker',
        bind: 'selectedNote',
        filter: {spent: false},
        label: 'Note to lock (becomes this seal’s own bearer anchor)'
      },
      {
        type: 'Button',
        label: 'Resolve owner pubkey',
        onClick: {
          verb: 'note.resolveAddressPubkey',
          args: {
            address: {var: 'firstOwnerAddress'},
            mintNote: {var: 'selectedNote.id'}
          },
          result: 'firstOwnerPubkeyHex'
        }
      },
      {
        type: 'Show',
        when: {var: 'firstOwnerPubkeyHex'},
        children: [
          {
            type: 'Text',
            value: {
              cat: [
                'Owner pubkey: ',
                {helper: 'xOnlyPubkeyHex', args: [{var: 'firstOwnerPubkeyHex'}]}
              ]
            },
            style: 'response-block'
          }
        ]
      },
      {
        type: 'Show',
        when: {
          and: [
            {var: 'name'},
            {var: 'firstOwnerPubkeyHex'},
            {var: 'selectedNote'}
          ]
        },
        children: [
          {
            type: 'Button',
            label: 'Prepare',
            onClick: {
              action: 'set',
              path: 'genesisPlan',
              value: {
                helper: 'prepareGenesis',
                args: [
                  {var: 'name'},
                  {var: 'description'},
                  {var: 'firstOwnerPubkeyHex'}
                ]
              }
            }
          }
        ]
      },
      {
        type: 'Show',
        when: {var: 'genesisPlan'},
        children: [
          {
            type: 'Text',
            value: {
              cat: [
                'Will lock to output key: ',
                {var: 'genesisPlan.outputKeyHex'}
              ]
            },
            style: 'response-block'
          },
          {
            type: 'Text',
            value:
              'Locking cannot be undone. Only whoever holds the owner pubkey’s own secret key will ever be able to transition or cash out this seal.'
          },
          {
            type: 'Button',
            label: 'Issue',
            onClick: {
              verb: 'note.lockToPubkey',
              args: {
                note: {var: 'selectedNote.id'},
                pubkeyHex: {var: 'genesisPlan.outputKeyHex'}
              },
              result: 'issuedNote'
            }
          },
          {
            type: 'Button',
            label: 'Start over',
            onClick: {action: 'set', path: 'genesisPlan', value: null}
          }
        ]
      }
    ]
  },
  {
    type: 'Show',
    when: {var: 'issuedNote'},
    children: [
      {type: 'Text', value: '✓ Seal issued', style: 'subheading'},
      {
        type: 'Text',
        value:
          'Hand this consignment to the first owner. It carries the whole (so far one-state) history - they validate it themselves before relying on it, in the Manage section below or in their own wallet.'
      },
      {
        type: 'Text',
        value: {
          helper: 'issuedConsignment',
          args: [{var: 'issuedNote'}, {var: 'genesisPlan'}]
        },
        style: 'response-block'
      },
      {
        type: 'Button',
        label: 'Copy consignment',
        onClick: {
          verb: 'clipboard.copy',
          args: {
            text: {
              helper: 'issuedConsignment',
              args: [{var: 'issuedNote'}, {var: 'genesisPlan'}]
            }
          }
        }
      },
      {
        type: 'Button',
        label: 'Download consignment',
        onClick: {
          verb: 'file.download',
          args: {
            filename: 'seal-consignment.txt',
            content: {
              helper: 'issuedConsignmentText',
              args: [{var: 'issuedNote'}, {var: 'genesisPlan'}]
            }
          }
        }
      },
      {
        type: 'Button',
        label: 'Issue another seal',
        onClick: {action: 'set', path: 'issuedNote', value: null}
      }
    ]
  }
]

// ---- Manage / verify / transition ----

const parsedStatesOf = (consignmentInput: unknown): SealState[] =>
  decodeSealConsignment(consignmentInput)?.states ?? []

const currentStateOf = (consignmentInput: unknown): SealState | null => {
  const states = parsedStatesOf(consignmentInput)
  return states.length ? states[states.length - 1]! : null
}

// whether an address you resolved (note.resolveAddressPubkey, the SAME
// verb the Lock side already uses to name an owner) actually matches this
// consignment's own CURRENT owner - lets a holder check "is this mine?"
// by resolving their own identity rather than eyeballing two 64-character
// hex strings against each other. Purely a convenience/confirmation: it
// can never fill in a secret key (this wallet's addons never touch the
// real seed - see this file's own top comment), so "yes, this is you"
// still means going on to paste your own secret key by hand below.
const isCurrentOwner = (
  consignmentInput: unknown,
  resolvedPubkeyHex: unknown
): boolean => {
  const current = currentStateOf(consignmentInput)
  const resolved = xOnlyPubkeyHex(resolvedPubkeyHex)
  return !!current && !!resolved && current.ownerPubkeyHex === resolved
}

const consignmentValid = (consignmentInput: unknown): boolean =>
  !!String(consignmentInput ?? '').trim() &&
  !consignmentProblem(consignmentInput)

const stateLine = (item: unknown): string => {
  const s = item as SealState | null
  if (!s) return ''
  return `#${s.stateIndex} - owner ${s.ownerPubkeyHex}`
}

const consignmentSummary = (consignmentInput: unknown): string => {
  const genesis = parsedStatesOf(consignmentInput)[0]
  if (!genesis) return ''
  return `${genesis.name}${genesis.description ? ` - ${genesis.description}` : ''}`
}

// whether the entered secret key actually matches the CURRENT owner - the
// gate for showing the "transition" section at all. Derives the pubkey
// the same way redeemCurrentStateCw1 itself does, just as a live-binding
// check here rather than inside the eventual verb call.
const canTransition = (
  consignmentInput: unknown,
  ownerSecretKeyHex: unknown
): boolean => {
  const current = currentStateOf(consignmentInput)
  const secret = String(ownerSecretKeyHex ?? '')
    .trim()
    .toLowerCase()
  if (!current || !/^[0-9a-f]{64}$/i.test(secret)) return false
  try {
    return (
      bytesToHex(schnorr.getPublicKey(hexToBytes(secret))) ===
      current.ownerPubkeyHex
    )
  } catch {
    return false
  }
}

const nextConsignment = (
  consignmentInput: unknown,
  transitionResult: unknown
): string | null => {
  const parsed = decodeSealConsignment(consignmentInput)
  const result = transitionResult as {
    urlTemplate: string
    amountMsat: number
    state: SealState
  } | null
  if (!parsed || !result) return null
  return encodeSealConsignment(
    {urlTemplate: result.urlTemplate, amountMsat: result.amountMsat},
    [...parsed.states, result.state]
  )
}

const manageUi: UiNode[] = [
  {type: 'Text', value: 'Manage or verify a seal', style: 'subheading'},
  {
    type: 'Text',
    value:
      'Paste ANY consignment - your own, or one someone handed you - to validate its whole history yourself. No permission, no secret, and no network call needed just to check it.'
  },
  {type: 'Input', bind: 'consignmentInput', label: 'Consignment'},
  {
    type: 'Show',
    when: {helper: 'consignmentProblem', args: [{var: 'consignmentInput'}]},
    children: [
      {
        type: 'Text',
        value: {helper: 'consignmentProblem', args: [{var: 'consignmentInput'}]}
      }
    ]
  },
  {
    type: 'Show',
    when: {helper: 'consignmentValid', args: [{var: 'consignmentInput'}]},
    children: [
      {
        type: 'Text',
        value: {
          cat: [
            '✓ Valid history - ',
            {helper: 'consignmentSummary', args: [{var: 'consignmentInput'}]}
          ]
        },
        style: 'response-block'
      },
      {
        type: 'List',
        ordered: true,
        each: {helper: 'parsedStatesOf', args: [{var: 'consignmentInput'}]},
        children: [
          {type: 'Text', value: {helper: 'stateLine', args: [{var: 'item'}]}}
        ]
      },
      {type: 'Text', value: 'Is this seal currently yours?'},
      {
        type: 'Input',
        bind: 'myAddress',
        label: 'Your Lightning Address, cx1/cp1 address, or username'
      },
      {
        type: 'Button',
        label: 'Check ownership',
        onClick: {
          verb: 'note.resolveAddressPubkey',
          args: {address: {var: 'myAddress'}},
          result: 'myResolvedPubkeyHex'
        }
      },
      {
        type: 'Show',
        when: {var: 'myResolvedPubkeyHex'},
        children: [
          {
            type: 'Show',
            when: {
              helper: 'isCurrentOwner',
              args: [{var: 'consignmentInput'}, {var: 'myResolvedPubkeyHex'}]
            },
            children: [
              {
                type: 'Text',
                value:
                  '✓ This seal is currently yours - enter your own secret key below to transition or cash it out.',
                style: 'response-block'
              }
            ]
          },
          {
            type: 'Show',
            when: {
              helper: 'not',
              args: [
                {
                  helper: 'isCurrentOwner',
                  args: [
                    {var: 'consignmentInput'},
                    {var: 'myResolvedPubkeyHex'}
                  ]
                }
              ]
            },
            children: [
              {
                type: 'Text',
                value:
                  'Not currently yours - someone else owns this seal right now.'
              }
            ]
          }
        ]
      },
      {type: 'Text', value: 'Transition to a new owner', style: 'subheading'},
      {
        type: 'Text',
        value:
          'Only possible if you hold the CURRENT owner’s own secret key. Never transmitted anywhere; used only to sign locally.'
      },
      {
        type: 'Input',
        bind: 'ownerSecretKeyHex',
        label: 'Your secret key (32-byte hex)'
      },
      {
        type: 'Show',
        when: {
          helper: 'canTransition',
          args: [{var: 'consignmentInput'}, {var: 'ownerSecretKeyHex'}]
        },
        children: [
          {
            type: 'Input',
            bind: 'nextOwnerAddress',
            label: 'Next owner’s address'
          },
          {
            type: 'Button',
            label: 'Resolve next owner pubkey',
            onClick: {
              verb: 'note.resolveAddressPubkey',
              args: {address: {var: 'nextOwnerAddress'}},
              result: 'nextOwnerPubkeyHex'
            }
          },
          {
            type: 'Show',
            when: {var: 'nextOwnerPubkeyHex'},
            children: [
              {
                type: 'Text',
                value: {
                  cat: [
                    'Next owner: ',
                    {
                      helper: 'xOnlyPubkeyHex',
                      args: [{var: 'nextOwnerPubkeyHex'}]
                    }
                  ]
                },
                style: 'response-block'
              },
              {
                type: 'Button',
                label: 'Transition',
                onClick: {
                  verb: 'seal.transition',
                  args: {
                    urlTemplate: {
                      helper: 'consignmentUrlTemplateOf',
                      args: [{var: 'consignmentInput'}]
                    },
                    currentState: {
                      helper: 'currentStateOf',
                      args: [{var: 'consignmentInput'}]
                    },
                    ownerSecretKeyHex: {var: 'ownerSecretKeyHex'},
                    amountMsat: {
                      helper: 'consignmentAmountOf',
                      args: [{var: 'consignmentInput'}]
                    },
                    nextOwnerPubkeyHex: {
                      helper: 'xOnlyPubkeyHex',
                      args: [{var: 'nextOwnerPubkeyHex'}]
                    }
                  },
                  result: 'transitionResult'
                }
              }
            ]
          }
        ]
      },
      {
        type: 'Show',
        when: {var: 'transitionResult'},
        children: [
          {type: 'Text', value: '✓ Transitioned', style: 'subheading'},
          {
            type: 'Text',
            value:
              'Hand this new consignment to the next owner - it carries the FULL history, including this transition.'
          },
          {
            type: 'Text',
            value: {
              helper: 'nextConsignment',
              args: [{var: 'consignmentInput'}, {var: 'transitionResult'}]
            },
            style: 'response-block'
          },
          {
            type: 'Button',
            label: 'Copy consignment',
            onClick: {
              verb: 'clipboard.copy',
              args: {
                text: {
                  helper: 'nextConsignment',
                  args: [{var: 'consignmentInput'}, {var: 'transitionResult'}]
                }
              }
            }
          }
        ]
      }
    ]
  }
]

const consignmentUrlTemplateOf = (consignmentInput: unknown): string =>
  decodeSealConsignment(consignmentInput)?.urlTemplate ?? ''

const consignmentAmountOf = (consignmentInput: unknown): number =>
  decodeSealConsignment(consignmentInput)?.amountMsat ?? 0

const docsUi: UiNode[] = [
  {type: 'Text', value: 'How it works', style: 'subheading'},
  {
    type: 'List',
    ordered: true,
    each: [
      'Issue: name an asset, resolve its first owner’s pubkey, and lock one of your own notes to it - that note becomes the seal’s own bearer anchor, committed via a taproot leaf (the same `hashlock` template this wallet’s taproot addon already uses).',
      'Hand the consignment to the owner - the mint’s own note details plus the full state history, nothing secret.',
      'Anyone - the owner, a future buyer, an auditor - can validate that whole history themselves, offline, for free: does it chain together correctly, does the asset’s own identity ever change (it must not).',
      'To transition, the current owner reveals their own current state and signs with their own key, in the same step rotating the note directly into a fresh leaf committing to the next owner. A new consignment goes out carrying the extended history.'
    ],
    children: [{type: 'Text', value: {var: 'item'}}]
  },
  {
    type: 'Text',
    value:
      'Not RGB-protocol-compatible - no real UTXOs, no consignment-format interop, no relay network. What’s borrowed is the IDEA (state off-chain, a taproot commitment as the anchor, client-side validation instead of trusting a sender) adapted to this wallet’s own bearer notes.'
  },
  {
    type: 'Text',
    value:
      'Honest limits: transfers always name a specific next owner - there is no race-to-claim path here. An unredeemed transition is a promise, not a guarantee, until it actually lands at the mint - the underlying note can still only be redeemed once. And today’s consignment proves the presented history is internally self-consistent, not yet that every past transition was independently mint-certified.'
  }
]

const sealsManifest: AddonManifest = {
  id: 'seals',
  name: 'Seals',
  version: '1',
  icon: 'fingerprint',
  experimental: true,
  description:
    'Prove and transfer ownership of an off-chain asset, RGB/Taproot-Assets-style - a taproot commitment anchors it to an LNURLcash note, and every holder client-side validates the whole history rather than trusting whoever handed it to them.',
  permissions: [
    {
      verb: 'note.lockToPubkey',
      scope: 'spent:false',
      reason: 'Issue a new seal by locking one of your own notes to it'
    },
    {
      verb: 'note.resolveAddressPubkey',
      reason:
        'Resolve a Lightning Address/cx1/cp1/username into a pubkey, to name a seal’s owner, or to check whether a seal is currently yours'
    },
    {
      verb: 'seal.transition',
      reason:
        'Transition a seal you currently own to a new owner, once you enter your own secret key'
    },
    {verb: 'clipboard.copy', reason: 'Copy a consignment'},
    {verb: 'file.download', reason: 'Save a consignment file'}
  ],
  nav: {position: 'right', icon: 'fingerprint', label: 'Seals'},
  state: {
    name: '',
    description: '',
    firstOwnerAddress: '',
    firstOwnerPubkeyHex: '',
    selectedNote: null,
    genesisPlan: null,
    issuedNote: null,
    consignmentInput: '',
    myAddress: '',
    myResolvedPubkeyHex: '',
    ownerSecretKeyHex: '',
    nextOwnerAddress: '',
    nextOwnerPubkeyHex: '',
    transitionResult: null
  },
  ui: {
    type: 'View',
    children: [
      {type: 'Text', value: 'Seals', style: 'heading'},
      {
        type: 'View',
        style: 'columns',
        children: [
          {
            type: 'View',
            style: 'col-left',
            children: [...issueUi, ...manageUi]
          },
          {type: 'View', style: 'col-right', children: docsUi}
        ]
      }
    ]
  }
}

const sealsHelpers: Record<string, AddonHelper> = {
  xOnlyPubkeyHex: xOnlyPubkeyHex as AddonHelper,
  prepareGenesis: prepareGenesis as AddonHelper,
  issuedConsignment: issuedConsignment as AddonHelper,
  issuedConsignmentText: issuedConsignmentText as AddonHelper,
  consignmentProblem: consignmentProblem as AddonHelper,
  consignmentValid: consignmentValid as AddonHelper,
  consignmentSummary: consignmentSummary as AddonHelper,
  parsedStatesOf: parsedStatesOf as AddonHelper,
  currentStateOf: currentStateOf as AddonHelper,
  isCurrentOwner: isCurrentOwner as AddonHelper,
  stateLine: stateLine as AddonHelper,
  canTransition: canTransition as AddonHelper,
  consignmentUrlTemplateOf: consignmentUrlTemplateOf as AddonHelper,
  consignmentAmountOf: consignmentAmountOf as AddonHelper,
  nextConsignment: nextConsignment as AddonHelper
}

export const sealsAddon: Addon = {
  manifest: sealsManifest,
  helpers: sealsHelpers
}
