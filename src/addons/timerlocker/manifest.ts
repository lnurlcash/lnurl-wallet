import type {Addon, AddonHelper, AddonManifest, UiNode} from '../types'
import {withNewK1} from '../../lnurlcash'
import {
  dateProblem,
  planTimelock,
  formatUnlock,
  secretOfLink,
  unlockTimeOfSecret,
  type TimelockPlan
} from './timelock'

// Timerlocker: lock one of your own notes until a date you pick. The note is
// re-minted as a ct1 whose only way out is a CLTV leaf (see timelock.ts), so
// even you cannot spend it early - the mint refuses until ITS clock passes
// the date. What you get back is a "timelocked note link": an lnurlw URL whose
// secret is a cw1. Keep it, or give it to someone - whoever holds it can
// redeem after the date, before that it is inert.
//
// The link is the ONLY record of the value once the lock lands (the wallet
// cannot hold a cw1 note itself), which is why it is shown before locking and
// again after, with copy/download - see the docs column.

const trimmed = (v: unknown): string => String(v ?? '').trim()

const problemOf = (unlockAt: unknown): string => dateProblem(unlockAt)

const noProblem = (unlockAt: unknown): boolean => dateProblem(unlockAt) === ''

// the shareable link: the mint's own url template (host, path, certificate
// for Q) with the timelock secret as `tl` and NO k1 - the note's real k1 is a
// cw1 that can only be built at redeem time, once the mint's own figure for
// its value is known (the signature commits to it). Only ever built for the
// very plan that was locked
const timelockNoteUrl = (lockedNote: unknown, plan: unknown): string | null => {
  const locked = lockedNote as {
    urlTemplate: string
    amountMsat: number
    signature: string
    groupPubkeyHex: string
  } | null
  const p = plan as TimelockPlan | null
  if (!locked || !p || locked.groupPubkeyHex !== p.outputKeyHex) return null
  try {
    const url = new URL(
      withNewK1(
        locked.urlTemplate,
        '00'.repeat(32),
        locked.amountMsat,
        locked.signature
      )
    )
    url.searchParams.delete('k1')
    url.searchParams.set('tl', p.secret)
    return url.toString()
  } catch {
    return null
  }
}

const receiptText = (lockedNote: unknown, plan: unknown): string => {
  const url = timelockNoteUrl(lockedNote, plan)
  const p = plan as TimelockPlan | null
  if (!url || !p) return ''
  return [
    'Timerlocker note',
    `Unlocks: ${formatUnlock(p.locktime)} (unix ${p.locktime})`,
    'Redeem it after that time with the Timerlocker addon (Redeem section) - it will not work in a plain wallet.',
    'Whoever holds this link can redeem it - treat it like cash.',
    '',
    url,
    ''
  ].join('\n')
}

const unlockOfPlan = (plan: unknown): string =>
  formatUnlock((plan as TimelockPlan | null)?.locktime)

// what a pasted link says about itself, live while typing
const unlockOfUrl = (url: unknown): string => {
  const at = unlockTimeOfSecret(secretOfLink(url))
  return at === null ? '' : formatUnlock(at)
}

