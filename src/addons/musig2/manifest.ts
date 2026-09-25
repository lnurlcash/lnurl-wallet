import type {Addon, AddonHelper, AddonManifest, UiNode} from '../types'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {
  newParticipant,
  aggregatePubkeys,
  aggregateAndSignBytes,
  generateNonce,
  aggregateNonces,
  partialSign,
  verifyPartialSig,
  combineStagedRound,
  type Musig2Participant,
  type Musig2Result
} from './musig2'
// pure, permission-free math (encoding + local signature verification, no
// network/wallet-state access) - same "sandbox stays a sandbox" reasoning
// bech32Decoder's own addon already relies on for verifyNoteSignature. Also
// re-exports withNewK1, used the same pure way - see lockedNoteUrl below.
// Resolving a cp1/cx1 address, Lightning Address, or username into a
// pubkey (verbs.ts's note.resolveAddressPubkey) needs a network round trip
// and lives behind a verb instead, not here.
import {
  encodeCk1,
  encodeCp1,
  keyPathSighash,
  recoverNoteOwnershipPubkey,
  withNewK1
} from '../../lnurlcash'
// the sibling Taproot addon's own script-tree machinery, reused rather than
// reimplemented - only its pure pieces (row shape, leaf compilation, BIP341
// tweaking), never its UI, so the two manifests stay independent
import {
  SCRIPT_TEMPLATES,
  scriptTemplateById,
  newScriptRow,
  rowCompiled,
  leafScriptsFor,
  tweakPubkey,
  type ScriptTemplateId
} from '../taproot/taproot'

// MuSig2 (BIP327) joint signatures - mostly still a "play around" sandbox:
// every participant's key material lives in this addon's own page-local
// state (never persisted, gone on reload - see AddonRun.tsx/Renderer.tsx's
// 'run' mode), never cashSecrets.ts or the wallet's real seed, and nothing
// above the "lock a note" section below touches a real note, mint, or
// wallet balance regardless of what a holder pastes into it. The ONE
// exception (permissions below is no longer an empty, decorative array):
// this addon can rotate a note the holder explicitly picks into one owned
// by the group pubkey it just computed (see verbs.ts's note.lockToPubkey)
// and, once this same page has also produced a valid ck1 for that exact
// group, can claim the resulting note back into the wallet (note.claim) -
// the actual point of the whole exercise, not just a math demo. See the
// sibling `taproot` addon for BIP341 pubkey tweaking - split out
// separately since the two BIPs are genuinely different specs, not one
// feature.
const MAX_PARTICIPANTS = 3

// same "keep the demo comprehensible" cap as MAX_PARTICIPANTS - BIP341
// itself has no such limit (a real tree can be far deeper)
const MAX_SCRIPT_LEAVES = 3

const participantCount = (participants: unknown): number =>
  Array.isArray(participants) ? participants.length : 0

const canAddParticipant = (participants: unknown): boolean =>
  participantCount(participants) < MAX_PARTICIPANTS

const canAggregate = (participants: unknown): boolean =>
  participantCount(participants) >= 2

const asParticipants = (participants: unknown): Musig2Participant[] =>
  Array.isArray(participants) ? (participants as Musig2Participant[]) : []

const PUBKEY_HEX_PATTERN = /^[0-9a-f]{66}$/

// a participant added by pasting in someone else's pubkey rather than
// generating a fresh local keypair - this page has no secret key for one
// of these, so it can neither nonce nor sign on its behalf (see the staged
// helpers below, which is the only path that still lets it take part)
const canAddExternalPubkey = (
  participants: unknown,
  pubkeyInput: unknown
): boolean =>
  canAddParticipant(participants) &&
  PUBKEY_HEX_PATTERN.test(
    String(pubkeyInput ?? '')
      .trim()
      .toLowerCase()
  )

// the "Add external pubkey" button's own helper - deliberately throws on a
// malformed paste, same reasoning as every other deliberate-click helper
// in this file (Renderer.tsx's runAction turns it into a toast)
const addExternalParticipant = (pubkeyInput: unknown): Musig2Participant => {
  const trimmed = String(pubkeyInput ?? '')
    .trim()
    .toLowerCase()
  if (!PUBKEY_HEX_PATTERN.test(trimmed)) {
    throw new Error(
      'Enter a 33-byte compressed pubkey as 66 hex characters (e.g. 02.../03...).'
    )
  }
  return {pubkeyHex: trimmed}
}

// true once every participant is a local, freshly-generated keypair - the
// gate between the original one-click "Aggregate & sign" path (still used
// unchanged below) and the staged nonce/sign flow a pubkey-only
// participant needs instead
const allLocal = (participants: unknown): boolean =>
  asParticipants(participants).every(p => Boolean(p.secretKeyHex))

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

// the same group pubkey musigPreview shows, bech32m-encoded exactly the way
// a real cp1 note address is (see src/lib/recoverableNotes.ts's encodeCp1) -
// aggregatePubkeys/keyAggExport already return the 32-byte x-only form cp1
// needs, no reformatting required. Shown as soon as 2+ participants exist,
// same gating as the raw-hex preview above: whoever controls the aggregate
// key can later mint (or redeem an internal transfer/combine/split into)
// a note at this address, then prove ownership with the group's own joint
// ck1 signature - see this addon's own worked example below for that half.
const musigCp1Preview = (participants: unknown): string => {
  const hex = musigPreview(participants)
  if (hex === '-') return '-'
  try {
    return encodeCp1(hexToBytes(hex))
  } catch {
    return '-'
  }
}

