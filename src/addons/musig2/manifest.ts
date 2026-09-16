import type {Addon, AddonHelper, AddonManifest, UiNode} from '../types'
import {hexToBytes} from '@noble/hashes/utils.js'
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

// MuSig2 (BIP327) joint signatures - a "play around" sandbox, not wired
// into this wallet's own note-signing anywhere. All key material lives in
// this addon's own page-local state (never persisted, gone on reload - see
// AddonRun.tsx/Renderer.tsx's 'run' mode), never cashSecrets.ts or the
// wallet's real seed. permissions: [] below is load-bearing, not
// decorative: this addon declares zero verbs, so it has no way to touch a
// real note, mint, or address regardless of what a holder pastes into it.
// See the sibling `taproot` addon for BIP341 pubkey tweaking - split out
// separately since the two BIPs are genuinely different specs, not one
// feature.
const trimmedString = (value: unknown): string => String(value ?? '').trim()

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
// through on bad input, same reasoning as a deliberate button click always
// gets (Renderer.tsx's own runAction turns a thrown Error into a plain
// toast notification, unlike a live binding)
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

const musig2Manifest: AddonManifest = {
  id: 'musig2',
  name: 'MuSig2 Playground',
  version: '1',
  icon: 'people',
  description:
    'Play around with BIP327 MuSig2 joint Schnorr signatures - a sandbox, never wired into this wallet’s own notes. See the separate Taproot addon for BIP341 pubkey tweaking.',
  permissions: [],
  nav: {position: 'right', icon: 'people', label: 'MuSig2'},
  state: {
    participants: [],
    musigMessage: 'hello musig2',
    musigResult: null
  },
  ui: {
    type: 'View',
    children: musigUi
  }
}

// 'not' comes from GLOBAL_HELPERS (see globalHelpers.ts), merged in ahead
// of this addon's own helpers by Renderer.tsx - no need to redefine it
const musig2Helpers: Record<string, AddonHelper> = {
  newParticipant: newParticipant as AddonHelper,
  canAddParticipant: canAddParticipant as AddonHelper,
  canAggregate: canAggregate as AddonHelper,
  musigPreview: musigPreview as AddonHelper,
  runMusigRound: runMusigRound as AddonHelper,
  isCk1DemoMessage: isCk1DemoMessage as AddonHelper,
  ck1Display: ck1Display as AddonHelper,
  ck1Accepted: ck1Accepted as AddonHelper
}

export const musig2Addon: Addon = {
  manifest: musig2Manifest,
  helpers: musig2Helpers
}
