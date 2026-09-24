import type {Addon, AddonHelper, AddonManifest, UiNode} from '../types'
import {toLud17w, toBech32Lnurl, withoutSignature} from '../../lnurlcash'
import {
  betProblem,
  betReceiptUrl,
  counterpartyProblem,
  formatUnlock,
  parseBetReceipt,
  planBet,
  receiptProblem,
  refundDateProblem,
  refundNoteUrl,
  type BetPlan,
  type BetReceipt
} from './betlock'
import type {
  OracleAttestationResult,
  OracleEventSummary
} from '../dlc/oracleClient'

// Betlocker: lock one of your notes to the outcome of a real-world event,
// via a Discreet Log Contract oracle - the sibling `timelocker` addon, but
// the condition is "an oracle attests to X" instead of "a date has
// passed". See the sibling `dlc` addon for the oracle cryptography itself
// (build an announcement there first, or paste in a real one), and
// betlock.ts's own top comment for exactly why this is a genuine two-step
// flow (LOCK now, REDEEM only once an attestation exists) where
// timelocker's own equivalent collapses to one.
//
// Race-to-claim by default, not counterparty-bound: a leaf is
// `<outcome point> CHECKSIG` alone, with no combination against a specific
// winner's own key. Once the oracle attests, whoever redeems first gets
// the note - hand the lock's own receipt only to whoever should be able
// to claim it, and redeem promptly once you expect the oracle to have
// attested. Optionally name a specific redeemer instead (see betlock.ts's
// own top comment) - either way, every bet also gets a MANDATORY refund
// leaf: if the oracle never resolves the event, the note isn't locked
// forever - the original staker can reclaim it after the deadline they
// pick at lock time.

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

// ---- browsing a live oracle (Lock side) - see verbs.ts's own
// oracle.fetchPubkey/oracle.fetchEvents/oracle.fetchAnnouncement, and
// oracleClient.ts for what a fetched pubkey/event/announcement actually
// looks like. Purely an alternative way to arrive at the exact same `plan`
// the manual oraclePubkeyHex/nonceHex/outcomes fields above already
// produce via planBet - see the "Use this event" button below, which
// calls planBet with the fetched announcement's fields plus
// oracleBaseUrl/eventId so the resulting plan (and later, the receipt)
// carries them along too. ----

// only an event that hasn't resolved yet makes sense to offer for a NEW
// bet - not unsafe to lock against a resolved one (the crypto doesn't
// care), just a pointless bet since the outcome is already public
const isOpenEvent = (item: unknown): boolean =>
  (item as OracleEventSummary | null)?.status === 'announced'

const joinOutcomes = (outcomes: unknown): string =>
  Array.isArray(outcomes) ? (outcomes as string[]).join(', ') : ''

// ---- naming a counterparty (optional, Lock side) - note.resolveAddressPubkey
// (verbs.ts) returns a 33-byte COMPRESSED pubkey (02||x, the musig2 addon's
// own convention), but every leaf template here works in BIP340's 32-byte
// x-only form (see taproot.ts's own CHECKSIG templates) - strips that
// prefix. Already-x-only input passes through unchanged, so this is safe
// to apply everywhere counterpartyPubkeyHex is actually used, regardless
// of exactly which shape produced it. ----
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

// lnurlw:// (LUD-17), optionally the classic LUD-01 bech32 encoding - same
// pair of toggles the sibling timelocker addon offers, same reasoning.
// stripSig, when set, strips the underlying note's own offline-verification
// sig first (src/lib/urls.ts's withoutSignature - same toggle/reasoning as
// BearerCard.tsx's own "Offline verified" checkbox): the receipt's own
// oracle/nonce/outcomes fields are never touched by this either way - they
// carry no mint-identifying signature themselves, only the underlying note
// URL's sig does.
const receiptUrlFor = (
  lockedNote: unknown,
  plan: unknown,
  bech32: unknown,
  stripSig: unknown
): string | null => {
  const url = betReceiptUrl(lockedNote, plan)
  if (!url) return null
  const stripped = stripSig ? withoutSignature(url) : url
  const plain = toLud17w(stripped)
  return bech32 ? toBech32Lnurl(plain) : plain
}

