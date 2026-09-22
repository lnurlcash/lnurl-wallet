import type {Addon, AddonHelper, AddonManifest, UiNode} from '../types'
import {toLud17w, toBech32Lnurl} from '../../lnurlcash'
import {
  betProblem,
  betReceiptUrl,
  parseBetReceipt,
  planBet,
  receiptProblem,
  type BetPlan,
  type BetReceipt
} from './betlock'

// Betlocker: lock one of your notes to the outcome of a real-world event,
// via a Discreet Log Contract oracle - the sibling `timelocker` addon, but
// the condition is "an oracle attests to X" instead of "a date has
// passed". See the sibling `dlc` addon for the oracle cryptography itself
// (build an announcement there first, or paste in a real one), and
// betlock.ts's own top comment for exactly why this is a genuine two-step
// flow (LOCK now, REDEEM only once an attestation exists) where
// timelocker's own equivalent collapses to one.
//
// Deliberately race-to-claim, not counterparty-bound: a leaf is
// `<outcome point> CHECKSIG` alone, with no combination against a specific
// winner's own key. Once the oracle attests, whoever redeems first gets
// the note - hand the lock's own receipt only to whoever should be able
// to claim it, and redeem promptly once you expect the oracle to have
// attested.

const problemOf = (
  oracle: unknown,
  nonce: unknown,
  outcomes: unknown
): string => betProblem(oracle, nonce, outcomes)

const noProblem = (
  oracle: unknown,
  nonce: unknown,
  outcomes: unknown
): boolean => betProblem(oracle, nonce, outcomes) === ''

const canAddOutcome = (outcomes: unknown, input: unknown): boolean => {
  const list = Array.isArray(outcomes) ? (outcomes as string[]) : []
  const value = String(input ?? '').trim()
  return value !== '' && !list.includes(value)
}

type LockedNote = {
  urlTemplate: string
  amountMsat: number
  signature: string
  groupPubkeyHex: string
}

// lnurlw:// (LUD-17), optionally the classic LUD-01 bech32 encoding - same
// pair of toggles the sibling timelocker addon offers, same reasoning
const receiptUrlFor = (
  lockedNote: unknown,
  plan: unknown,
  bech32: unknown
): string | null => {
  const url = betReceiptUrl(lockedNote, plan)
  if (!url) return null
  const plain = toLud17w(url)
  return bech32 ? toBech32Lnurl(plain) : plain
}

const receiptText = (lockedNote: unknown, plan: unknown): string => {
  const locked = lockedNote as LockedNote | null
  const p = plan as BetPlan | null
  const url = betReceiptUrl(lockedNote, plan)
  if (!url || !locked || !p) return ''
  return [
    'Betlocker receipt',
    `Amount: ${Math.floor(locked.amountMsat / 1000)} sats`,
    `Outcomes: ${p.outcomes.join(', ')}`,
    'This receipt alone cannot redeem anything - you also need the',
    'oracle’s own published attestation for whichever outcome happens.',
    'Once the oracle attests, whoever redeems first gets the note - keep',
    'this receipt only if you’re the one who should be able to claim it.',
    '',
    toLud17w(url)
  ].join('\n')
}

// what a pasted receipt says about itself, live while typing/pasting
const receiptOutcomes = (value: unknown): string => {
  const receipt = parseBetReceipt(value)
  return receipt ? receipt.outcomes.join(', ') : ''
}

const canRedeem = (
  receiptInput: unknown,
  outcome: unknown,
  signatureHex: unknown
): boolean => {
  const receipt = parseBetReceipt(receiptInput)
  return (
    !!receipt &&
    receipt.outcomes.includes(String(outcome ?? '').trim()) &&
    /^[0-9a-f]{128}$/i.test(String(signatureHex ?? '').trim())
  )
}