// What every round here signs: exactly what a real ck1 signs - the LUD-25
// key-path sighash (src/lib/spend.ts's keyPathSighash) for the key a lock
// would name (lockTargetHex below), bound to a mint's domain. Once a note
// is locked, that is the locked note's own mint, so a round signed after
// locking IS that note's ck1, checked against this wallet's own
// verification code (recoverNoteOwnershipPubkey); before any note is
// locked it is a placeholder domain, so the demo still runs end to end -
// but a signature bound to it opens nothing at a real mint.
const DEMO_DOMAIN = 'mint.example'

const signingDomain = (lockedNote: unknown): string =>
  (lockedNote as {mint?: unknown} | null)?.mint &&
  typeof (lockedNote as {mint: unknown}).mint === 'string'
    ? (lockedNote as {mint: string}).mint
    : DEMO_DOMAIN

const roundDigest = (
  participants: unknown,
  scripts: unknown,
  lockedNote: unknown
): Uint8Array =>
  keyPathSighash(
    hexToBytes(lockTargetHex(participants, scripts)),
    signingDomain(lockedNote)
  )

// the message a co-signer elsewhere needs, shown live - '-' until the group
// has a key to sign for
const roundDigestPreview = (
  participants: unknown,
  scripts: unknown,
  lockedNote: unknown
): string => {
  try {
    return roundDigestHex(participants, scripts, lockedNote)
  } catch {
    return '-'
  }
}

const lockedMintLabel = (lockedNote: unknown): string => {
  const mint = signingDomain(lockedNote)
  return mint === DEMO_DOMAIN
    ? `the placeholder mint ${DEMO_DOMAIN} - lock a note to sign for its own`
    : `the locked note's mint ${mint}`
}

const roundDigestHex = (
  participants: unknown,
  scripts: unknown,
  lockedNote: unknown
): string => bytesToHex(roundDigest(participants, scripts, lockedNote))

// ---- optional Tapscript leaves: locking to a tweaked Q instead of P ----
//
// Attaching leaves turns this group's aggregate key into a BIP341 INTERNAL
// key P, and the note gets locked to the tweaked OUTPUT key
// Q = P + t·G instead - still a cp1, now also spendable by its leaves. The whole round
// then has to sign for Q, not P - the tweak enters key aggregation itself
// (musig2.ts's own tweakArgs), so it can't be bolted on afterwards, which
// is why every helper below takes the leaves and re-derives it rather than
// letting the two drift apart.
//
// No leaves = undefined tweak = a plain cp1 lock and a plain, untweaked
// round, byte-for-byte as before.

const roundTweakHex = (
  participants: unknown,
  scripts: unknown
): string | undefined => {
  const leaves = leafScriptsFor(scripts)
  if (leaves.length === 0) return undefined
  const internalKeyHex = musigPreview(participants)
  if (internalKeyHex === '-') return undefined
  try {
    return tweakPubkey(internalKeyHex, leaves).tweakScalarHex
  } catch {
    return undefined
  }
}

// whether a lock right now names a tweaked Q (leaves attached) or the bare
// aggregate P - both are cp1 notes, redeemable by the group's ck1; only a
// tweaked one is also spendable by revealing a leaf
const lockKind = (participants: unknown, scripts: unknown): string =>
  roundTweakHex(participants, scripts) === undefined
    ? 'cp1 (key only)'
    : 'cp1 (key + leaves)'

// the key a lock actually names: the tweaked output key Q once leaves are
// attached, the bare aggregate P otherwise
const lockTargetHex = (participants: unknown, scripts: unknown): string => {
  const tweakHex = roundTweakHex(participants, scripts)
  if (tweakHex === undefined) return musigPreview(participants)
  try {
    return aggregatePubkeys(
      asParticipants(participants).map(p => p.pubkeyHex),
      tweakHex
    )
  } catch {
    return '-'
  }
}

const templateName = (templateId: unknown): string =>
  scriptTemplateById(String(templateId ?? '').trim())?.name ??
  'Unknown template'

const leafOpcodes = (item: unknown): string => rowCompiled(item)?.opcodes ?? '-'

const canAddScriptLeaf = (scripts: unknown): boolean =>
  (Array.isArray(scripts) ? scripts.length : 0) < MAX_SCRIPT_LEAVES

// the Aggregate & sign button's own helper - deliberately throws straight
// through on bad input, same reasoning as a deliberate button click always
// gets (Renderer.tsx's own runAction turns a thrown Error into a plain
// toast notification, unlike a live binding). Only ever reachable for an
// all-local group (see allLocal above) - a pubkey-only participant goes
// through the staged flow below instead.
const runMusigRound = (
  participants: unknown,
  scripts: unknown,
  lockedNote: unknown
): Musig2Result =>
  aggregateAndSignBytes(
    asParticipants(participants),
    roundDigest(participants, scripts, lockedNote),
    roundTweakHex(participants, scripts)
  )

// ---- staged flow: at least one participant is pubkey-only ----
//
// Each of these mirrors one step of musig2.ts's own staged functions, just
// working over this addon's own Musig2Participant[] shape (and the fixed
// ck1 message) instead of raw hex lists - a manifest-side adapter, not new
// crypto. Every "generate/sign" helper below is idempotent: it only ever
// fills in a field that's still empty, so re-clicking a button (e.g. after
// adding a new local participant) never regenerates or reuses an existing
// participant's nonce/signature.