const receiptText = (
  lockedNote: unknown,
  plan: unknown,
  stripSig: unknown
): string => {
  const locked = lockedNote as LockedNote | null
  const p = plan as BetPlan | null
  const url = betReceiptUrl(lockedNote, plan)
  if (!url || !locked || !p) return ''
  const stripped = stripSig ? withoutSignature(url) : url
  return [
    'Betlocker receipt',
    `Amount: ${Math.floor(locked.amountMsat / 1000)} sats`,
    `Outcomes: ${p.outcomes.join(', ')}`,
    'This receipt alone cannot redeem anything - you also need the',
    'oracle’s own published attestation for whichever outcome happens.',
    'Once the oracle attests, whoever redeems first gets the note - keep',
    'this receipt only if you’re the one who should be able to claim it.',
    '',
    toLud17w(stripped)
  ].join('\n')
}

// what a pasted receipt says about itself, live while typing/pasting
const receiptOutcomes = (value: unknown): string => {
  const receipt = parseBetReceipt(value)
  return receipt ? receipt.outcomes.join(', ') : ''
}

// the same list as receiptOutcomes above, unjoined - a receipt's own
// outcomes are a fixed, known set the instant it parses, so picking which
// one the oracle attested to is a selection among THESE exact values, not
// free text a holder could mistype against them
const receiptOutcomesList = (value: unknown): string[] =>
  parseBetReceipt(value)?.outcomes ?? []

// a checkmark on whichever outcome button is currently selected (manually,
// or via an auto-fetched attestation - see this file's own call site,
// which passes effectiveOutcome(...) rather than the raw bound field)
const outcomeButtonLabel = (item: unknown, selected: unknown): string =>
  item === selected ? `✓ ${String(item)}` : String(item)

// ---- auto-fetching an attestation (Redeem side) - only possible when the
// receipt itself carries the discovery metadata a real oracle's own
// announcement puts there (see BetPlan's own doc comment in betlock.ts);
// a receipt built from a hand-typed/pasted announcement falls back to the
// manual attestOutcome/attestSignatureHex fields below unchanged. ----

const canAutoFetchAttestation = (receiptInput: unknown): boolean => {
  const receipt = parseBetReceipt(receiptInput)
  return !!receipt?.oracleServiceUrl && !!receipt?.eventId
}

const receiptOracleServiceUrl = (receiptInput: unknown): string =>
  parseBetReceipt(receiptInput)?.oracleServiceUrl ?? ''

const receiptEventId = (receiptInput: unknown): string =>
  parseBetReceipt(receiptInput)?.eventId ?? ''

// ---- checking the event's own status (Redeem side) - the "has this even
// matured yet, what does the oracle itself say the outcomes are" question,
// answerable straight from the same oracle.fetchAnnouncement verb the Lock
// side's "Browse a live oracle" flow already uses (verbs.ts), reusing the
// SAME discovery metadata (oracleServiceUrl/eventId) canAutoFetchAttestation
// above gates on - a holder shouldn't have to guess whether "not resolved
// yet" from Fetch attestation means "still days away" or "any minute now"
// without a separate, deliberate lookup. ----

// unix SECONDS (lnurlcash-oracle's own maturity_time column, per
// oracle_service.py's own `time.time()` comparison) - never milliseconds
const formatMaturity = (maturityTime: unknown): string => {
  const seconds = Number(maturityTime)
  if (!Number.isFinite(seconds)) return 'unknown'
  return new Date(seconds * 1000).toLocaleString()
}