const lockUi: UiNode[] = [
  {type: 'Text', value: 'Lock a note', style: 'subheading'},
  {
    type: 'Show',
    when: {helper: 'not', args: [{var: 'lockedNote'}]},
    children: [
      {
        type: 'NotePicker',
        bind: 'selectedNote',
        filter: {spent: false},
        label: 'Note to stake'
      },
      {
        type: 'Input',
        bind: 'oraclePubkeyHex',
        label: 'Oracle pubkey (32-byte hex - see the DLC addon)'
      },
      {
        type: 'Input',
        bind: 'nonceHex',
        label: 'Nonce for this event (32-byte hex)'
      },
      {
        type: 'For',
        each: {var: 'outcomes'},
        children: [
          {
            type: 'View',
            style: 'row',
            children: [
              {type: 'Text', value: {var: 'item'}},
              {
                type: 'Button',
                label: 'Remove',
                onClick: {
                  action: 'removeAt',
                  path: 'outcomes',
                  index: {var: 'index'}
                }
              }
            ]
          }
        ]
      },
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
        type: 'Show',
        when: {
          helper: 'problemOf',
          args: [{var: 'oraclePubkeyHex'}, {var: 'nonceHex'}, {var: 'outcomes'}]
        },
        children: [
          {
            type: 'Text',
            value: {
              helper: 'problemOf',
              args: [
                {var: 'oraclePubkeyHex'},
                {var: 'nonceHex'},
                {var: 'outcomes'}
              ]
            }
          }
        ]
      },
      {
        type: 'Show',
        when: {
          and: [
            {var: 'selectedNote'},
            {
              helper: 'noProblem',
              args: [
                {var: 'oraclePubkeyHex'},
                {var: 'nonceHex'},
                {var: 'outcomes'}
              ]
            }
          ]
        },
        children: [
          {
            type: 'Button',
            label: 'Prepare bet',
            onClick: {
              action: 'set',
              path: 'plan',
              value: {
                helper: 'planBet',
                args: [
                  {var: 'oraclePubkeyHex'},
                  {var: 'nonceHex'},
                  {var: 'outcomes'}
                ]
              }
            }
          }
        ]
      },
      {
        type: 'Show',
        when: {var: 'plan'},
        children: [
          {
            type: 'Text',
            value: {
              cat: ['Will lock to output key: ', {var: 'plan.outputKeyHex'}]
            },
            style: 'response-block'
          },
          {
            type: 'Text',
            value:
              'Locking cannot be undone. Nobody - including you - can produce a spendable secret for ANY outcome until the oracle actually attests to one.'
          },
          {
            type: 'Button',
            label: 'Lock this note',
            onClick: {
              verb: 'note.lockToPubkey',
              args: {
                note: {var: 'selectedNote.id'},
                pubkeyHex: {var: 'plan.outputKeyHex'},
                kind: 'ct1'
              },
              result: 'lockedNote'
            }
          },
          {
            type: 'Button',
            label: 'Start over',
            onClick: {action: 'set', path: 'plan', value: null}
          }
        ]
      }
    ]
  },
  {
    type: 'Show',
    when: {var: 'lockedNote'},
    children: [
      {type: 'Text', value: 'Bet locked', style: 'subheading'},
      {
        type: 'Text',
        value: {
          cat: [
            'Staked ',
            {helper: 'msatToSats', args: [{var: 'lockedNote.amountMsat'}]},
            ' sats on: ',
            {helper: 'outcomeList', args: [{var: 'plan'}]}
          ]
        }
      },
      {
        type: 'Input',
        bind: 'useBech32',
        kind: 'checkbox',
        label: 'Encode receipt as bech32 (LNURL1…)'
      },
      {
        type: 'Text',
        value:
          'Keep this receipt - it’s the only record of this bet. It cannot redeem anything by itself; you’ll also need the oracle’s own published attestation once the event resolves.'
      },
      {
        type: 'Text',
        value: {
          helper: 'receiptUrlFor',
          args: [{var: 'lockedNote'}, {var: 'plan'}, {var: 'useBech32'}]
        },
        style: 'response-block'
      },
      {
        type: 'Button',
        label: 'Copy receipt',
        onClick: {
          verb: 'clipboard.copy',
          args: {
            text: {
              helper: 'receiptUrlFor',
              args: [{var: 'lockedNote'}, {var: 'plan'}, {var: 'useBech32'}]
            }
          }
        }
      },
      {
        type: 'Button',
        label: 'Download receipt',
        onClick: {
          verb: 'file.download',
          args: {
            filename: 'betlocker-receipt.txt',
            content: {
              helper: 'receiptText',
              args: [{var: 'lockedNote'}, {var: 'plan'}]
            }
          }
        }
      },
      {
        type: 'Show',
        when: {helper: 'not', args: [{var: 'lockedNote.pubkeyVerified'}]},
        children: [
          {
            type: 'Text',
            value:
              "✗ could not verify the mint's certificate for this lock - keep the receipt, but check the note with the mint before relying on it."
          }
        ]
      },
      {
        type: 'Button',
        label: 'Lock another note',
        onClick: {action: 'set', path: 'lockedNote', value: null}
      }
    ]
  }
]

const redeemUi: UiNode[] = [
  {type: 'Text', value: 'Redeem a bet', style: 'subheading'},
  {type: 'Input', bind: 'receiptInput', label: 'Bet receipt'},
  {
    type: 'Show',
    when: {helper: 'receiptOutcomes', args: [{var: 'receiptInput'}]},
    children: [
      {
        type: 'Text',
        value: {
          cat: [
            'Outcomes: ',
            {helper: 'receiptOutcomes', args: [{var: 'receiptInput'}]}
          ]
        }
      }
    ]
  },
  {
    type: 'Show',
    when: {helper: 'receiptProblem', args: [{var: 'receiptInput'}]},
    children: [
      {
        type: 'Text',
        value: {helper: 'receiptProblem', args: [{var: 'receiptInput'}]}
      }
    ]
  },
  {
    type: 'Input',
    bind: 'attestOutcome',
    label: 'Which outcome did the oracle attest to?'
  },
  {
    type: 'Input',
    bind: 'attestSignatureHex',
    label: 'Oracle’s attestation signature (64-byte hex)'
  },
  {
    type: 'Show',
    when: {
      helper: 'canRedeem',
      args: [
        {var: 'receiptInput'},
        {var: 'attestOutcome'},
        {var: 'attestSignatureHex'}
      ]
    },
    children: [
      {
        type: 'Button',
        label: 'Redeem into wallet',
        onClick: {
          verb: 'note.redeemBet',
          args: {
            receiptUrl: {var: 'receiptInput'},
            outcome: {var: 'attestOutcome'},
            signatureHex: {var: 'attestSignatureHex'}
          },
          result: 'redeemResult'
        }
      }
    ]
  },
  {
    type: 'Show',
    when: {var: 'redeemResult'},
    children: [
      {
        type: 'Text',
        value: {
          cat: [
            '✓ Redeemed ',
            {helper: 'msatToSats', args: [{var: 'redeemResult.amountMsat'}]},
            ' sats into your wallet.'
          ]
        }
      }
    ]
  }
]