const allNoncesReady = (participants: unknown): boolean => {
  const list = asParticipants(participants)
  return list.length >= 2 && list.every(p => Boolean(p.pubNonceHex))
}

const allSigsReady = (participants: unknown): boolean =>
  allNoncesReady(participants) &&
  asParticipants(participants).every(p => Boolean(p.partialSigHex))

// "Generate my nonces" - fills in a fresh nonce pair for every LOCAL
// participant that doesn't already have one. An external (pubkey-only)
// participant's own pubNonceHex can only ever come from a paste (see
// participantRow's own Input below) - this page has no secret key to
// generate one on their behalf.
const generateLocalNonces = (
  participants: unknown,
  scripts: unknown,
  lockedNote: unknown
): Musig2Participant[] => {
  const list = asParticipants(participants)
  // a nonce binds to the aggregate key the round is actually for - the
  // TWEAKED one when leaves are attached, or the round's own partial
  // signatures won't combine
  const groupPubkeyHex = aggregatePubkeys(
    list.map(p => p.pubkeyHex),
    roundTweakHex(participants, scripts)
  )
  return list.map(p => {
    if (!p.secretKeyHex || p.pubNonceHex) return p
    const nonce = generateNonce(
      p.pubkeyHex,
      p.secretKeyHex,
      groupPubkeyHex,
      roundDigestHex(participants, scripts, lockedNote)
    )
    return {...p, nonceSecretHex: nonce.secretHex, pubNonceHex: nonce.publicHex}
  })
}

// the aggregate nonce every participant's own partial signature is signed
// against - the one value a genuine external co-signer needs from this
// page (alongside the pubkey list and the message to sign) before they can
// compute their own partial signature elsewhere and paste it back in
const aggregateNoncePreview = (participants: unknown): string => {
  if (!allNoncesReady(participants)) return '-'
  try {
    return aggregateNonces(
      asParticipants(participants).map(p => p.pubNonceHex!)
    )
  } catch {
    return '-'
  }
}

// "Sign my parts" - fills in a partial signature for every LOCAL
// participant that has a nonce but no signature yet. An external
// participant's own partialSigHex can only come from a paste.
const signLocalParts = (
  participants: unknown,
  scripts: unknown,
  lockedNote: unknown
): Musig2Participant[] => {
  const list = asParticipants(participants)
  if (!allNoncesReady(list)) return list
  const pubkeysHex = list.map(p => p.pubkeyHex)
  const aggNonceHex = aggregateNonces(list.map(p => p.pubNonceHex!))
  const tweakHex = roundTweakHex(participants, scripts)
  return list.map(p => {
    if (!p.secretKeyHex || !p.nonceSecretHex || p.partialSigHex) return p
    const partialSigHex = partialSign(
      aggNonceHex,
      pubkeysHex,
      roundDigestHex(participants, scripts, lockedNote),
      p.nonceSecretHex,
      p.secretKeyHex,
      tweakHex
    )
    return {...p, partialSigHex}
  })
}

// live per-row check as a partial signature is pasted in - lets a bad
// paste (wrong participant, stale round, plain typo) surface immediately
// as "not verified" next to that row, rather than only failing once every
// participant's is in and "Combine signatures" is clicked
const partialSigValid = (
  participants: unknown,
  index: unknown,
  scripts: unknown,
  lockedNote: unknown
): boolean => {
  const list = asParticipants(participants)
  const item = list[Number(index)]
  if (!item?.partialSigHex || !allNoncesReady(list)) return false
  try {
    const pubkeysHex = list.map(p => p.pubkeyHex)
    const pubNoncesHex = list.map(p => p.pubNonceHex!)
    return verifyPartialSig(
      aggregateNonces(pubNoncesHex),
      pubkeysHex,
      roundDigestHex(participants, scripts, lockedNote),
      pubNoncesHex,
      item.partialSigHex,
      Number(index),
      roundTweakHex(participants, scripts)
    )
  } catch {
    return false
  }
}

// "Combine signatures" - the staged flow's own last step, once every
// participant (local or external) has a partial signature. Deliberately
// throws straight through on an incomplete round, same reasoning as
// runMusigRound above.
const combineStagedSignatures = (
  participants: unknown,
  scripts: unknown,
  lockedNote: unknown
): Musig2Result => {
  const list = asParticipants(participants)
  const pubkeysHex = list.map(p => p.pubkeyHex)
  const pubNoncesHex = list.map(p => {
    if (!p.pubNonceHex)
      throw new Error('Every participant needs a public nonce first.')
    return p.pubNonceHex
  })
  const partialSigsHex = list.map(p => {
    if (!p.partialSigHex) {
      throw new Error('Every participant needs a partial signature first.')
    }
    return p.partialSigHex
  })
  return combineStagedRound(
    pubkeysHex,
    pubNoncesHex,
    partialSigsHex,
    roundDigestHex(participants, scripts, lockedNote),
    roundTweakHex(participants, scripts)
  )
}

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

const ck1Accepted = (result: unknown, lockedNote: unknown): boolean => {
  const ck1 = ck1FromMusigResult(result)
  return (
    ck1 !== null &&
    recoverNoteOwnershipPubkey(ck1, signingDomain(lockedNote)) !== null
  )
}

