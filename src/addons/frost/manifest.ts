import type {Addon, AddonHelper, AddonManifest, UiNode} from '../types'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {
  dkgRound1,
  dkgRound2,
  dkgRound3,
  dealerSetup,
  frostAggregate,
  frostCommit,
  frostSignShare,
  groupIdentifier,
  utf8MessageHex,
  type FrostResult
} from './frost'
import {
  encodeCk1,
  encodeCp1,
  recoverNoteOwnershipPubkey,
  withNewK1
} from '../../lnurlcash'

// FROST (RFC 9591) - t-of-n threshold Schnorr signatures. Genuinely
// different from the sibling musig2 addon, not "MuSig2 with more steps":
// MuSig2 is n-of-n (every key-aggregation participant must sign every
// time); FROST is t-of-n (any t of a fixed n shares can sign, without the
// rest ever being needed). See frost.ts's own top comment for how this is
// verified to actually work, not just asserted from the library's docs.
//
// Two ways to create a group's shares, both included here:
//   TRUSTED DEALER - one party generates everything in one shot. Simple,
//   but that party briefly computes the WHOLE group secret before
//   splitting and (in principle) discarding it - a real, momentary trust
//   assumption, same spirit as this wallet's own oracle service being a
//   single named trusted party for a different kind of claim.
//   DKG - the real distributed protocol: every participant generates
//   their own polynomial and verifiably shares it with the others: NOBODY
//   ever holds the full group secret, not even briefly.
//
// Still a "play around" sandbox, same posture as the sibling musig2/dlc
// addons: every participant's key material lives in this page's own
// state (never persisted, gone on reload), and the WHOLE group - however
// it was generated - is simulated locally on this one page, all shares
// visible here. This is what lets a threshold GENUINELY be demonstrated
// (sign with fewer than n, verify the rest were never needed) without
// first building a live network between separate people - frost.ts's own
// staged functions (dkgRound1/round2/round3, frostCommit/signShare/
// frostAggregate) already support a real multi-party version of this
// (mirroring the sibling musig2 addon's own staged flow), but wiring that
// up as its own paste-a-blob UI is a clearly scoped follow-up, not done
// here.
//
// NOT YET: locking a note to a taproot-tweaked FROST output (ct1 with a
// script leaf). @noble/curves does ship the tweak functions this would
// need (frostTweakPublic/frostTweakSecret), but only via an export
// literally named __TEST in the installed version - not a stable public
// API, and tweaking a THRESHOLD group correctly (so the eventual
// signature is valid for the tweaked key regardless of which t signed) is
// exactly the kind of subtle math this wallet doesn't ship without real,
// independent verification. This addon locks to the group's own plain
// pubkey instead (cp1<P>, no taproot tweak at all) - the same simplest/
// default mode the sibling musig2 addon uses when no script leaf is
// attached, proven the same way: a real note.lockToPubkey, a real
// threshold-produced ck1, a real redemption.

const MAX_GROUP_SIZE = 5

const isPositiveInt = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n > 0

type LocalGroup = {
  min: number
  max: number
  groupPubkeyHex: string
  publicBlob: string
  // index 0 = identity 1, index 1 = identity 2, ...
  shareBlobs: string[]
}

const setupProblem = (min: unknown, max: unknown): string => {
  const t = Number(min)
  const n = Number(max)
  if (!isPositiveInt(t) || !isPositiveInt(n))
    return 'Enter a threshold and a group size.'
  if (n > MAX_GROUP_SIZE)
    return `This playground supports up to ${MAX_GROUP_SIZE} participants.`
  if (t > n) return 'The threshold can’t be larger than the group.'
  if (t < 2) return 'A threshold of 1 isn’t a threshold - use 2 or more.'
  return ''
}

const canSetUp = (min: unknown, max: unknown): boolean =>
  setupProblem(min, max) === ''

