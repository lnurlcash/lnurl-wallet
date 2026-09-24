import type {Addon, AddonHelper, AddonManifest, UiNode} from '../types'
import {withNewK1, toLud17w, toBech32Lnurl} from '../../lnurlcash'
import {
  dateProblem,
  planTimelock,
  formatUnlock,
  type TimelockPlan
} from './timelock'

// Timelocker: lock one of your own notes until a date you pick. The note is
// re-minted as a note whose only way out is a CLTV leaf (see timelock.ts), so
// even you cannot spend it early - the mint refuses until ITS clock passes
// the date.
//
// What you get back is an ordinary, complete lnurlw note - its k1 is a cw1
// script-path secret, already signed for this exact amount, so nothing needs
// to happen at "redeem" time beyond an ordinary withdraw once the date has
// passed (see lnurl-mint's router.py:_note_id_from_k1, which resolves a cw1
// the same way as any other k1). There is deliberately no separate redeem
// step in this addon - a timelocked note is just a note.
//
// The link is the ONLY record of the value once the lock lands (the wallet
// cannot hold a cw1 note itself), which is why it is shown, with copy/
// download, right after locking - see the docs column.

const problemOf = (unlockAt: unknown): string => dateProblem(unlockAt)

const noProblem = (unlockAt: unknown): boolean => dateProblem(unlockAt) === ''

type LockedNote = {
  urlTemplate: string
  amountMsat: number
  signature: string
  groupPubkeyHex: string
}

// the shareable link: the mint's own url template with the plan's already-
// signed cw1 as k1 - a complete, ordinary note, nothing left to fill in at
// redeem time. `lnurlw://` per LUD-17 (never the bare `https://` callback
// form), optionally the classic LUD-01 bech32 encoding on top, optionally
// without the mint's offline-verification certificate. Only ever built for
// the very plan that was locked.
const timelockNoteUrl = (
  lockedNote: unknown,
  plan: unknown,
  bech32: unknown,
  offlineSig: unknown
): string | null => {
  const locked = lockedNote as LockedNote | null
  const p = plan as TimelockPlan | null
  if (!locked || !p || locked.groupPubkeyHex !== p.outputKeyHex) return null
  try {
    const plain = toLud17w(
      withNewK1(
        locked.urlTemplate,
        p.cw1,
        locked.amountMsat,
        offlineSig ? locked.signature : undefined
      )
    )
    return bech32 ? toBech32Lnurl(plain) : plain
  } catch {
    return null
  }
}

const unlockOfPlan = (plan: unknown): string =>
  formatUnlock((plan as TimelockPlan | null)?.locktime)