// ---- redeeming a note this page locked to the group pubkey ----
//
// The one place this addon's two "real wallet" pieces meet: a note.
// lockToPubkey result (a mint-certified lock onto SOME pubkey) and a
// completed signing round (a ck1 for SOME pubkey) only combine into a
// spendable note when they're for the very same group - checked here, not
// assumed, since editing participants after locking a note is entirely
// possible and would otherwise silently build a note for the wrong key.
// Pure string/hex math (withNewK1), no network - this is what "the mint
// certified pubkey X at amount Y" plus "here is a valid ck1 for X" adds up
// to: a complete, ready-to-redeem withdraw URL, embedding both the ck1
// bearer secret AND the mint's own certificate (so it shows up already
// offline-verified wherever it lands - see BearerCard.tsx's own
// offlineVerified check, which reads a note's sig the same way).
const lockedNoteUrl = (
  lockedNote: unknown,
  musigResult: unknown
): string | null => {
  const locked = lockedNote as {
    urlTemplate: string
    amountMsat: number
    signature: string
    groupPubkeyHex: string
  } | null
  const result = musigResult as Musig2Result | null
  if (!locked || !result || result.groupPubkeyHex !== locked.groupPubkeyHex) {
    return null
  }
  const ck1 = ck1FromMusigResult(result)
  // a round signed before this note was locked is bound to the placeholder
  // domain, not this note's mint - it would open nothing, so it builds no
  // note: sign again now that the note is locked
  if (!ck1 || recoverNoteOwnershipPubkey(ck1, signingDomain(locked)) === null) {
    return null
  }
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

const participantRow: UiNode = {
  type: 'View',
  style: 'row',
  children: [
    {type: 'Text', value: {var: 'item.pubkeyHex'}},
    {
      type: 'Show',
      when: {helper: 'not', args: [{var: 'item.secretKeyHex'}]},
      children: [
        {type: 'Text', value: '(external - pasted in, no local secret key)'}
      ]
    },
    {
      type: 'Button',
      label: 'Remove',
      onClick: {action: 'removeAt', path: 'participants', index: {var: 'index'}}
    },
    // ---- nonce stage: local participants fill this in automatically
    // (see generateLocalNonces below), an external one needs it pasted in
    // before the round can continue past "Generate my nonces" ----
    {
      type: 'Show',
      when: {var: 'item.pubNonceHex'},
      children: [
        {
          type: 'Text',
          value: {cat: ['Public nonce: ', {var: 'item.pubNonceHex'}]},
          style: 'response-block'
        },
        {
          type: 'Button',
          label: 'Copy',
          onClick: {
            verb: 'clipboard.copy',
            args: {text: {var: 'item.pubNonceHex'}}
          }
        }
      ]
    },
    {
      type: 'Show',
      when: {
        and: [
          {helper: 'not', args: [{var: 'item.secretKeyHex'}]},
          {helper: 'not', args: [{var: 'item.pubNonceHex'}]}
        ]
      },
      children: [
        {
          type: 'Input',
          bind: 'item.pubNonceHex',
          label: "Paste this participant's own public nonce (hex)"
        }
      ]
    },
    // ---- partial-signature stage: same local/external split, gated on
    // the nonce stage above already being done for this participant ----
    {
      type: 'Show',
      when: {var: 'item.partialSigHex'},
      children: [
        {
          type: 'Text',
          value: {cat: ['Partial signature: ', {var: 'item.partialSigHex'}]},
          style: 'response-block'
        },
        {
          type: 'Button',
          label: 'Copy',
          onClick: {
            verb: 'clipboard.copy',
            args: {text: {var: 'item.partialSigHex'}}
          }
        },
        {
          type: 'Show',
          when: {
            helper: 'partialSigValid',
            args: [
              {var: 'participants'},
              {var: 'index'},
              {var: 'lockScripts'},
              {var: 'lockedNote'}
            ]
          },
          children: [{type: 'Text', value: '✓ verified'}]
        },
        {
          type: 'Show',
          when: {
            helper: 'not',
            args: [
              {
                helper: 'partialSigValid',
                args: [
                  {var: 'participants'},
                  {var: 'index'},
                  {var: 'lockScripts'},
                  {var: 'lockedNote'}
                ]
              }
            ]
          },
          children: [{type: 'Text', value: '✗ not verified'}]
        }
      ]
    },
    {
      type: 'Show',
      when: {
        and: [
          {helper: 'not', args: [{var: 'item.secretKeyHex'}]},
          {var: 'item.pubNonceHex'},
          {helper: 'not', args: [{var: 'item.partialSigHex'}]}
        ]
      },
      children: [
        {
          type: 'Input',
          bind: 'item.partialSigHex',
          label: "Paste this participant's own partial signature (hex)"
        }
      ]
    }
  ]
}

// one Tapscript leaf in the lock's own script tree. Deliberately a leaner
// editor than the Taproot addon's own scriptRow (no per-row script-hex /
// TapLeaf-hash readouts): here the leaf is a means to an end - the tweaked
// output key shown below the list - rather than the object of study.
const lockScriptRow: UiNode = {
  type: 'View',
  style: 'row',
  children: [
    {
      type: 'Text',
      value: {helper: 'templateName', args: [{var: 'item.templateId'}]},
      style: 'subheading'
    },
    {
      type: 'Input',
      bind: 'item.pubkeyHex',
      label: 'Pubkey (x-only hex - multisig2’s FIRST key)'
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
        cat: ['Opcodes: ', {helper: 'leafOpcodes', args: [{var: 'item'}]}]
      },
      style: 'response-block'
    },
    {
      type: 'Button',
      label: 'Remove leaf',
      onClick: {action: 'removeAt', path: 'lockScripts', index: {var: 'index'}}
    }
  ]
}