// whether the event's own maturity time has passed - even once it has, the
// oracle may not have attested yet (resolution isn't instant - see
// lnurl-mint's own scheduled poll), so this is "could resolve any time
// now", not "has resolved"; attestationResolved (via Fetch attestation) is
// the only real answer to that
const eventMatured = (maturityTime: unknown): boolean => {
  const seconds = Number(maturityTime)
  return Number.isFinite(seconds) && Date.now() >= seconds * 1000
}

// whether THIS receipt is locked to a specific redeemer (see betlock.ts's
// own top comment) - only then does the Redeem UI need to ask for a
// secret key at all; a plain race-to-claim receipt redeems exactly as it
// always has
const receiptNeedsRedeemerSecret = (receiptInput: unknown): boolean =>
  !!parseBetReceipt(receiptInput)?.counterpartyPubkeyHex

// gates the Redeem button on top of canRedeem below - a counterparty-bound
// receipt additionally needs a well-shaped secret key entered; a plain
// receipt needs nothing extra (buildRedeemCw1 itself is the real check
// either way, this is just when to let the button enable at all)
const hasRedeemerSecretIfNeeded = (
  receiptInput: unknown,
  redeemerSecretKeyHex: unknown
): boolean =>
  !receiptNeedsRedeemerSecret(receiptInput) ||
  /^[0-9a-f]{64}$/i.test(String(redeemerSecretKeyHex ?? '').trim())

const attestationResolved = (fetched: unknown): boolean =>
  (fetched as OracleAttestationResult | null)?.resolved === true

// the value actually used to redeem: a resolved auto-fetch always wins
// over whatever's sitting in the manual field (a fresh fetch reflects the
// oracle's own current state; a stale manual paste shouldn't silently
// override it), otherwise falls back to the manual field untouched
const effectiveOutcome = (fetched: unknown, manual: unknown): string => {
  const f = fetched as OracleAttestationResult | null
  return f?.resolved ? f.outcome : String(manual ?? '').trim()
}

