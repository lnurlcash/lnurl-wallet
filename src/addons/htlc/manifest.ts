import type {Addon, AddonHelper, AddonManifest, UiNode} from '../types'
import {
  claimPubkeyProblem,
  formatUnlock,
  generatePreimage,
  htlcProblem,
  htlcReceiptUrl,
  parseHtlcReceipt,
  planHtlc,
  preimageProblem,
  receiptProblem,
  refundDateProblem,
  refundNoteUrl
} from './htlc'

// See htlc.ts's own top comment for the full picture: a note locked to a
// hashlock CLAIM leaf (preimage + a named claimant's own signature) plus a
// mandatory cltv REFUND leaf, same two-leaf-tree shape the sibling
// betlocker addon uses for its own outcome-leaf-plus-refund-leaf tree,
// just with "reveal the preimage" standing in for "the oracle attested".

const xOnlyPubkeyHex = (value: unknown): string => {
  const v = String(value ?? '')
    .trim()
    .toLowerCase()
  if (/^[0-9a-f]{64}$/.test(v)) return v
  if (/^0[23][0-9a-f]{64}$/.test(v)) return v.slice(2)
  return v
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
        label: 'Note to lock'
      },
      {
        type: 'Text',
        value: 'Who can claim this once they have the preimage'
      },
      {
        type: 'Input',
        bind: 'claimAddress',
        label: 'Their Lightning Address, cx1/cp1 address, or username'
      },
      {
        type: 'Button',
        label: 'Resolve pubkey',
        onClick: {
          verb: 'note.resolveAddressPubkey',
          args: {
            address: {var: 'claimAddress'},
            mintNote: {var: 'selectedNote.id'}
          },
          result: 'claimPubkeyHex'
        }
      },
      {
        type: 'Show',
        when: {var: 'claimPubkeyHex'},
        children: [
          {
            type: 'Text',
            value: {
              cat: [
                'Claimant pubkey: ',
                {helper: 'xOnlyPubkeyHex', args: [{var: 'claimPubkeyHex'}]}
              ]
            },
            style: 'response-block'
          },
          {
            type: 'Button',
            label: 'Clear',
            onClick: {action: 'set', path: 'claimPubkeyHex', value: ''}
          }
        ]
      },
      {type: 'Text', value: 'Preimage / hash', style: 'subheading'},
      {
        type: 'Text',
        value:
          'Generate a fresh secret, or paste a hash from elsewhere (e.g. one you did not generate yourself). Whoever holds the preimage - however they come to hold it - is who this note is ultimately released to, but only once they ALSO sign with the claimant key above.'
      },
      {
        type: 'Show',
        when: {helper: 'not', args: [{var: 'generated.hashHex'}]},
        children: [
          {
            type: 'Button',
            label: 'Generate preimage',
            onClick: {
              action: 'set',
              path: 'generated',
              value: {helper: 'generatePreimage', args: []}
            }
          }
        ]
      },
      {
        type: 'Input',
        bind: 'generated.hashHex',
        label: 'Hash (sha256, 32-byte hex)'
      },
      {
        type: 'Show',
        when: {var: 'generated.preimageHex'},
        children: [
          {
            type: 'Text',
            value:
              'Preimage - copy this now and hand it to the claimant separately from the receipt below. It is never included in the receipt and cannot be recovered if lost.'
          },
          {
            type: 'Text',
            value: {var: 'generated.preimageHex'},
            style: 'response-block'
          },
          {
            type: 'Button',
            label: 'Copy preimage',
            onClick: {
              verb: 'clipboard.copy',
              args: {text: {var: 'generated.preimageHex'}}
            }
          }
        ]
      },
      {type: 'Text', value: 'Refund deadline', style: 'subheading'},
      {
        type: 'Text',
        value:
          'If the claimant never produces the preimage, you can reclaim this note yourself after this date.'
      },
      {
        type: 'Input',
        bind: 'refundDate',
        kind: 'datetime',
        label: 'Refund after'
      },
      {
        type: 'Show',
        when: {
          and: [
            {
              helper: 'not',
              args: [
                {
                  helper: 'htlcProblem',
                  args: [{var: 'generated.hashHex'}, {var: 'claimPubkeyHex'}]
                }
              ]
            },
            {
              helper: 'not',
              args: [{helper: 'refundDateProblem', args: [{var: 'refundDate'}]}]
            }
          ]
        },
        children: [
          {
            type: 'Button',
            label: 'Prepare lock',
            onClick: {
              action: 'set',
              path: 'plan',
              value: {
                helper: 'planHtlc',
                args: [
                  {var: 'generated.hashHex'},
                  {helper: 'xOnlyPubkeyHex', args: [{var: 'claimPubkeyHex'}]},
                  {
                    helper: 'satsToMsat',
                    args: [{var: 'selectedNote.amountSat'}]
                  },
                  {var: 'refundDate'},
                  {var: 'selectedNote.mint'}
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
              'Locking cannot be undone. Nobody - including you - can produce a spendable secret for the claim leaf without both the preimage and the claimant’s own key.'
          },
          {
            type: 'Button',
            label: 'Lock this note',
            onClick: {
              verb: 'note.lockToPubkey',
              args: {
                note: {var: 'selectedNote.id'},
                pubkeyHex: {var: 'plan.outputKeyHex'}
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
      {type: 'Text', value: 'Note locked', style: 'subheading'},
      {
        type: 'Text',
        value: {
          cat: [
            'Locked ',
            {helper: 'msatToSats', args: [{var: 'lockedNote.amountMsat'}]},
            ' sats, claimable by ',
            {var: 'plan.claimPubkeyHex'}
          ]
        }
      },
      {
        type: 'Show',
        when: {helper: 'not', args: [{var: 'refundClaimResult'}]},
        children: [
          {
            type: 'Text',
            value: {
              cat: [
                'A refund note was also generated - if the claimant never produces the preimage, you can reclaim after ',
                {helper: 'formatUnlock', args: [{var: 'plan.refundLocktime'}]},
                '. Add it to your wallet now so it’s not lost.'
              ]
            }
          },
          {
            type: 'Button',
            label: 'Add refund note to wallet',
            onClick: {
              verb: 'note.claim',
              args: {
                url: {
                  helper: 'refundNoteUrl',
                  args: [{var: 'lockedNote'}, {var: 'plan'}]
                },
                callback: {var: 'lockedNote.callback'},
                amountMsat: {var: 'lockedNote.amountMsat'}
              },
              result: 'refundClaimResult'
            }
          }
        ]
      },
      {
        type: 'Show',
        when: {var: 'refundClaimResult'},
        children: [
          {
            type: 'Text',
            value:
              '✓ Refund note added to your wallet - it behaves like any other note, just not spendable until its own deadline.',
            style: 'response-block'
          }
        ]
      },
      {
        type: 'Text',
        value: 'Receipt (share with the claimant)',
        style: 'subheading'
      },
      {
        type: 'Text',
        value: {
          helper: 'htlcReceiptUrl',
          args: [{var: 'lockedNote'}, {var: 'plan'}]
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
              helper: 'htlcReceiptUrl',
              args: [{var: 'lockedNote'}, {var: 'plan'}]
            }
          }
        }
      },
      {
        type: 'Button',
        label: 'Start a new lock',
        onClick: {action: 'set', path: 'lockedNote', value: null}
      }
    ]
  }
]

const redeemUi: UiNode[] = [
  {type: 'Text', value: 'Claim a lock', style: 'subheading'},
  {
    type: 'Input',
    bind: 'receiptInput',
    label: 'Paste the receipt you were given'
  },
  {
    type: 'Show',
    when: {
      and: [
        {var: 'receiptInput'},
        {helper: 'receiptProblem', args: [{var: 'receiptInput'}]}
      ]
    },
    children: [
      {
        type: 'Text',
        value: {helper: 'receiptProblem', args: [{var: 'receiptInput'}]}
      }
    ]
  },
  {
    type: 'Show',
    when: {
      helper: 'not',
      args: [{helper: 'receiptProblem', args: [{var: 'receiptInput'}]}]
    },
    children: [
      {
        type: 'Input',
        bind: 'claimPreimageHex',
        label: 'Preimage you were given (32-byte hex)'
      },
      {
        type: 'Input',
        bind: 'claimSecretKeyHex',
        label: 'Your own secret key (the claimant’s)'
      },
      {
        type: 'Show',
        when: {
          and: [
            {var: 'claimPreimageHex'},
            {
              helper: 'preimageProblemFor',
              args: [{var: 'claimPreimageHex'}, {var: 'receiptInput'}]
            }
          ]
        },
        children: [
          {
            type: 'Text',
            value: {
              helper: 'preimageProblemFor',
              args: [{var: 'claimPreimageHex'}, {var: 'receiptInput'}]
            }
          }
        ]
      },
      {
        type: 'Button',
        label: 'Claim',
        onClick: {
          verb: 'note.redeemHtlc',
          args: {
            receiptUrl: {var: 'receiptInput'},
            preimageHex: {var: 'claimPreimageHex'},
            claimSecretKeyHex: {var: 'claimSecretKeyHex'}
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
            '✓ Claimed ',
            {helper: 'msatToSats', args: [{var: 'redeemResult.amountMsat'}]},
            ' sats into your wallet.'
          ]
        },
        style: 'response-block'
      }
    ]
  }
]

const docsUi: UiNode[] = [
  {type: 'Text', value: 'How this works', style: 'subheading'},
  {
    type: 'List',
    ordered: true,
    each: [
      'Name who can claim this (their pubkey), generate or paste a hash, and pick a refund deadline.',
      'Pick one of your own notes, click ’Prepare lock’, then ’Lock this note’. It’s burned at the mint and re-issued as a taproot note with a claim leaf and a refund leaf - nobody can spend either yet.',
      'Add the refund note to your wallet right away, and copy the receipt.',
      'Hand the preimage to the claimant separately from the receipt - however makes sense for what you’re using this for (e.g. it might itself be revealed by some OTHER condition resolving).',
      'The claimant pastes the receipt, the preimage, and their own secret key to claim. If they never do, redeem your own refund note instead once its deadline passes.'
    ],
    children: [{type: 'Text', value: {var: 'item'}}]
  },
  {
    type: 'Text',
    value:
      'This is the standalone hashlock+timeout SHAPE an HTLC leaf takes - not a Lightning channel’s own in-flight HTLC (this wallet holds no channel, ever). Reusing the same taproot templates the sibling betlocker/timelocker addons already use.'
  },
  {
    type: 'Text',
    value:
      'The lock cannot be undone. Any LUD-25 mint redeems the script path - it accepts every leaf, the same way it accepts a signature.'
  }
]

const htlcManifest: AddonManifest = {
  id: 'htlc',
  name: 'HTLC',
  version: '1',
  icon: 'lock',
  experimental: true,
  description:
    'Locks one of your notes behind a hash-time-locked contract: claimable by whoever produces a preimage AND signs with a named claimant key, or reclaimable by you after a refund deadline if nobody does.',
  permissions: [
    {
      verb: 'note.lockToPubkey',
      scope: 'spent:false',
      reason: 'Let you pick one of your own unspent notes and lock it'
    },
    {
      verb: 'note.redeemHtlc',
      reason:
        'Redeem a receipt you paste in, once you have the preimage and the claimant’s own secret key, into a fresh note in your wallet'
    },
    {verb: 'clipboard.copy', reason: 'Copy the resulting receipt or preimage'},
    {
      verb: 'note.resolveAddressPubkey',
      reason:
        'Resolve a Lightning Address/cx1/cp1/username into a pubkey, to name who can claim a note you lock'
    },
    {
      verb: 'note.claim',
      reason:
        'Add this lock’s own refund note to your wallet right after locking, so you can reclaim it later if nobody ever claims'
    }
  ],
  nav: {position: 'right', icon: 'lock', label: 'HTLC'},
  state: {
    selectedNote: null,
    claimAddress: '',
    claimPubkeyHex: '',
    // holds {preimageHex, hashHex} once "Generate preimage" is clicked - a
    // plain object (never null) so the hash Input below can bind straight
    // to `generated.hashHex` and stay directly editable too (paste a hash
    // produced elsewhere instead of generating one here)
    generated: {preimageHex: '', hashHex: ''},
    refundDate: '',
    plan: null,
    lockedNote: null,
    refundClaimResult: null,
    receiptInput: '',
    claimPreimageHex: '',
    claimSecretKeyHex: '',
    redeemResult: null
  },
  ui: {
    type: 'View',
    children: [
      {type: 'Text', value: 'HTLC', style: 'heading'},
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

const htlcHelpers: Record<string, AddonHelper> = {
  xOnlyPubkeyHex: xOnlyPubkeyHex as AddonHelper,
  claimPubkeyProblem: claimPubkeyProblem as AddonHelper,
  htlcProblem: htlcProblem as AddonHelper,
  refundDateProblem: refundDateProblem as AddonHelper,
  formatUnlock: formatUnlock as AddonHelper,
  // draws fresh randomness like planHtlc/planBet's own throwaway refund
  // keys do - "pure" (types.ts's AddonHelper doc comment) means no wallet/
  // device/network/DOM access, not determinism; a one-shot Button `set`
  // action, same as those, never a live Text/Show binding
  generatePreimage: generatePreimage as AddonHelper,
  planHtlc: planHtlc as AddonHelper,
  htlcReceiptUrl: htlcReceiptUrl as AddonHelper,
  refundNoteUrl: refundNoteUrl as AddonHelper,
  receiptProblem: receiptProblem as AddonHelper,
  preimageProblemFor: ((preimageHex: unknown, receiptUrl: unknown) => {
    const receipt = parseHtlcReceipt(receiptUrl)
    return receipt ? preimageProblem(preimageHex, receipt.hashHex) : ''
  }) as AddonHelper
}

export const htlcAddon: Addon = {
  manifest: htlcManifest,
  helpers: htlcHelpers
}