const lockedNoteUnlocksBy = (url: unknown): boolean => {
  const at = unlockTimeOfSecret(secretOfLink(url))
  return at !== null && at <= Math.floor(Date.now() / 1000)
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
              value: {helper: 'planTimelock', args: [{var: 'unlockAt'}]}
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
            value: {cat: ['Timelock secret: ', {var: 'plan.secret'}]},
            style: 'seed-block'
          },
          {
            type: 'Button',
            label: 'Copy timelock secret',
            onClick: {
              verb: 'clipboard.copy',
              args: {text: {var: 'plan.secret'}}
            }
          },
          {
            type: 'Text',
            value:
              'Copy that secret somewhere safe BEFORE locking - it is the note: whoever holds it can redeem after the date. Locking burns your note at the mint; there is no way to lock it back or unlock it early - not for you, not for the mint.'
          },
          {
            type: 'Button',
            label: 'Lock this note until then',
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
      {
        type: 'Text',
        value: {
          cat: [
            'Locked ',
            {helper: 'msatToSats', args: [{var: 'lockedNote.amountMsat'}]},
            ' sats until ',
            {helper: 'unlockOfPlan', args: [{var: 'plan'}]},
            '. Keep this link - it is the note:'
          ]
        }
      },
      {
        type: 'Text',
        value: {
          helper: 'timelockNoteUrl',
          args: [{var: 'lockedNote'}, {var: 'plan'}]
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
              args: [{var: 'lockedNote'}, {var: 'plan'}]
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
            filename: 'timerlocker-note.txt',
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

const redeemUi: UiNode[] = [
  {type: 'Text', value: 'Redeem a timelocked note', style: 'subheading'},
  {
    type: 'Input',
    bind: 'redeemUrl',
    label: 'Timelocked note link'
  },
  {
    type: 'Show',
    when: {helper: 'unlockOfUrl', args: [{var: 'redeemUrl'}]},
    children: [
      {
        type: 'Text',
        value: {
          cat: [
            'Unlocks: ',
            {helper: 'unlockOfUrl', args: [{var: 'redeemUrl'}]}
          ]
        }
      }
    ]
  },
  {
    type: 'Show',
    when: {helper: 'lockedNoteUnlocksBy', args: [{var: 'redeemUrl'}]},
    children: [
      {
        type: 'Button',
        label: 'Redeem into wallet',
        onClick: {
          verb: 'note.redeemTimelock',
          args: {url: {var: 'redeemUrl'}},
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
      'Pick one of your own unspent notes and a date/time.',
      "Click 'Prepare timelock', copy the timelock secret it shows, then click 'Lock this note until then'.",
      'Your note is burned at the mint and re-issued as a taproot (ct1) note whose only way out is a script that says "not before this time". The mint enforces it with its own clock, so nobody - including you - can spend it early.',
      'You get a timelock link. Keep it, or hand it to someone: it is a bearer note, whoever has it can redeem it once the time has passed.',
      "After the unlock time, paste the link under 'Redeem' and click 'Redeem into wallet'."
    ],
    children: [{type: 'Text', value: {var: 'item'}}]
  },
  {
    type: 'Text',
    value:
      "The lock cannot be undone. The link is the only record of the note once the lock lands - this wallet cannot hold a timelocked note itself, so lose the link and the value is gone. Needs a mint with ct1 support (lnurl-mint's ct1 extra); one without it refuses the lock before anything is burned."
  }
]

const timerlockerManifest: AddonManifest = {
  id: 'timerlocker',
  name: 'Timerlocker',
  version: '1',
  icon: 'timer',
  description:
    'Lock one of your notes until a date you pick - a timelocked bearer note (ct1 with a CLTV leaf) that nobody can redeem early, not even you.',
  permissions: [
    {
      verb: 'note.lockToPubkey',
      scope: 'spent:false',
      reason:
        'Let you pick one of your own unspent notes and irreversibly lock it until the date you choose'
    },
    {
      verb: 'note.redeemTimelock',
      reason:
        'Redeem a timelocked note link you paste in, once its unlock time has passed, into a fresh note in your wallet'
    },
    {
      verb: 'clipboard.copy',
      reason: 'Copy the timelock secret and note link'
    },
    {
      verb: 'file.download',
      reason: 'Save a receipt file containing the timelocked note link'
    }
  ],
  nav: {position: 'right', icon: 'timer', label: 'Timerlocker'},
  state: {
    selectedNote: null,
    unlockAt: '',
    plan: null,
    lockedNote: null,
    redeemUrl: '',
    redeemResult: null
  },
  ui: {
    type: 'View',
    children: [
      {type: 'Text', value: 'Timerlocker', style: 'heading'},
      {
        type: 'View',
        style: 'columns',
        children: [
          {
            type: 'View',
            style: 'col-left',
            children: [...lockUi, ...redeemUi]
          },
          {type: 'View', style: 'col-right', children: docsUi}
        ]
      }
    ]
  }
}

const timerlockerHelpers: Record<string, AddonHelper> = {
  problemOf: problemOf as AddonHelper,
  noProblem: noProblem as AddonHelper,
  planTimelock: planTimelock as AddonHelper,
  unlockOfPlan: unlockOfPlan as AddonHelper,
  unlockOfUrl: unlockOfUrl as AddonHelper,
  lockedNoteUnlocksBy: lockedNoteUnlocksBy as AddonHelper,
  timelockNoteUrl: timelockNoteUrl as AddonHelper,
  receiptText: receiptText as AddonHelper
}

export const timerlockerAddon: Addon = {
  manifest: timerlockerManifest,
  helpers: timerlockerHelpers
}