const effectiveSignatureHex = (fetched: unknown, manual: unknown): string => {
  const f = fetched as OracleAttestationResult | null
  return f?.resolved ? f.signatureHex : String(manual ?? '').trim()
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
      {type: 'Text', value: 'Let someone else redeem this (optional)'},
      {
        type: 'Text',
        value:
          'Leave blank for the default: whoever has the receipt once the oracle attests, first to redeem wins. Fill this in to also require a signature from one specific person - only they (and the oracle, together) can ever redeem it.'
      },
      {
        type: 'Input',
        bind: 'counterpartyAddress',
        label: 'Their Lightning Address, cx1/cp1 address, or username'
      },
      {
        type: 'Button',
        label: 'Resolve pubkey',
        onClick: {
          verb: 'note.resolveAddressPubkey',
          args: {
            address: {var: 'counterpartyAddress'},
            mintNote: {var: 'selectedNote.id'}
          },
          result: 'counterpartyPubkeyHex'
        }
      },
      {
        type: 'Show',
        when: {var: 'counterpartyPubkeyHex'},
        children: [
          {
            type: 'Text',
            value: {
              cat: [
                'Redeemer pubkey: ',
                {
                  helper: 'xOnlyPubkeyHex',
                  args: [{var: 'counterpartyPubkeyHex'}]
                }
              ]
            },
            style: 'response-block'
          },
          {
            type: 'Button',
            label: 'Clear',
            onClick: {action: 'set', path: 'counterpartyPubkeyHex', value: ''}
          }
        ]
      },
      {
        type: 'Show',
        when: {
          helper: 'counterpartyProblem',
          args: [
            {helper: 'xOnlyPubkeyHex', args: [{var: 'counterpartyPubkeyHex'}]}
          ]
        },
        children: [
          {
            type: 'Text',
            value: {
              helper: 'counterpartyProblem',
              args: [
                {
                  helper: 'xOnlyPubkeyHex',
                  args: [{var: 'counterpartyPubkeyHex'}]
                }
              ]
            }
          }
        ]
      },
      {type: 'Text', value: 'Refund deadline (required)'},
      {
        type: 'Text',
        value:
          'Every bet locked here gets a built-in escape hatch: if the oracle never resolves this event, you can reclaim your stake yourself after this date. Pick it well past when you expect the event to actually resolve.'
      },
      {
        type: 'Input',
        bind: 'refundDate',
        kind: 'datetime',
        label: 'Reclaim after'
      },
      {
        type: 'Show',
        when: {helper: 'refundDateProblem', args: [{var: 'refundDate'}]},
        children: [
          {
            type: 'Text',
            value: {helper: 'refundDateProblem', args: [{var: 'refundDate'}]}
          }
        ]
      },
      {type: 'Text', value: 'Browse a live oracle (optional)'},
      {
        type: 'Input',
        bind: 'oracleBaseUrl',
        label: 'Oracle URL (set a default on the Settings page)'
      },
      {
        type: 'Button',
        label: 'Fetch oracle pubkey',
        onClick: {
          verb: 'oracle.fetchPubkey',
          args: {baseUrl: {var: 'oracleBaseUrl'}},
          // straight into the SAME field the manual "Oracle pubkey" input
          // further down binds to (Renderer.tsx's runAction does a raw
          // setStore(path, result), and this verb returns a bare pubkey
          // string, matching note.resolveAddressPubkey's own convention) -
          // no separate field to keep in sync, and it's exactly what a
          // holder would otherwise have had to copy-paste in by hand
          result: 'oraclePubkeyHex'
        }
      },
      {
        type: 'Show',
        when: {var: 'oraclePubkeyHex'},
        children: [
          {
            type: 'Text',
            value: {cat: ['This oracle: ', {var: 'oraclePubkeyHex'}]},
            style: 'response-block'
          }
        ]
      },
      {
        type: 'Button',
        label: 'Fetch events',
        onClick: {
          verb: 'oracle.fetchEvents',
          args: {baseUrl: {var: 'oracleBaseUrl'}},
          result: 'oracleEvents'
        }
      },
      {
        type: 'Show',
        when: {var: 'oracleEvents'},
        children: [
          {
            type: 'For',
            each: {var: 'oracleEvents'},
            children: [
              {
                type: 'Show',
                when: {helper: 'isOpenEvent', args: [{var: 'item'}]},
                children: [
                  {
                    type: 'View',
                    style: 'row',
                    children: [
                      {
                        type: 'Text',
                        value: {
                          cat: [
                            {var: 'item.eventId'},
                            ' (',
                            {var: 'item.category'},
                            ') - ',
                            {
                              helper: 'joinOutcomes',
                              args: [{var: 'item.outcomes'}]
                            }
                          ]
                        }
                      },
                      {
                        type: 'Button',
                        label: 'Use this event',
                        onClick: {
                          verb: 'oracle.fetchAnnouncement',
                          args: {
                            baseUrl: {var: 'oracleBaseUrl'},
                            eventId: {var: 'item.eventId'}
                          },
                          result: 'fetchedAnnouncement'
                        }
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      },
      {
        type: 'Show',
        when: {var: 'fetchedAnnouncement'},
        children: [
          {
            type: 'Text',
            value: {
              cat: [
                'Fetched "',
                {var: 'fetchedAnnouncement.eventId'},
                '" - outcomes: ',
                {
                  helper: 'joinOutcomes',
                  args: [{var: 'fetchedAnnouncement.outcomes'}]
                }
              ]
            },
            style: 'response-block'
          },
          {
            type: 'Show',
            when: {helper: 'not', args: [{var: 'selectedNote'}]},
            children: [
              {type: 'Text', value: 'Pick a note to stake above first.'}
            ]
          },
          {
            type: 'Show',
            when: {
              and: [
                {var: 'selectedNote'},
                {
                  helper: 'not',
                  args: [
                    {helper: 'refundDateProblem', args: [{var: 'refundDate'}]}
                  ]
                }
              ]
            },
            children: [
              {
                type: 'Button',
                label: 'Prepare bet from this event',
                onClick: {
                  action: 'set',
                  path: 'plan',
                  value: {
                    helper: 'planBet',
                    args: [
                      {var: 'fetchedAnnouncement.oraclePubkeyHex'},
                      {var: 'fetchedAnnouncement.nonceHex'},
                      {var: 'fetchedAnnouncement.outcomes'},
                      {
                        helper: 'satsToMsat',
                        args: [{var: 'selectedNote.amountSat'}]
                      },
                      {var: 'refundDate'},
                      {var: 'selectedNote.mint'},
                      {var: 'oracleBaseUrl'},
                      {var: 'fetchedAnnouncement.eventId'},
                      {
                        helper: 'xOnlyPubkeyHex',
                        args: [{var: 'counterpartyPubkeyHex'}]
                      }
                    ]
                  }
                }
              }
            ]
          }
        ]
      },
      {type: 'Text', value: '...or paste an announcement manually'},
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
            label: 'Prepare bet',
            onClick: {
              action: 'set',
              path: 'plan',
              value: {
                helper: 'planBet',
                args: [
                  {var: 'oraclePubkeyHex'},
                  {var: 'nonceHex'},
                  {var: 'outcomes'},
                  {
                    helper: 'satsToMsat',
                    args: [{var: 'selectedNote.amountSat'}]
                  },
                  {var: 'refundDate'},
                  {var: 'selectedNote.mint'},
                  null,
                  null,
                  {
                    helper: 'xOnlyPubkeyHex',
                    args: [{var: 'counterpartyPubkeyHex'}]
                  }
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
        type: 'Show',
        when: {var: 'plan.counterpartyPubkeyHex'},
        children: [
          {
            type: 'Text',
            value: {
              cat: ['Redeemable only by: ', {var: 'plan.counterpartyPubkeyHex'}]
            }
          }
        ]
      },
      {
        type: 'Show',
        when: {helper: 'not', args: [{var: 'refundClaimResult'}]},
        children: [
          {
            type: 'Text',
            value: {
              cat: [
                'A refund note was also generated - if the oracle never resolves this event, you can reclaim your stake after ',
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
        type: 'Input',
        bind: 'useBech32',
        kind: 'checkbox',
        label: 'Encode receipt as bech32 (LNURL1…)'
      },
      {
        type: 'Input',
        bind: 'stripOfflineSig',
        kind: 'checkbox',
        label:
          'Strip offline-verification sig (recipient can no longer check the note against the mint’s pinned key without asking it directly)'
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
          args: [
            {var: 'lockedNote'},
            {var: 'plan'},
            {var: 'useBech32'},
            {var: 'stripOfflineSig'}
          ]
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
              args: [
                {var: 'lockedNote'},
                {var: 'plan'},
                {var: 'useBech32'},
                {var: 'stripOfflineSig'}
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
            filename: 'betlocker-receipt.txt',
            content: {
              helper: 'receiptText',
              args: [
                {var: 'lockedNote'},
                {var: 'plan'},
                {var: 'stripOfflineSig'}
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
      {type: 'Text', value: 'Which outcome did the oracle attest to?'},
      {
        type: 'View',
        style: 'row',
        children: [
          {
            type: 'For',
            each: {
              helper: 'receiptOutcomesList',
              args: [{var: 'receiptInput'}]
            },
            children: [
              {
                type: 'Button',
                label: {
                  helper: 'outcomeButtonLabel',
                  args: [
                    {var: 'item'},
                    {
                      helper: 'effectiveOutcome',
                      args: [
                        {var: 'fetchedAttestation'},
                        {var: 'attestOutcome'}
                      ]
                    }
                  ]
                },
                onClick: {
                  action: 'set',
                  path: 'attestOutcome',
                  value: {var: 'item'}
                }
              }
            ]
          }
        ]
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
    type: 'Show',
    when: {helper: 'canAutoFetchAttestation', args: [{var: 'receiptInput'}]},
    children: [
      {
        type: 'Button',
        label: 'Check event status',
        onClick: {
          verb: 'oracle.fetchAnnouncement',
          args: {
            baseUrl: {
              helper: 'receiptOracleServiceUrl',
              args: [{var: 'receiptInput'}]
            },
            eventId: {helper: 'receiptEventId', args: [{var: 'receiptInput'}]}
          },
          result: 'fetchedEventStatus'
        }
      },
      {
        type: 'Show',
        when: {var: 'fetchedEventStatus'},
        children: [
          {
            type: 'Text',
            value: {
              cat: [
                'Event "',
                {var: 'fetchedEventStatus.eventId'},
                '" - outcomes: ',
                {
                  helper: 'joinOutcomes',
                  args: [{var: 'fetchedEventStatus.outcomes'}]
                },
                ' - matures ',
                {
                  helper: 'formatMaturity',
                  args: [{var: 'fetchedEventStatus.maturityTime'}]
                }
              ]
            },
            style: 'response-block'
          },
          {
            type: 'Show',
            when: {
              helper: 'eventMatured',
              args: [{var: 'fetchedEventStatus.maturityTime'}]
            },
            children: [
              {
                type: 'Text',
                value:
                  'Past maturity - the oracle may not have attested yet (resolution is never instant or a guess ahead of time). Try Fetch attestation below.'
              }
            ]
          },
          {
            type: 'Show',
            when: {
              helper: 'not',
              args: [
                {
                  helper: 'eventMatured',
                  args: [{var: 'fetchedEventStatus.maturityTime'}]
                }
              ]
            },
            children: [
              {
                type: 'Text',
                value:
                  'Not matured yet - the oracle will not attest before this time.'
              }
            ]
          }
        ]
      },
      {
        type: 'Button',
        label: 'Fetch attestation from oracle',
        onClick: {
          verb: 'oracle.fetchAttestation',
          args: {
            baseUrl: {
              helper: 'receiptOracleServiceUrl',
              args: [{var: 'receiptInput'}]
            },
            eventId: {helper: 'receiptEventId', args: [{var: 'receiptInput'}]}
          },
          result: 'fetchedAttestation'
        }
      },
      {
        type: 'Show',
        when: {
          helper: 'attestationResolved',
          args: [{var: 'fetchedAttestation'}]
        },
        children: [
          {
            type: 'Text',
            value: {
              cat: [
                '✓ Oracle attested: ',
                {
                  helper: 'effectiveOutcome',
                  args: [{var: 'fetchedAttestation'}, {var: 'attestOutcome'}]
                }
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
            {var: 'fetchedAttestation'},
            {
              helper: 'not',
              args: [
                {
                  helper: 'attestationResolved',
                  args: [{var: 'fetchedAttestation'}]
                }
              ]
            }
          ]
        },
        children: [
          {
            type: 'Text',
            value:
              'Not resolved yet - check back after the event matures, or select the outcome above and paste the signature below if you have it from elsewhere.'
          }
        ]
      }
    ]
  },
  {
    type: 'Input',
    bind: 'attestSignatureHex',
    label: 'Oracle’s attestation signature (64-byte hex)'
  },
  {
    type: 'Show',
    when: {helper: 'receiptNeedsRedeemerSecret', args: [{var: 'receiptInput'}]},
    children: [
      {
        type: 'Text',
        value:
          'This bet is locked to a specific redeemer - only your own secret key for that pubkey can complete it. Never transmitted anywhere; used only to sign locally.'
      },
      {
        type: 'Input',
        bind: 'redeemerSecretKeyHex',
        label: 'Your secret key (32-byte hex)'
      }
    ]
  },
  {
    type: 'Show',
    when: {
      and: [
        {
          helper: 'canRedeem',
          args: [
            {var: 'receiptInput'},
            {
              helper: 'effectiveOutcome',
              args: [{var: 'fetchedAttestation'}, {var: 'attestOutcome'}]
            },
            {
              helper: 'effectiveSignatureHex',
              args: [{var: 'fetchedAttestation'}, {var: 'attestSignatureHex'}]
            }
          ]
        },
        {
          helper: 'hasRedeemerSecretIfNeeded',
          args: [{var: 'receiptInput'}, {var: 'redeemerSecretKeyHex'}]
        }
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
            outcome: {
              helper: 'effectiveOutcome',
              args: [{var: 'fetchedAttestation'}, {var: 'attestOutcome'}]
            },
            signatureHex: {
              helper: 'effectiveSignatureHex',
              args: [{var: 'fetchedAttestation'}, {var: 'attestSignatureHex'}]
            },
            redeemerSecretKeyHex: {var: 'redeemerSecretKeyHex'}
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
      'Optionally name someone else’s pubkey to require their signature too, and pick a refund deadline (required on every bet).',
      'Pick one of your own notes to stake, click ’Prepare bet’, then ’Lock this note’. It’s burned at the mint and re-issued as a taproot note with one leaf per outcome plus a refund leaf - nobody can spend ANY of them yet.',
      'Add the refund note to your wallet right away - it only becomes spendable after the deadline, and only by you.',
      'Copy the receipt - it’s the only record of this bet, though it cannot redeem anything by itself.',
      'Once the event resolves and the oracle publishes its attestation (an outcome plus a signature), paste the receipt and the attestation here and redeem. If it never resolves, redeem your refund note instead once its own deadline passes.'
    ],
    children: [{type: 'Text', value: {var: 'item'}}]
  },
  {
    type: 'Text',
    value:
      'Race-to-claim by default: a leaf is just <outcome point> CHECKSIG, not bound to any specific counterparty’s own key, unless you named one at lock time. Once the oracle attests, whoever redeems first gets the note. The outcomes that did NOT happen stay provably unspendable forever - the oracle never signs them, so nobody, ever, can compute a private key for their leaf.'
  },
  {
    type: 'Text',
    value:
      'Never locked forever: every bet also gets a refund leaf, spendable only by the original staker, only after the deadline picked at lock time - a real escape hatch if the oracle simply never resolves the event.'
  },
  {
    type: 'Text',
    value:
      'The lock cannot be undone. Any LUD-25 mint redeems the script path - it accepts every leaf, the same way it accepts a signature.'
  }
]

const betlockerManifest: AddonManifest = {
  id: 'betlocker',
  name: 'Betlocker',
  version: '1',
  icon: 'dice',
  experimental: true,
  description:
    'Lock one of your notes on the outcome of a real-world event via a Discreet Log Contract oracle - a race-to-claim bearer bet (or, optionally, bound to one named redeemer), with a built-in refund deadline so it’s never locked forever.',
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
    },
    {
      verb: 'oracle.fetchPubkey',
      reason: 'Fetch a real oracle service’s own published identity pubkey'
    },
    {
      verb: 'oracle.fetchEvents',
      reason: 'List the events a real oracle service has published'
    },
    {
      verb: 'oracle.fetchAnnouncement',
      reason:
        'Fetch one event’s full announcement (oracle pubkey, nonce, outcomes) to prepare a bet against it'
    },
    {
      verb: 'oracle.fetchAttestation',
      reason:
        'Check whether an oracle has published an attestation yet for a bet you’re redeeming'
    },
    {
      verb: 'note.resolveAddressPubkey',
      reason:
        'Resolve a Lightning Address/cx1/cp1/username into a pubkey, to optionally name who else can redeem a bet you lock'
    },
    {
      verb: 'note.claim',
      reason:
        'Add this bet’s own refund note to your wallet right after locking, so you can reclaim your stake later if the oracle never resolves'
    }
  ],
  nav: {position: 'right', icon: 'dice', label: 'Betlocker'},
  state: {
    selectedNote: null,
    counterpartyAddress: '',
    counterpartyPubkeyHex: '',
    refundDate: '',
    oracleBaseUrl: '',
    oracleEvents: null,
    fetchedAnnouncement: null,
    oraclePubkeyHex: '',
    nonceHex: '',
    outcomes: [],
    newOutcome: '',
    plan: null,
    lockedNote: null,
    refundClaimResult: null,
    useBech32: false,
    stripOfflineSig: false,
    receiptInput: '',
    fetchedEventStatus: null,
    fetchedAttestation: null,
    attestOutcome: '',
    attestSignatureHex: '',
    redeemerSecretKeyHex: '',
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
  },
  // one setting: the oracle service this addon reaches for by default -
  // see settingsStore.ts/AddonRun.tsx for how this seeds the run page's
  // own oracleBaseUrl above at mount (and stays freely editable per-run
  // from there without writing back). No verb dispatcher exists on this
  // page (types.ts's own AddonManifest.settings doc comment) - it's a
  // plain text field, structurally incapable of reaching the network.
  settings: {
    state: {oracleBaseUrl: ''},
    ui: {
      type: 'View',
      children: [
        {
          type: 'Text',
          value:
            'Default oracle service to browse events from when locking a bet, and to check for an attestation when redeeming one. Leave blank to always enter it by hand instead.'
        },
        {
          type: 'Input',
          bind: 'oracleBaseUrl',
          label: 'Oracle URL (e.g. https://oracle.lnurlcash.com)'
        }
      ]
    }
  }
}

const outcomeList = (plan: unknown): string =>
  (plan as BetPlan | null)?.outcomes.join(', ') ?? '-'

const betlockerHelpers: Record<string, AddonHelper> = {
  problemOf: problemOf as AddonHelper,
  noProblem: noProblem as AddonHelper,
  canAddOutcome: canAddOutcome as AddonHelper,
  isOpenEvent: isOpenEvent as AddonHelper,
  joinOutcomes: joinOutcomes as AddonHelper,
  xOnlyPubkeyHex: xOnlyPubkeyHex as AddonHelper,
  counterpartyProblem: counterpartyProblem as AddonHelper,
  refundDateProblem: refundDateProblem as AddonHelper,
  refundNoteUrl: refundNoteUrl as AddonHelper,
  formatUnlock: formatUnlock as AddonHelper,
  planBet: planBet as AddonHelper,
  outcomeList: outcomeList as AddonHelper,
  receiptUrlFor: receiptUrlFor as AddonHelper,
  receiptText: receiptText as AddonHelper,
  receiptOutcomes: receiptOutcomes as AddonHelper,
  receiptOutcomesList: receiptOutcomesList as AddonHelper,
  outcomeButtonLabel: outcomeButtonLabel as AddonHelper,
  receiptProblem: receiptProblem as AddonHelper,
  canAutoFetchAttestation: canAutoFetchAttestation as AddonHelper,
  receiptOracleServiceUrl: receiptOracleServiceUrl as AddonHelper,
  receiptEventId: receiptEventId as AddonHelper,
  formatMaturity: formatMaturity as AddonHelper,
  eventMatured: eventMatured as AddonHelper,
  receiptNeedsRedeemerSecret: receiptNeedsRedeemerSecret as AddonHelper,
  hasRedeemerSecretIfNeeded: hasRedeemerSecretIfNeeded as AddonHelper,
  attestationResolved: attestationResolved as AddonHelper,
  effectiveOutcome: effectiveOutcome as AddonHelper,
  effectiveSignatureHex: effectiveSignatureHex as AddonHelper,
  canRedeem: canRedeem as AddonHelper
}

export const betlockerAddon: Addon = {
  manifest: betlockerManifest,
  helpers: betlockerHelpers
}

// re-exported for the addon system's own type re-checking convenience
export type {BetPlan, BetReceipt}