// runs the WHOLE trusted-dealer setup in one shot, only the final,
// already-hex summary crossing back into addon state - same reasoning
// musig2.ts's own aggregateAndSignBytes top comment gives for keeping a
// multi-step pipeline inside one synchronous helper
const setUpWithDealer = (min: unknown, max: unknown): LocalGroup => {
  const deal = dealerSetup(min, max)
  return {
    min: deal.min,
    max: deal.max,
    groupPubkeyHex: deal.groupPubkeyHex,
    publicBlob: deal.publicBlob,
    shareBlobs: deal.shareBlobs
  }
}

// runs the WHOLE 3-round DKG in one shot - every participant simulated on
// this one page, so there's no real "who talks to whom" to model; the
// point demonstrated here is that the MATH doesn't need a dealer, not
// that this page is itself a live multi-party network (see this addon's
// own top comment on why the real staged version is a follow-up)
const setUpWithDkg = (min: unknown, max: unknown): LocalGroup => {
  const problem = setupProblem(min, max)
  if (problem) throw new Error(problem)
  const t = Number(min)
  const n = Number(max)
  const r1 = Array.from({length: n}, (_, i) => dkgRound1(i + 1, t, n))
  const r2 = r1.map((r, i) =>
    dkgRound2(
      r.secretBlob,
      r1.filter((_, j) => j !== i).map(o => o.broadcastBlob)
    )
  )
  const finals = r2.map((mine, i) => {
    const myId = groupIdentifier(i + 1)
    const round2ForMe = r2
      .filter((_, j) => j !== i)
      .map(sent => sent.packageBlobs[sent.recipientIds.indexOf(myId)]!)
    return dkgRound3(
      mine.secretBlob,
      r1.filter((_, j) => j !== i).map(o => o.broadcastBlob),
      round2ForMe
    )
  })
  const key0 = JSON.parse(finals[0]!.keyBlob) as {public: unknown}
  return {
    min: t,
    max: n,
    groupPubkeyHex: finals[0]!.groupPubkeyHex,
    publicBlob: JSON.stringify(key0.public),
    shareBlobs: finals.map(f =>
      JSON.stringify((JSON.parse(f.keyBlob) as {secret: unknown}).secret)
    )
  }
}