const docsUi: UiNode[] = [
  {type: 'Text', value: 'How it works', style: 'subheading'},
  {
    type: 'List',
    ordered: true,
    each: [
      'Build (or paste, from the sibling DLC addon) an oracle’s announcement: its pubkey, its nonce for this event, and every outcome the event could resolve to.',
      'Pick one of your own notes to stake, click ’Prepare bet’, then ’Lock this note’. It’s burned at the mint and re-issued as a taproot note with one leaf per outcome - nobody can spend ANY of them yet.',
      'Copy the receipt - it’s the only record of this bet, though it cannot redeem anything by itself.',
      'Once the event resolves and the oracle publishes its attestation (an outcome plus a signature), paste the receipt and the attestation here and redeem.'
    ],
    children: [{type: 'Text', value: {var: 'item'}}]
  },
  {
    type: 'Text',
    value:
      'Race-to-claim, by design: a leaf is just <outcome point> CHECKSIG, not bound to any specific counterparty’s own key. Once the oracle attests, whoever redeems first gets the note. The outcomes that did NOT happen stay provably unspendable forever - the oracle never signs them, so nobody, ever, can compute a private key for their leaf.'
  },
  {
    type: 'Text',
    value:
      "The lock cannot be undone. Needs a mint with ct1 support (lnurl-mint's ct1 extra); one without it refuses the lock before anything is burned."
  }
]

const betlockerManifest: AddonManifest = {
  id: 'betlocker',
  name: 'Betlocker',
  version: '1',
  icon: 'dice',
  description:
    'Lock one of your notes on the outcome of a real-world event via a Discreet Log Contract oracle - a race-to-claim bearer bet, nobody (including you) can redeem before the oracle attests.',
  permissions: [
    {
      verb: 'note.lockToPubkey',
      scope: 'spent:false',
      reason:
        'Let you pick one of your own unspent notes and irreversibly stake it on a bet'
    },
    {
      verb: 'note.redeemBet',
      reason:
        'Redeem a bet receipt you paste in, once the oracle’s attestation confirms an outcome, into a fresh note in your wallet'
    },
    {verb: 'clipboard.copy', reason: 'Copy the resulting bet receipt'},
    {
      verb: 'file.download',
      reason: 'Save a receipt file containing the bet receipt'
    }
  ],
  nav: {position: 'right', icon: 'dice', label: 'Betlocker'},
  state: {
    selectedNote: null,
    oraclePubkeyHex: '',
    nonceHex: '',
    outcomes: [],
    newOutcome: '',
    plan: null,
    lockedNote: null,
    useBech32: false,
    receiptInput: '',
    attestOutcome: '',
    attestSignatureHex: '',
    redeemResult: null
  },
  ui: {
    type: 'View',
    children: [
      {type: 'Text', value: 'Betlocker', style: 'heading'},
      {
        type: 'View',
        style: 'columns',
        children: [
          {type: 'View', style: 'col-left', children: [...lockUi, ...redeemUi]},
          {type: 'View', style: 'col-right', children: docsUi}
        ]
      }
    ]
  }
}

const outcomeList = (plan: unknown): string =>
  (plan as BetPlan | null)?.outcomes.join(', ') ?? '-'

const betlockerHelpers: Record<string, AddonHelper> = {
  problemOf: problemOf as AddonHelper,
  noProblem: noProblem as AddonHelper,
  canAddOutcome: canAddOutcome as AddonHelper,
  planBet: planBet as AddonHelper,
  outcomeList: outcomeList as AddonHelper,
  receiptUrlFor: receiptUrlFor as AddonHelper,
  receiptText: receiptText as AddonHelper,
  receiptOutcomes: receiptOutcomes as AddonHelper,
  receiptProblem: receiptProblem as AddonHelper,
  canRedeem: canRedeem as AddonHelper
}

export const betlockerAddon: Addon = {
  manifest: betlockerManifest,
  helpers: betlockerHelpers
}

// re-exported for the addon system's own type re-checking convenience
export type {BetPlan, BetReceipt}