const addLeafButton = (id: ScriptTemplateId): UiNode => ({
  type: 'Button',
  label: `Add "${scriptTemplateById(id)!.name}"`,
  onClick: {
    action: 'push',
    path: 'lockScripts',
    value: {helper: 'newScriptRow', args: [id]}
  }
})

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

const musigDocsUi: UiNode[] = [
  {
    type: 'Text',
    value:
      'Aggregate 2-3 keypairs into one pubkey, then produce ONE joint Schnorr signature - a verifier only ever sees a single ordinary-looking key and a single ordinary-looking signature, never that multiple people were involved. This is a real, spec-checked implementation (see this addon’s own tests). A cp1 note’s own ownership proof (ck1) is the same algorithm - a BIP-340 Schnorr signature over a fixed message, checked directly against the note’s own pubkey (src/lib/signature.ts) - so an aggregate key produced here is cryptographically capable of owning a spendable note; every round here signs exactly that fixed message, "LNURLcash", to prove that directly against this wallet’s own verification code, not just assert it in prose. Everything above is still a page-local sandbox (no note, mint, or wallet access) - "Lock a real note to this pubkey" below is the one deliberate exception: it burns a note you pick and re-mints it owned by whatever group pubkey this page has aggregated, then lets you redeem it back once this same page has also produced that group’s ck1.'
  },
  {
    type: 'Text',
    value:
      'Every participant can either be generated locally (this page holds its secret key and signs on its behalf automatically) or added as just a pubkey, pasted in by hand - this page never holds that key, so a nonce and, later, a partial signature for it must be pasted in too, computed elsewhere by whoever actually holds it. Mixing the two turns "Aggregate & sign" into a step-by-step round instead of one click - see below.'
  },
  {type: 'Text', value: 'How to use this', style: 'subheading'},
  {
    type: 'List',
    ordered: true,
    each: [
      "Click 'Add participant' 2 or 3 times for an all-local demo - each click generates one fresh, ephemeral keypair. To include someone else's real key instead, resolve their Lightning Address (preferred - or a cp1/cx1 address, or a username) with 'Resolve', or paste their pubkey directly.",
      'Once there are 2 or more participants, the aggregated group pubkey (and its cp1 address form) appear automatically below the list.',
      "All local: click 'Aggregate & sign' - this runs the entire round in one step (nonce generation, nonce aggregation, every participant's partial signature, and final aggregation) over exactly what a ck1 signs: the LUD-25 key-path sighash for the group key, bound to the locked note's mint (a placeholder mint until a note is locked - sign again after locking).",
      "With an external pubkey: click 'Generate my nonces', then paste that participant's own public nonce into its row; once every row has one, copy the shown aggregate nonce (plus the pubkey list and message to sign above) to them, click 'Sign my parts', then paste their own partial signature into its row; once every row has one, click 'Combine signatures'.",
      "Check the result: the final signature's own ✓ verified line, and each signer's individual partial-signature ✓ underneath (also shown live next to a pasted partial signature, before the round is even combined).",
      "Optional - to actually lock a note to this pubkey: once 2+ participants exist, pick one of your own unspent notes under 'Lock a real note to this pubkey' and click 'Lock this note' - this burns it and re-mints it owned by the group pubkey, certified by the mint's own signature (checked here, not just assumed). Once this same round has ALSO produced a matching ck1 above, a 'Redeemable note' section appears with the complete note (both signatures included) - copy it, or click 'Withdraw to wallet' to claim it back here directly.",
      'Optional - add Tapscript leaves (a timelock, a hashlock, a 2-of-2) before locking, and the lock names a tweaked taproot output key instead of the bare group key: the group key becomes the INTERNAL key, the note is locked to the tweaked output key, and every signing step above automatically signs for that tweaked key instead. The leaves themselves stay private until one is used.'
    ],
    children: [{type: 'Text', value: {var: 'item'}}]
  }
]