// '' when the free-text "which participants sign" field names at least
// `min` distinct, in-range identities - the live validation gate before
// "Sign" enables
const signingIdsOf = (group: unknown, signerList: unknown): number[] => {
  const g = group as LocalGroup | null
  if (!g) return []
  const nums = String(signerList ?? '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isInteger(n) && n >= 1 && n <= g.max)
  return [...new Set(nums)]
}

const signingProblem = (group: unknown, signerList: unknown): string => {
  const g = group as LocalGroup | null
  if (!g) return 'Set up a group first.'
  const ids = signingIdsOf(group, signerList)
  if (ids.length < g.min) {
    return `Name at least ${g.min} distinct participants (1-${g.max}), comma-separated.`
  }
  return ''
}

const runThresholdSign = (
  group: unknown,
  signerList: unknown,
  messageHex: string
): FrostResult => {
  const g = group as LocalGroup
  const ids = signingIdsOf(group, signerList)
  const nonces = ids.map(n => frostCommit(g.shareBlobs[n - 1]!))
  const commitmentBlobs = nonces.map(x => x.commitmentBlob)
  const shares = ids.map((n, i) =>
    frostSignShare(
      g.shareBlobs[n - 1]!,
      g.publicBlob,
      nonces[i]!.nonceBlob,
      commitmentBlobs,
      messageHex
    )
  )
  return frostAggregate(g.publicBlob, commitmentBlobs, messageHex, ids, shares)
}

const runMessageSign = (
  group: unknown,
  signerList: unknown,
  messageUtf8: unknown
): FrostResult =>
  runThresholdSign(group, signerList, utf8MessageHex(messageUtf8))

// ---- locking a real note to this group, and proving ownership back ----
//
// cp1<groupPubkeyHex> only (see this file's own top comment on why not
// ct1 yet) - the group's own plain pubkey, an ordinary LUD-25 Part 2
// pubkey commitment, redeemed by an ordinary ck1 (a BIP340 signature over
// the fixed "LNURLcash" digest - src/lib/signature.ts's own
// NOTE_OWNERSHIP_DIGEST), same as the sibling musig2 addon's own default
// (untweaked) mode.
const CK1_OWNERSHIP_DIGEST_HEX = bytesToHex(sha256(utf8ToBytes('LNURLcash')))

const groupCp1Preview = (group: unknown): string => {
  const g = group as LocalGroup | null
  if (!g) return '-'
  try {
    return encodeCp1(hexToBytes(g.groupPubkeyHex))
  } catch {
    return '-'
  }
}

type LockedNote = {
  urlTemplate: string
  amountMsat: number
  signature: string
  callback: string
  groupPubkeyHex: string
}

const ck1FromResult = (result: unknown): string | null => {
  const r = result as FrostResult | null
  if (!r) return null
  try {
    return encodeCk1(hexToBytes(r.groupPubkeyHex), hexToBytes(r.finalSigHex))
  } catch {
    return null
  }
}

const ck1Accepted = (result: unknown): boolean => {
  const ck1 = ck1FromResult(result)
  return ck1 !== null && recoverNoteOwnershipPubkey(ck1) !== null
}

const lockedNoteUrl = (
  lockedNote: unknown,
  ownershipResult: unknown
): string | null => {
  const locked = lockedNote as LockedNote | null
  const result = ownershipResult as FrostResult | null
  if (!locked || !result || result.groupPubkeyHex !== locked.groupPubkeyHex) {
    return null
  }
  const ck1 = ck1FromResult(result)
  if (!ck1) return null
  try {
    return withNewK1(
      locked.urlTemplate,
      ck1,
      locked.amountMsat,
      locked.signature
    )
  } catch {
    return null
  }
}

// ---- UI ----

const setupUi: UiNode[] = [
  {type: 'Text', value: '1. Set up a group', style: 'subheading'},
  {
    type: 'Show',
    when: {helper: 'not', args: [{var: 'group'}]},
    children: [
      {
        type: 'Input',
        bind: 'thresholdT',
        kind: 'number',
        label: 'Threshold (t)'
      },
      {
        type: 'Input',
        bind: 'groupSizeN',
        kind: 'number',
        label: 'Group size (n)'
      },
      {
        type: 'Show',
        when: {
          helper: 'setupProblem',
          args: [{var: 'thresholdT'}, {var: 'groupSizeN'}]
        },
        children: [
          {
            type: 'Text',
            value: {
              helper: 'setupProblem',
              args: [{var: 'thresholdT'}, {var: 'groupSizeN'}]
            }
          }
        ]
      },
      {
        type: 'Show',
        when: {
          helper: 'canSetUp',
          args: [{var: 'thresholdT'}, {var: 'groupSizeN'}]
        },
        children: [
          {
            type: 'Button',
            label: 'Generate (trusted dealer)',
            onClick: {
              action: 'set',
              path: 'group',
              value: {
                helper: 'setUpWithDealer',
                args: [{var: 'thresholdT'}, {var: 'groupSizeN'}]
              }
            }
          },
          {
            type: 'Button',
            label: 'Generate (DKG, no dealer)',
            onClick: {
              action: 'set',
              path: 'group',
              value: {
                helper: 'setUpWithDkg',
                args: [{var: 'thresholdT'}, {var: 'groupSizeN'}]
              }
            }
          }
        ]
      }
    ]
  },
  {
    type: 'Show',
    when: {var: 'group'},
    children: [
      {
        type: 'Text',
        value: {
          cat: [
            'Group: ',
            {var: 'group.min'},
            '-of-',
            {var: 'group.max'},
            ' - pubkey ',
            {var: 'group.groupPubkeyHex'}
          ]
        },
        style: 'response-block'
      },
      {
        type: 'Text',
        value: {
          cat: [
            'cp1 address: ',
            {helper: 'groupCp1Preview', args: [{var: 'group'}]}
          ]
        }
      },
      {
        type: 'Button',
        label: 'Start over',
        onClick: {action: 'set', path: 'group', value: null}
      }
    ]
  }
]

const signUi: UiNode[] = [
  {
    type: 'Text',
    value: '2. Sign a message with any t of n',
    style: 'subheading'
  },
  {
    type: 'Show',
    when: {helper: 'not', args: [{var: 'group'}]},
    children: [{type: 'Text', value: 'Set up a group above first.'}]
  },
  {
    type: 'Show',
    when: {var: 'group'},
    children: [
      {type: 'Input', bind: 'messageText', label: 'Message to sign'},
      {
        type: 'Input',
        bind: 'signerList',
        label:
          'Which participants sign (e.g. "1,3") - fewer than all n, on purpose'
      },
      {
        type: 'Show',
        when: {
          helper: 'signingProblem',
          args: [{var: 'group'}, {var: 'signerList'}]
        },
        children: [
          {
            type: 'Text',
            value: {
              helper: 'signingProblem',
              args: [{var: 'group'}, {var: 'signerList'}]
            }
          }
        ]
      },
      {
        type: 'Show',
        when: {
          helper: 'not',
          args: [
            {
              helper: 'signingProblem',
              args: [{var: 'group'}, {var: 'signerList'}]
            }
          ]
        },
        children: [
          {
            type: 'Button',
            label: 'Sign',
            onClick: {
              action: 'set',
              path: 'signResult',
              value: {
                helper: 'runMessageSign',
                args: [
                  {var: 'group'},
                  {var: 'signerList'},
                  {var: 'messageText'}
                ]
              }
            }
          }
        ]
      },
      {
        type: 'Show',
        when: {var: 'signResult'},
        children: [
          {
            type: 'Show',
            when: {helper: 'not', args: [{var: 'signResult.verified'}]},
            children: [
              {
                type: 'Text',
                value: '✗ did not verify - should never happen with real shares'
              }
            ]
          },
          {
            type: 'Show',
            when: {var: 'signResult.verified'},
            children: [
              {
                type: 'Text',
                value: {
                  cat: [
                    '✓ Verified as an ORDINARY BIP340 signature: ',
                    {var: 'signResult.finalSigHex'}
                  ]
                },
                style: 'response-block'
              }
            ]
          }
        ]
      }
    ]
  }
]

const lockUi: UiNode[] = [
  {
    type: 'Text',
    value: '3. Lock a real note to this group',
    style: 'subheading'
  },
  {
    type: 'Show',
    when: {helper: 'not', args: [{var: 'group'}]},
    children: [{type: 'Text', value: 'Set up a group above first.'}]
  },
  {
    type: 'Show',
    when: {and: [{var: 'group'}, {helper: 'not', args: [{var: 'lockedNote'}]}]},
    children: [
      {
        type: 'NotePicker',
        bind: 'selectedNote',
        filter: {spent: false},
        label: 'Note to lock'
      },
      {
        type: 'Show',
        when: {var: 'selectedNote'},
        children: [
          {
            type: 'Button',
            label: 'Lock to this group',
            onClick: {
              verb: 'note.lockToPubkey',
              args: {
                note: {var: 'selectedNote.id'},
                pubkeyHex: {var: 'group.groupPubkeyHex'},
                kind: 'cp1'
              },
              result: 'lockedNote'
            }
          }
        ]
      }
    ]
  },
  {
    type: 'Show',
    when: {var: 'lockedNote'},
    children: [
      {type: 'Text', value: '✓ Locked', style: 'response-block'},
      {
        type: 'Text',
        value:
          'Any t of n participants can now jointly prove ownership and redeem it - sign the fixed ownership message below with the SAME group, using the same "which participants sign" idea as step 2.'
      },
      {
        type: 'Input',
        bind: 'ownershipSignerList',
        label: 'Which participants sign the ownership proof (e.g. "1,3")'
      },
      {
        type: 'Show',
        when: {
          helper: 'not',
          args: [
            {
              helper: 'signingProblem',
              args: [{var: 'group'}, {var: 'ownershipSignerList'}]
            }
          ]
        },
        children: [
          {
            type: 'Button',
            label: 'Sign ownership proof',
            onClick: {
              action: 'set',
              path: 'ownershipResult',
              value: {
                helper: 'runThresholdSign',
                args: [
                  {var: 'group'},
                  {var: 'ownershipSignerList'},
                  CK1_OWNERSHIP_DIGEST_HEX
                ]
              }
            }
          }
        ]
      },
      {
        type: 'Show',
        when: {helper: 'ck1Accepted', args: [{var: 'ownershipResult'}]},
        children: [
          {
            type: 'Text',
            value:
              '✓ A valid threshold ownership proof - this note can be redeemed:',
            style: 'response-block'
          },
          {
            type: 'Button',
            label: 'Redeem into wallet',
            onClick: {
              verb: 'note.claim',
              args: {
                url: {
                  helper: 'lockedNoteUrl',
                  args: [{var: 'lockedNote'}, {var: 'ownershipResult'}]
                },
                callback: {var: 'lockedNote.callback'},
                amountMsat: {var: 'lockedNote.amountMsat'}
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
            value: '✓ Redeemed into your wallet',
            style: 'response-block'
          }
        ]
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
      'Pick a threshold t and a group size n, and generate the group - either a trusted dealer (fast, one party briefly sees the whole secret) or real DKG (no dealer, nobody ever sees the whole secret, more rounds under the hood).',
      'Sign a message naming any t (or more) of the n participants - genuinely fewer than everyone, unlike the sibling MuSig2 addon which always needs all of them.',
      'Lock one of your own notes to the group’s own pubkey, then have any t participants jointly produce the fixed ownership proof needed to redeem it - proving a real threshold group can genuinely custody value, not just sign a demo message.'
    ],
    children: [{type: 'Text', value: {var: 'item'}}]
  },
  {
    type: 'Text',
    value:
      'Every participant here is simulated locally on this one page - real, independent multi-party setup (each round pasted between separate people, the way the sibling MuSig2 addon already supports for its own two rounds) is a scoped follow-up, not built yet.'
  },
  {
    type: 'Text',
    value:
      'Also not yet: locking to a taproot-tweaked output (ct1 with a script leaf, like MuSig2 supports). The library function this needs exists but only via an internal test-only export in the installed version - not something to build a real feature on without it being a stable, verified API first.'
  }
]

const frostManifest: AddonManifest = {
  id: 'frost',
  name: 'FROST',
  version: '1',
  icon: 'snow',
  description:
    'Threshold Schnorr signatures (RFC 9591) - any t of a fixed n key shares can jointly sign, without the rest ever being needed. Genuinely different from MuSig2: that needs everyone, every time.',
  permissions: [
    {
      verb: 'note.lockToPubkey',
      scope: 'spent:false',
      reason: 'Lock one of your own notes to a FROST group’s own pubkey'
    },
    {
      verb: 'note.claim',
      reason:
        'Redeem a note this page locked, once the group has proven ownership'
    }
  ],
  nav: {position: 'right', icon: 'snow', label: 'FROST'},
  state: {
    thresholdT: 2,
    groupSizeN: 3,
    group: null,
    messageText: '',
    signerList: '',
    signResult: null,
    selectedNote: null,
    lockedNote: null,
    ownershipSignerList: '',
    ownershipResult: null,
    redeemResult: null
  },
  ui: {
    type: 'View',
    children: [
      {type: 'Text', value: 'FROST', style: 'heading'},
      {
        type: 'View',
        style: 'columns',
        children: [
          {
            type: 'View',
            style: 'col-left',
            children: [...setupUi, ...signUi, ...lockUi]
          },
          {type: 'View', style: 'col-right', children: docsUi}
        ]
      }
    ]
  }
}

const frostHelpers: Record<string, AddonHelper> = {
  setupProblem: setupProblem as AddonHelper,
  canSetUp: canSetUp as AddonHelper,
  setUpWithDealer: setUpWithDealer as AddonHelper,
  setUpWithDkg: setUpWithDkg as AddonHelper,
  groupCp1Preview: groupCp1Preview as AddonHelper,
  signingProblem: signingProblem as AddonHelper,
  runMessageSign: runMessageSign as AddonHelper,
  runThresholdSign: runThresholdSign as AddonHelper,
  ck1Accepted: ck1Accepted as AddonHelper,
  lockedNoteUrl: lockedNoteUrl as AddonHelper
}

export const frostAddon: Addon = {
  manifest: frostManifest,
  helpers: frostHelpers
}