const receiptText = (
  lockedNote: unknown,
  plan: unknown,
  bech32: unknown,
  offlineSig: unknown
): string => {
  const url = timelockNoteUrl(lockedNote, plan, bech32, offlineSig)
  const locked = lockedNote as LockedNote | null
  const p = plan as TimelockPlan | null
  if (!url || !locked || !p) return ''
  return [
    'Timelocker note',
    `Amount: ${Math.floor(locked.amountMsat / 1000)} sats`,
    `Unlocks: ${formatUnlock(p.locktime)} (unix ${p.locktime})`,
    'Whoever holds this link can redeem it, once that time has passed, with',
    'any LUD-03 withdraw-capable wallet - treat it like cash.',
    '',
    url
  ].join('\n')
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
        type: 'Input',
        bind: 'unlockAt',
        kind: 'datetime',
        label: 'Unlock date & time (your local time)'
      },
      {
        type: 'Show',
        when: {helper: 'problemOf', args: [{var: 'unlockAt'}]},
        children: [
          {
            type: 'Text',
            value: {helper: 'problemOf', args: [{var: 'unlockAt'}]}
          }
        ]
      },
      {
        type: 'Show',
        when: {
          and: [
            {var: 'selectedNote'},
            {helper: 'noProblem', args: [{var: 'unlockAt'}]}
          ]
        },
        children: [
          {
            type: 'Button',
            label: 'Prepare timelock',
            onClick: {
              action: 'set',
              path: 'plan',
              value: {
                helper: 'planTimelock',
                args: [
                  {var: 'unlockAt'},
                  {
                    helper: 'satsToMsat',
                    args: [{var: 'selectedNote.amountSat'}]
                  },
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
              cat: [
                'Will unlock: ',
                {helper: 'unlockOfPlan', args: [{var: 'plan'}]}
              ]
            },
            style: 'response-block'
          },
          {
            type: 'Text',
            value:
              'This already IS the note - locking cannot be undone. Copy it somewhere safe before locking; nobody, not even the mint, can unlock it early or lock it back.',
            style: 'seed-block'
          },
          {
            type: 'Button',
            label: 'Lock this note until then',
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
      {type: 'Text', value: 'Timelocker note', style: 'subheading'},
      {
        type: 'Text',
        value: {
          cat: [
            'Amount: ',
            {helper: 'msatToSats', args: [{var: 'lockedNote.amountMsat'}]},
            ' sats'
          ]
        }
      },
      {
        type: 'Text',
        value: {
          cat: ['Unlocks: ', {helper: 'unlockOfPlan', args: [{var: 'plan'}]}]
        }
      },
      {
        type: 'Input',
        bind: 'useBech32',
        kind: 'checkbox',
        label: 'Encode as bech32 (LNURL1…)'
      },
      {
        type: 'Input',
        bind: 'includeSignature',
        kind: 'checkbox',
        label: "Include the mint's offline verification signature"
      },
      {type: 'Text', value: 'Keep this link - it is the note:'},
      {
        type: 'Text',
        value: {
          helper: 'timelockNoteUrl',
          args: [
            {var: 'lockedNote'},
            {var: 'plan'},
            {var: 'useBech32'},
            {var: 'includeSignature'}
          ]
        },
        style: 'response-block'
      },
      {
        type: 'Button',
        label: 'Copy link',
        onClick: {
          verb: 'clipboard.copy',
          args: {
            text: {
              helper: 'timelockNoteUrl',
              args: [
                {var: 'lockedNote'},
                {var: 'plan'},
                {var: 'useBech32'},
                {var: 'includeSignature'}
              ]
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
            filename: 'timelocker-note.txt',
            content: {
              helper: 'receiptText',
              args: [
                {var: 'lockedNote'},
                {var: 'plan'},
                {var: 'useBech32'},
                {var: 'includeSignature'}
              ]
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
              "✗ could not verify the mint's certificate for this lock - keep the link, but check the note with the mint before relying on it."
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

const docsUi: UiNode[] = [
  {type: 'Text', value: 'How it works', style: 'subheading'},
  {
    type: 'List',
    ordered: true,
    each: [
      'Pick one of your own unspent notes and a date/time.',
      "Click 'Prepare timelock' - the note's own value is already signed into the lock, so nothing further needs to happen later.",
      'Click \'Lock this note until then\'. Your note is burned at the mint and re-issued as a taproot (cp1) note whose only way out is a script that says "not before this time". The mint enforces it with its own clock, so nobody - including you - can spend it early.',
      'Copy the note link (or download a receipt). It is a complete, ordinary bearer note - hand it to anyone, or keep it: whoever holds it can redeem it, once the date has passed, with any LUD-03 withdraw wallet, no addon required.'
    ],
    children: [{type: 'Text', value: {var: 'item'}}]
  },
  {
    type: 'Text',
    value:
      'The lock cannot be undone. The link is the only record of the note once the lock lands - this wallet cannot hold a timelocked note itself, so lose the link and the value is gone. Any LUD-25 mint redeems the script path - it accepts every leaf, the same way it accepts a signature.'
  }
]

const timelockerManifest: AddonManifest = {
  id: 'timelocker',
  name: 'Timelocker',
  version: '1',
  icon: 'timer',
  description:
    'Lock one of your notes until a date you pick - a timelocked bearer note (a cp1 with a CLTV leaf) that nobody can redeem early, not even you.',
  permissions: [
    {
      verb: 'note.lockToPubkey',
      scope: 'spent:false',
      reason:
        'Let you pick one of your own unspent notes and irreversibly lock it until the date you choose'
    },
    {
      verb: 'clipboard.copy',
      reason: 'Copy the resulting timelocked note link'
    },
    {
      verb: 'file.download',
      reason: 'Save a receipt file containing the timelocked note link'
    }
  ],
  nav: {position: 'right', icon: 'timer', label: 'Timelocker'},
  state: {
    selectedNote: null,
    unlockAt: '',
    plan: null,
    lockedNote: null,
    useBech32: false,
    includeSignature: true
  },
  ui: {
    type: 'View',
    children: [
      {type: 'Text', value: 'Timelocker', style: 'heading'},
      {
        type: 'View',
        style: 'columns',
        children: [
          {type: 'View', style: 'col-left', children: lockUi},
          {type: 'View', style: 'col-right', children: docsUi}
        ]
      }
    ]
  }
}

const timelockerHelpers: Record<string, AddonHelper> = {
  problemOf: problemOf as AddonHelper,
  noProblem: noProblem as AddonHelper,
  planTimelock: planTimelock as AddonHelper,
  unlockOfPlan: unlockOfPlan as AddonHelper,
  timelockNoteUrl: timelockNoteUrl as AddonHelper,
  receiptText: receiptText as AddonHelper
}

export const timelockerAddon: Addon = {
  manifest: timelockerManifest,
  helpers: timelockerHelpers
}