const musigBuilderUi: UiNode[] = [
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
      },
      {
        type: 'Text',
        value:
          'Or add someone else by their Lightning Address (preferred), a cp1/cx1 address, or a username - resolves their pubkey via a LUD-25 registered branch, no copying 66 hex characters back and forth. A bare username has no mint of its own, so pick one of your own notes first to name one (a full Lightning Address or a cp1/cx1 address ignores it, both are already self-contained):'
      },
      {
        type: 'NotePicker',
        bind: 'mintNoteForLookup',
        filter: {spent: false},
        label: 'Note on that mint (bare username only)'
      },
      {
        type: 'Input',
        bind: 'externalAddressInput',
        label: 'Lightning Address, cp1/cx1 address, or username'
      },
      {
        type: 'Show',
        when: {var: 'externalAddressInput'},
        children: [
          {
            type: 'Button',
            label: 'Resolve',
            onClick: {
              verb: 'note.resolveAddressPubkey',
              args: {
                mintNote: {var: 'mintNoteForLookup.id'},
                address: {var: 'externalAddressInput'}
              },
              result: 'externalPubkeyInput'
            }
          }
        ]
      },
      {
        type: 'Input',
        bind: 'externalPubkeyInput',
        label:
          'Or paste their pubkey directly (66 hex chars, no local secret key)'
      },
      {
        type: 'Show',
        when: {
          helper: 'canAddExternalPubkey',
          args: [{var: 'participants'}, {var: 'externalPubkeyInput'}]
        },
        children: [
          {
            type: 'Button',
            label: 'Add external pubkey',
            onClick: {
              action: 'push',
              path: 'participants',
              value: {
                helper: 'addExternalParticipant',
                args: [{var: 'externalPubkeyInput'}]
              }
            }
          }
        ]
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
      {
        type: 'Button',
        label: 'Copy',
        onClick: {
          verb: 'clipboard.copy',
          args: {text: {helper: 'musigPreview', args: [{var: 'participants'}]}}
        }
      },
      {
        type: 'Text',
        value: {
          cat: [
            'Group pubkey (cp1): ',
            {helper: 'musigCp1Preview', args: [{var: 'participants'}]}
          ]
        },
        style: 'response-block'
      },
      {
        type: 'Button',
        label: 'Copy',
        onClick: {
          verb: 'clipboard.copy',
          args: {
            text: {helper: 'musigCp1Preview', args: [{var: 'participants'}]}
          }
        }
      },
      {
        type: 'Text',
        value: 'Lock a real note to this pubkey',
        style: 'subheading'
      },
      {
        type: 'Show',
        when: {helper: 'not', args: [{var: 'lockedNote'}]},
        children: [
          {
            type: 'Text',
            value:
              'Optional - burns one of your own wallet notes and re-mints it owned by the group pubkey above. Only a valid ck1 for this exact group (produced below) will ever redeem it again; this wallet gives up any other way to spend it the moment this succeeds.'
          },
          // ---- optional Tapscript leaves (locks to the tweaked output key) ----
          {
            type: 'Text',
            value: 'Alternate unlock conditions (optional)',
            style: 'subheading'
          },
          {
            type: 'Text',
            value:
              'Add one or more Tapscript leaves and the group pubkey above becomes a BIP341 INTERNAL key: the note gets locked to the tweaked output key instead of the bare group key. The group can still redeem it by signing - the round below automatically signs for the tweaked key once a leaf compiles - but the leaves are ALSO valid ways to redeem it, which is what makes a timelock possible.'
          },
          {type: 'For', each: {var: 'lockScripts'}, children: [lockScriptRow]},
          {
            type: 'Show',
            when: {helper: 'canAddScriptLeaf', args: [{var: 'lockScripts'}]},
            children: [
              {
                type: 'View',
                style: 'row',
                children: SCRIPT_TEMPLATES.map(t => addLeafButton(t.id))
              }
            ]
          },
          {
            type: 'Text',
            value: {
              cat: [
                'This lock will use: ',
                {
                  helper: 'lockKind',
                  args: [{var: 'participants'}, {var: 'lockScripts'}]
                },
                ' — key ',
                {
                  helper: 'lockTargetHex',
                  args: [{var: 'participants'}, {var: 'lockScripts'}]
                }
              ]
            },
            style: 'response-block'
          },
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
                label: 'Lock this note to the group pubkey',
                onClick: {
                  verb: 'note.lockToPubkey',
                  args: {
                    note: {var: 'selectedNote.id'},
                    pubkeyHex: {
                      helper: 'lockTargetHex',
                      args: [{var: 'participants'}, {var: 'lockScripts'}]
                    },
                    kind: {
                      helper: 'lockKind',
                      args: [{var: 'participants'}, {var: 'lockScripts'}]
                    }
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
          {
            type: 'Text',
            value: {
              cat: [
                'Locked ',
                {helper: 'msatToSats', args: [{var: 'lockedNote.amountMsat'}]},
                ' sats to this pubkey (',
                {var: 'lockedNote.kind'},
                ').'
              ]
            }
          },
          {
            type: 'Text',
            value: {
              cat: ["Mint's certificate: ", {var: 'lockedNote.signature'}]
            },
            style: 'response-block'
          },
          {
            type: 'Button',
            label: 'Copy',
            onClick: {
              verb: 'clipboard.copy',
              args: {text: {var: 'lockedNote.signature'}}
            }
          },
          {
            type: 'Show',
            when: {var: 'lockedNote.pubkeyVerified'},
            children: [
              {
                type: 'Text',
                value:
                  "✓ verified against the mint's own pinned key - this pubkey really is locked"
              }
            ]
          },
          {
            type: 'Show',
            when: {helper: 'not', args: [{var: 'lockedNote.pubkeyVerified'}]},
            children: [
              {
                type: 'Text',
                value:
                  "✗ could not verify the mint's certificate - do not rely on this note being safely locked"
              }
            ]
          },
          {
            type: 'Button',
            label: 'Lock a different note',
            onClick: {action: 'set', path: 'lockedNote', value: null}
          }
        ]
      },
      {
        type: 'Text',
        value: {
          cat: [
            'Message to sign together (the key-path sighash a ck1 signs, for this group key and ',
            {
              helper: 'lockedMintLabel',
              args: [{var: 'lockedNote'}]
            },
            '): ',
            {
              helper: 'roundDigestPreview',
              args: [
                {var: 'participants'},
                {var: 'lockScripts'},
                {var: 'lockedNote'}
              ]
            }
          ]
        },
        style: 'response-block'
      },
      {
        type: 'Show',
        when: {helper: 'allLocal', args: [{var: 'participants'}]},
        children: [
          {
            type: 'Button',
            label: 'Aggregate & sign',
            onClick: {
              action: 'set',
              path: 'musigResult',
              value: {
                helper: 'runMusigRound',
                args: [
                  {var: 'participants'},
                  {var: 'lockScripts'},
                  {var: 'lockedNote'}
                ]
              }
            }
          }
        ]
      },
      {
        type: 'Show',
        when: {
          helper: 'not',
          args: [{helper: 'allLocal', args: [{var: 'participants'}]}]
        },
        children: [
          {
            type: 'Text',
            value:
              'One or more participants are pubkey-only - drive the round step by step:',
            style: 'subheading'
          },
          {
            type: 'Show',
            when: {
              helper: 'not',
              args: [{helper: 'allNoncesReady', args: [{var: 'participants'}]}]
            },
            children: [
              {
                type: 'Button',
                label: 'Generate my nonces',
                onClick: {
                  action: 'set',
                  path: 'participants',
                  value: {
                    helper: 'generateLocalNonces',
                    args: [
                      {var: 'participants'},
                      {var: 'lockScripts'},
                      {var: 'lockedNote'}
                    ]
                  }
                }
              },
              {
                type: 'Text',
                value:
                  'Fills in a public nonce for every local participant above. Any external (pubkey-only) participant still needs its own public nonce pasted into its row before the round can continue.'
              }
            ]
          },
          {
            type: 'Show',
            when: {helper: 'allNoncesReady', args: [{var: 'participants'}]},
            children: [
              {
                type: 'Text',
                value: {
                  cat: [
                    'Aggregate nonce: ',
                    {
                      helper: 'aggregateNoncePreview',
                      args: [{var: 'participants'}]
                    }
                  ]
                },
                style: 'response-block'
              },
              {
                type: 'Button',
                label: 'Copy',
                onClick: {
                  verb: 'clipboard.copy',
                  args: {
                    text: {
                      helper: 'aggregateNoncePreview',
                      args: [{var: 'participants'}]
                    }
                  }
                }
              },
              {
                type: 'Show',
                when: {
                  helper: 'not',
                  args: [
                    {helper: 'allSigsReady', args: [{var: 'participants'}]}
                  ]
                },
                children: [
                  {
                    type: 'Button',
                    label: 'Sign my parts',
                    onClick: {
                      action: 'set',
                      path: 'participants',
                      value: {
                        helper: 'signLocalParts',
                        args: [
                          {var: 'participants'},
                          {var: 'lockScripts'},
                          {var: 'lockedNote'}
                        ]
                      }
                    }
                  },
                  {
                    type: 'Text',
                    value:
                      'Fills in a partial signature for every local participant above. Any external participant still needs its own partial signature (computed against the aggregate nonce, pubkey list, and message to sign above) pasted into its row before the round can be combined.'
                  }
                ]
              },
              {
                type: 'Show',
                when: {helper: 'allSigsReady', args: [{var: 'participants'}]},
                children: [
                  {
                    type: 'Button',
                    label: 'Combine signatures',
                    onClick: {
                      action: 'set',
                      path: 'musigResult',
                      value: {
                        helper: 'combineStagedSignatures',
                        args: [
                          {var: 'participants'},
                          {var: 'lockScripts'},
                          {var: 'lockedNote'}
                        ]
                      }
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
    when: {var: 'musigResult'},
    children: [
      {
        type: 'Text',
        value: {cat: ['Final signature: ', {var: 'musigResult.finalSigHex'}]},
        style: 'response-block'
      },
      {
        type: 'Button',
        label: 'Copy',
        onClick: {
          verb: 'clipboard.copy',
          args: {text: {var: 'musigResult.finalSigHex'}}
        }
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
        type: 'Text',
        value:
          'The group pubkey and final signature above are already the exact shape a real ck1 needs (32-byte x-only pubkey, 64-byte BIP-340 signature) - encoded below and run through this wallet’s own recoverNoteOwnershipPubkey, unchanged.'
      },
      {
        type: 'Text',
        value: {
          cat: ['ck1: ', {helper: 'ck1Display', args: [{var: 'musigResult'}]}]
        },
        style: 'response-block'
      },
      {
        type: 'Button',
        label: 'Copy',
        onClick: {
          verb: 'clipboard.copy',
          args: {text: {helper: 'ck1Display', args: [{var: 'musigResult'}]}}
        }
      },
      {
        type: 'Show',
        when: {
          helper: 'ck1Accepted',
          args: [{var: 'musigResult'}, {var: 'lockedNote'}]
        },
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
          args: [
            {
              helper: 'ck1Accepted',
              args: [{var: 'musigResult'}, {var: 'lockedNote'}]
            }
          ]
        },
        children: [{type: 'Text', value: '✗ not accepted'}]
      },
      {
        type: 'Show',
        when: {
          helper: 'lockedNoteUrl',
          args: [{var: 'lockedNote'}, {var: 'musigResult'}]
        },
        children: [
          {
            type: 'Text',
            value: 'Redeemable note (locked note + this ck1)',
            style: 'subheading'
          },
          {
            type: 'Text',
            value: {
              helper: 'lockedNoteUrl',
              args: [{var: 'lockedNote'}, {var: 'musigResult'}]
            },
            style: 'response-block'
          },
          {
            type: 'Button',
            label: 'Copy',
            onClick: {
              verb: 'clipboard.copy',
              args: {
                text: {
                  helper: 'lockedNoteUrl',
                  args: [{var: 'lockedNote'}, {var: 'musigResult'}]
                }
              }
            }
          },
          {
            type: 'Show',
            when: {var: 'lockedNote.pubkeyVerified'},
            children: [
              {
                type: 'Button',
                label: 'Withdraw to wallet',
                onClick: {
                  verb: 'note.claim',
                  args: {
                    url: {
                      helper: 'lockedNoteUrl',
                      args: [{var: 'lockedNote'}, {var: 'musigResult'}]
                    },
                    callback: {var: 'lockedNote.callback'},
                    amountMsat: {var: 'lockedNote.amountMsat'},
                    mintPubkey: {var: 'lockedNote.mintPubkey'}
                  },
                  result: 'claimedNote'
                }
              }
            ]
          },
          {
            type: 'Show',
            when: {
              helper: 'not',
              args: [{var: 'lockedNote.pubkeyVerified'}]
            },
            children: [
              {
                type: 'Text',
                value:
                  "Withdraw disabled - the mint's own certificate for this lock could not be verified above."
              }
            ]
          },
          {
            type: 'Show',
            when: {var: 'claimedNote'},
            children: [
              {
                type: 'Show',
                when: {var: 'claimedNote.verified'},
                children: [
                  {
                    type: 'Text',
                    value: '✓ added to your wallet and confirmed by the mint'
                  }
                ]
              },
              {
                type: 'Show',
                when: {helper: 'not', args: [{var: 'claimedNote.verified'}]},
                children: [
                  {
                    type: 'Text',
                    value:
                      'Added to your wallet, unverified for now - refresh it on the Wallet page.'
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  }
]

// builder (interactive) on the left, reference docs on the right - see
// style.scss's own .addon-columns for the grid/collapse behaviour
const musigUi: UiNode[] = [
  {type: 'Text', value: 'MuSig2 (BIP327)', style: 'heading'},
  {
    type: 'View',
    style: 'columns',
    children: [
      {type: 'View', style: 'col-left', children: musigBuilderUi},
      {type: 'View', style: 'col-right', children: musigDocsUi}
    ]
  }
]

const musig2Manifest: AddonManifest = {
  id: 'musig2',
  name: 'MuSig2 Playground',
  version: '1',
  icon: 'people',
  experimental: true,
  description:
    'Play around with BIP327 MuSig2 joint Schnorr signatures, and optionally lock one of your own notes to the resulting group pubkey. See the separate Taproot addon for BIP341 pubkey tweaking.',
  permissions: [
    {
      verb: 'note.lockToPubkey',
      scope: 'spent:false',
      reason:
        "Let you pick one of your own unspent notes and lock it to this page's MuSig2 group pubkey"
    },
    {
      verb: 'note.claim',
      reason:
        "Add the resulting note back into your wallet once this group's ck1 proof is ready"
    },
    {
      verb: 'note.resolveAddressPubkey',
      scope: 'spent:false',
      reason:
        "Look up an external participant's pubkey from their Lightning Address, a cp1/cx1 address, or a username registered at the same mint as one of your own notes"
    }
  ],
  nav: {position: 'right', icon: 'people', label: 'MuSig2'},
  state: {
    participants: [],
    lockScripts: [],
    externalPubkeyInput: '',
    mintNoteForLookup: null,
    externalAddressInput: '',
    musigResult: null,
    selectedNote: null,
    lockedNote: null,
    claimedNote: null
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
  canAddExternalPubkey: canAddExternalPubkey as AddonHelper,
  addExternalParticipant: addExternalParticipant as AddonHelper,
  allLocal: allLocal as AddonHelper,
  canAggregate: canAggregate as AddonHelper,
  musigPreview: musigPreview as AddonHelper,
  musigCp1Preview: musigCp1Preview as AddonHelper,
  newScriptRow: newScriptRow as AddonHelper,
  templateName: templateName as AddonHelper,
  leafOpcodes: leafOpcodes as AddonHelper,
  canAddScriptLeaf: canAddScriptLeaf as AddonHelper,
  lockKind: lockKind as AddonHelper,
  lockTargetHex: lockTargetHex as AddonHelper,
  runMusigRound: runMusigRound as AddonHelper,
  allNoncesReady: allNoncesReady as AddonHelper,
  allSigsReady: allSigsReady as AddonHelper,
  generateLocalNonces: generateLocalNonces as AddonHelper,
  aggregateNoncePreview: aggregateNoncePreview as AddonHelper,
  signLocalParts: signLocalParts as AddonHelper,
  partialSigValid: partialSigValid as AddonHelper,
  combineStagedSignatures: combineStagedSignatures as AddonHelper,
  ck1Display: ck1Display as AddonHelper,
  ck1Accepted: ck1Accepted as AddonHelper,
  roundDigestPreview: roundDigestPreview as AddonHelper,
  lockedMintLabel: lockedMintLabel as AddonHelper,
  lockedNoteUrl: lockedNoteUrl as AddonHelper
}

export const musig2Addon: Addon = {
  manifest: musig2Manifest,
  helpers: musig2Helpers
}
