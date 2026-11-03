import type {Addon, AddonHelper, AddonManifest, UiNode} from '../types'
import {schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {
  decodeCr1WithAmount,
  encodeCr1WithAmount
} from '../../lib/recoverableNotes'
import {serverOf} from '../../lib/urls'
import {
  consignmentProblem,
  decodeSealConsignment,
  encodeSealConsignment,
  genesisState,
  planSealLock,
  sealCertificateProblem,
  sealStateHash,
  type SealCertificate,
  type SealState
} from './seals'
import {
  embedSealEnvelope,
  encodeSealEnvelope,
  PICTURE_EXTENSION,
  pictureFormatOf,
  pictureFromDataUrl,
  pictureHash,
  sealEnvelopeOf,
  sealPictureHashProblem,
  type SealEnvelope
} from './picture'
import {generateKeypair} from '../taproot/taproot'

// Seals: prove and transfer ownership of an off-chain, non-fungible
// "asset" using an LNURLcash note as its bearer anchor - RGB/Taproot
// Assets' own core idea (state lives off-chain, a taproot commitment
// binds it to something spendable, every holder validates the WHOLE
// history themselves rather than trusting whoever handed it to them)
// adapted to bearer notes instead of real on-chain UTXOs. See seals.ts's
// own top comment for the full design and its honest limitations -
// particularly: a transfer goes to a NAMED recipient (race-to-claim only
// where a holder deliberately makes a bearer picture, see below), and an
// unredeemed transition is a promise, not a guarantee, until it actually
// lands at the mint.
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
// A seal can be ABOUT a picture, and travel inside it (see picture.ts):
// issued with a JPG/PNG picked, its asset id is that file's sha256, and
// "Download picture" writes the consignment into the file itself. MANAGE
// reads it back out of a loaded picture and says whether the file really is
// the one the seal was issued for. A BEARER picture also carries the
// current owner's one-time key, so whoever holds the file holds the seal.
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

type GenesisPlan = {
  state: SealState
  outputKeyHex: string
  // a picture seal's asset id - its picture's own sha256 - else ''
  pictureHashHex: string
}

// ---- Pictures ----
//
// `picture` is always what an ImagePicker bound (../imageData.ts's
// PickedImage) - the file as a data URL - or null.

// What a picked picture comes down to: its bytes, the hash of the picture
// in it, and the envelope it carries. A picture sits in state as a data URL
// of megabytes, and every helper below is evaluated again on each keystroke
// in any field its expression shares - decoding and hashing the file each
// time costs a noticeable fraction of a second per key. So it is worked out
// once per picture and kept for the last few, keyed by the data URL itself.
type PictureInfo = {
  bytes: Uint8Array
  hashHex: string
  envelope: SealEnvelope | null
}

const PICTURE_CACHE_SIZE = 4
const pictureCache = new Map<string, PictureInfo | null>()

const pictureInfo = (picture: unknown): PictureInfo | null => {
  const dataUrl =
    typeof picture === 'string'
      ? picture
      : (picture as {dataUrl?: unknown} | null)?.dataUrl
  if (typeof dataUrl !== 'string') return null
  const known = pictureCache.get(dataUrl)
  if (known !== undefined) return known
  const bytes = pictureFromDataUrl(dataUrl)
  const hashHex = bytes ? pictureHash(bytes) : null
  const info =
    bytes && hashHex ? {bytes, hashHex, envelope: sealEnvelopeOf(bytes)} : null
  if (pictureCache.size >= PICTURE_CACHE_SIZE) {
    pictureCache.delete(pictureCache.keys().next().value!)
  }
  pictureCache.set(dataUrl, info)
  return info
}

const pictureHashOf = (picture: unknown): string =>
  pictureInfo(picture)?.hashHex ?? ''

// with a picture picked, this is a picture seal: its asset id is the
// picture's own hash rather than random bytes
const prepareGenesis = (
  name: unknown,
  description: unknown,
  ownerPubkeyHex: unknown,
  picture?: unknown
): GenesisPlan => {
  const pictureHashHex = picture ? pictureHashOf(picture) : ''
  if (picture && !pictureHashHex) {
    throw new Error(
      'That file cannot be read as a JPG or PNG picture - pick another, or issue without one.'
    )
  }
  const state = genesisState(
    name,
    description,
    xOnlyPubkeyHex(ownerPubkeyHex),
    pictureHashHex || undefined
  )
  return {
    state,
    outputKeyHex: planSealLock(state).outputKeyHex,
    pictureHashHex
  }
}

// the picture file with `consignment` written into it - and, for a bearer
// picture only, the current owner's one-time key. Null rather than a file
// that would not say what it should.
const sealedPicture = (
  picture: unknown,
  consignment: unknown,
  claimSecretKeyHex?: string
): Uint8Array | null => {
  const bytes = pictureInfo(picture)?.bytes
  const text = String(consignment ?? '').trim()
  if (!bytes || !text) return null
  try {
    return embedSealEnvelope(
      bytes,
      encodeSealEnvelope({consignment: text, claimSecretKeyHex})
    )
  } catch {
    return null
  }
}

// whether the picture picked right now is still the one this plan's asset
// id was taken from - a holder who picks another file after "Prepare" must
// not get a download that carries the seal in the wrong picture
const planMatchesPicture = (
  genesisPlan: unknown,
  picture: unknown
): boolean => {
  const plan = genesisPlan as GenesisPlan | null
  return (
    !!plan?.pictureHashHex && pictureHashOf(picture) === plan.pictureHashHex
  )
}

// "<asset name>.seal.jpg" - the seal's own name, cut down to what every
// file system takes
const pictureFileName = (picture: unknown, consignment: unknown): string => {
  const bytes = pictureInfo(picture)?.bytes
  const format = bytes ? pictureFormatOf(bytes) : null
  const name = decodeSealConsignment(consignment)?.states[0]?.name ?? ''
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const extension = format ? PICTURE_EXTENSION[format] : 'png'
  return (slug || 'seal') + '.seal.' + extension
}

const envelopeOfPicture = (picture: unknown): SealEnvelope | null =>
  pictureInfo(picture)?.envelope ?? null

const consignmentOfPicture = (picture: unknown): string =>
  envelopeOfPicture(picture)?.consignment ?? ''

const loadedPictureLine = (picture: unknown): string => {
  if (!pictureInfo(picture)) return ''
  const envelope = envelopeOfPicture(picture)
  if (!envelope) return 'This picture carries no seal.'
  return envelope.claimSecretKeyHex
    ? 'This picture carries a seal AND the key that moves it - a bearer picture. Whoever holds a copy of this file can take the seal: move it to a key of your own before anyone else does.'
    : 'This picture carries a seal’s consignment.'
}

// the key a bearer picture carries - but only while the consignment being
// managed is the very one it carries that key for
const claimKeyOfPicture = (
  picture: unknown,
  consignmentInput: unknown
): string => {
  const envelope = envelopeOfPicture(picture)
  return envelope?.claimSecretKeyHex &&
    envelope.consignment === String(consignmentInput ?? '').trim()
    ? envelope.claimSecretKeyHex
    : ''
}

const pictureMatches = (
  consignmentInput: unknown,
  picture: unknown
): boolean => {
  const info = pictureInfo(picture)
  const parsed = decodeSealConsignment(consignmentInput)
  return (
    !!info && !!parsed && !sealPictureHashProblem(parsed.states, info.hashHex)
  )
}

const pictureMatchLine = (
  consignmentInput: unknown,
  picture: unknown
): string => {
  const info = pictureInfo(picture)
  const parsed = decodeSealConsignment(consignmentInput)
  if (!info || !parsed) return ''
  const problem = sealPictureHashProblem(parsed.states, info.hashHex)
  return problem
    ? '✗ ' + problem
    : '✓ This file is the picture the seal was issued for - its sha256 is the seal’s asset id, ' +
        parsed.states[0]!.assetId +
        '. That says this seal is about this picture, not that it is the only seal about it: anyone who has the file can issue another.'
}

const issuedConsignment = (
  issuedNote: unknown,
  genesisPlan: unknown
): string | null => {
  const plan = genesisPlan as GenesisPlan | null
  if (!plan) return null
  return encodeSealConsignment(issuedNote, [plan.state])
}

const issuedPicture = (
  picture: unknown,
  issuedNote: unknown,
  genesisPlan: unknown
): Uint8Array | null =>
  planMatchesPicture(genesisPlan, picture)
    ? sealedPicture(picture, issuedConsignment(issuedNote, genesisPlan))
    : null

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
      {
        type: 'ImagePicker',
        bind: 'picture',
        label: 'Picture (optional) - a JPG or PNG this seal is about'
      },
      {
        type: 'Show',
        when: {var: 'picture'},
        children: [
          {type: 'Image', value: {var: 'picture.dataUrl'}},
          {
            type: 'Text',
            value:
              'The seal’s asset id will be this picture’s sha256 - of the file as it is, minus any seal it already carries - and the file itself can carry the seal’s consignment. Keep the file as it is: a resized, recompressed or screenshotted copy is a different picture.'
          }
        ]
      },
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
                  {var: 'firstOwnerPubkeyHex'},
                  {var: 'picture'}
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
            type: 'Show',
            when: {var: 'genesisPlan.pictureHashHex'},
            children: [
              {
                type: 'Text',
                value: {
                  cat: [
                    'Asset id (the picture’s own sha256): ',
                    {var: 'genesisPlan.pictureHashHex'}
                  ]
                },
                style: 'response-block'
              }
            ]
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
        type: 'Show',
        when: {
          helper: 'planMatchesPicture',
          args: [{var: 'genesisPlan'}, {var: 'picture'}]
        },
        children: [
          {
            type: 'Text',
            value:
              'Or hand over the picture itself: the download below is your file with this consignment written into it. It shows exactly as before, and whoever gets it can read the seal straight out of it.'
          },
          {
            type: 'Button',
            label: 'Download picture with consignment',
            onClick: {
              verb: 'file.download',
              args: {
                filename: {
                  helper: 'pictureFileName',
                  args: [
                    {var: 'picture'},
                    {
                      helper: 'issuedConsignment',
                      args: [{var: 'issuedNote'}, {var: 'genesisPlan'}]
                    }
                  ]
                },
                content: {
                  helper: 'issuedPicture',
                  args: [
                    {var: 'picture'},
                    {var: 'issuedNote'},
                    {var: 'genesisPlan'}
                  ]
                },
                mime: {var: 'picture.type'}
              }
            }
          }
        ]
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
  const result = transitionResult as TransitionResult | null
  if (!parsed || !result) return null
  // Every certificate the history already carried, plus the mint's own for
  // this transition when it issued one (see verbs.ts's seal.transition).
  // A consignment holds a certificate's signature and ONE amount for all of
  // them, so the carried ones are re-labelled with the amount the mint
  // itself just reported rather than the one the old header claimed: a
  // header that was wrong must not cost the holder the new consignment of
  // a transition that has already landed.
  const carried = parsed.certificates.flatMap(
    (certificate): SealCertificate[] => {
      const decoded = decodeCr1WithAmount(certificate.cr1)
      return decoded
        ? [
            {
              stateIndex: certificate.stateIndex,
              cr1: encodeCr1WithAmount(result.amountMsat, decoded.signature)
            }
          ]
        : []
    }
  )
  const certificates = result.certificate
    ? [
        ...carried,
        {stateIndex: result.state.stateIndex, cr1: result.certificate}
      ]
    : carried
  return encodeSealConsignment(
    {urlTemplate: result.urlTemplate, amountMsat: result.amountMsat},
    [...parsed.states, result.state],
    certificates
  )
}

type TransitionResult = {
  urlTemplate: string
  amountMsat: number
  state: SealState
  certificate: string | null
  // '' when certified; 'missing' when the mint sent no certificate (twice),
  // 'invalid' when it sent one that is not its own for this step
  certificateProblem: '' | 'missing' | 'invalid'
}

// Whether this transition result belongs to the consignment being managed
// right now: its state is the very next one after that history's last. A
// holder who goes on to paste another seal must not see the last one's
// "Transitioned" under it - and a transition that DID land for this one
// must show whatever else goes wrong afterwards.
const transitionFollows = (
  consignmentInput: unknown,
  transitionResult: unknown
): boolean => {
  const current = currentStateOf(consignmentInput)
  const next = (transitionResult as TransitionResult | null)?.state
  return (
    !!current &&
    !!next &&
    next.assetId === current.assetId &&
    next.stateIndex === current.stateIndex + 1 &&
    next.prevStateHash === sealStateHash(current)
  )
}

const transitionCertificateLine = (transitionResult: unknown): string => {
  const result = transitionResult as TransitionResult | null
  if (!result) return ''
  if (result.certificate) {
    return '✓ The mint certified this transition - the consignment below carries its certificate.'
  }
  return result.certificateProblem === 'invalid'
    ? 'The mint answered with a certificate that is not its own for this step - its signing key may differ from the one this wallet has pinned for it. The transition landed, but this step goes on uncertified.'
    : 'The mint did not certify this transition (not every mint issues rotation certificates). The history below still chains together, but nobody can check that this step was the only one.'
}

// the new state itself, for the one case nextConsignment cannot build a
// consignment around it: the transition has landed, so the state must not
// be lost with the page
const transitionStateText = (transitionResult: unknown): string =>
  JSON.stringify((transitionResult as TransitionResult | null)?.state ?? null)

// which mint a consignment says its seal lives at - the one thing in it
// nobody signed. Everything "Check at the mint" answers is that host's word.
const consignmentHost = (consignmentInput: unknown): string => {
  const urlTemplate = decodeSealConsignment(consignmentInput)?.urlTemplate
  return urlTemplate ? serverOf(urlTemplate) : ''
}

// what verbs.ts's seal.check answered, as lines to show - only ever for
// the consignment it was actually asked about: a holder who pastes a
// different one afterwards must not see the previous one's answer under it
type CheckResult = {
  consignment: string
  host: string
  live: boolean
  reason?: string
  amountMsat?: number
  mintPubkey: string | null
  mintPubkeyPinned: boolean
  // another mint this wallet has pinned the same key for, if any
  keyKnownAs: string | null
  transitions: number
  // null when there was no key to check the certificates against
  certified: boolean | null
  certificateProblem: string
}

const checkReport = (
  consignmentInput: unknown,
  checkResult: unknown,
  transitionResult: unknown
): string[] => {
  const result = checkResult as CheckResult | null
  if (!result || result.consignment !== String(consignmentInput ?? '').trim()) {
    return []
  }
  // a transition that has landed since spent the very note this answer was
  // about - "unspent" would be a lie by now. An answer that already says
  // the note is gone stays: it cannot have been made stale by that.
  if (result.live && transitionFollows(consignmentInput, transitionResult)) {
    return []
  }
  const {host, mintPubkeyPinned: pinned} = result
  const lines = [`Asked ${host}.`]
  if (!result.live) {
    lines.push(`✗ ${result.reason ?? 'Not live at the mint.'}`)
  } else if (pinned) {
    lines.push(
      `✓ Live at ${host} - its current note is unspent and worth ${result.amountMsat} msat.`
    )
  } else {
    lines.push(
      `${host} says its current note is unspent and worth ${result.amountMsat} msat.`
    )
  }
  if (!result.transitions) {
    lines.push(
      'Never transferred - there is no transition for the mint to certify yet.'
    )
  } else if (result.certified === null) {
    lines.push(
      `Its ${result.transitions} transition(s) could not be checked: this wallet has no key pinned for ${host}.`
    )
  } else if (!result.certified) {
    lines.push(`✗ Not fully certified - ${result.certificateProblem}`)
  } else if (pinned) {
    lines.push(
      `✓ Every one of its ${result.transitions} transition(s) is certified by the key this wallet has pinned for ${host}: each note is the only one its predecessor was burned into.`
    )
  } else {
    lines.push(
      `Every one of its ${result.transitions} transition(s) is certified by the key ${host} names as its own.`
    )
  }
  if (result.mintPubkey) lines.push(`Key: ${result.mintPubkey}`)
  if (result.keyKnownAs) {
    lines.push(
      `⚠ This wallet knows that key as ${result.keyKnownAs}'s. ${host} is another address: a server can name any key, and a history certified at one mint proves nothing at another.`
    )
  }
  if (!pinned) {
    lines.push(
      `⚠ This wallet has no key pinned for ${host}, so all of the above is ${host}'s word alone - anyone can run a server that answers this way. Only rely on it if ${host} is the mint this seal was issued at.`
    )
  }
  return lines
}

// the offline half: the certificates against a mint key the holder already
// trusts and types in - no network, and no word of any server
const offlineCertificateLine = (
  consignmentInput: unknown,
  mintKeyInput: unknown
): string => {
  const key = String(mintKeyInput ?? '').trim()
  const parsed = decodeSealConsignment(consignmentInput)
  if (!key || !parsed) return ''
  const problem = sealCertificateProblem(parsed, key)
  if (problem) return `✗ ${problem}`
  const transitions = parsed.states.length - 1
  return transitions
    ? `✓ Every one of its ${transitions} transition(s) is certified by this key. Whether its current note is still unspent only the mint can say.`
    : 'Never transferred - there is no transition to certify yet.'
}

// ---- a transition's own picture ----

type ClaimKey = {secretKeyHex: string; pubkeyHex: string}

// whether this transition moved the seal to the one-time key made for a
// bearer picture - only then does that key belong in the file
const movedToClaimKey = (
  transitionResult: unknown,
  claimKey: unknown
): boolean => {
  const result = transitionResult as TransitionResult | null
  const key = claimKey as ClaimKey | null
  return !!result && !!key && result.state.ownerPubkeyHex === key.pubkeyHex
}

// the loaded picture carrying the history INCLUDING this transition - for
// the next owner by name, or, after a move to the one-time key, for
// whoever holds the file. Null unless the file really is this seal's
// picture and the new history really follows from the old one.
const transitionedPicture = (
  picture: unknown,
  consignmentInput: unknown,
  transitionResult: unknown,
  claimKey: unknown
): Uint8Array | null => {
  if (!transitionFollows(consignmentInput, transitionResult)) return null
  if (!pictureMatches(consignmentInput, picture)) return null
  const next = nextConsignment(consignmentInput, transitionResult)
  return sealedPicture(
    picture,
    next,
    movedToClaimKey(transitionResult, claimKey)
      ? (claimKey as ClaimKey).secretKeyHex
      : undefined
  )
}

const canDownloadTransitioned = (
  picture: unknown,
  consignmentInput: unknown,
  transitionResult: unknown,
  claimKey: unknown
): boolean =>
  transitionedPicture(picture, consignmentInput, transitionResult, claimKey) !==
  null

const transitionedPictureLine = (
  transitionResult: unknown,
  claimKey: unknown
): string =>
  movedToClaimKey(transitionResult, claimKey)
    ? 'The download below is a BEARER picture: it carries the new history and the one-time key. Whoever holds the file holds the seal - hand it over like cash, and keep no copy you would not trust.'
    : 'Or hand over the picture itself: the download below carries the new history, for the next owner to read straight out of the file.'

const manageUi: UiNode[] = [
  {type: 'Text', value: 'Manage or verify a seal', style: 'subheading'},
  {
    type: 'Text',
    value:
      'Paste ANY consignment - your own, or one someone handed you - to validate its whole history yourself. No permission, no secret, and no network call needed just to check it.'
  },
  {
    type: 'ImagePicker',
    bind: 'loadedPicture',
    label: 'Load a picture that carries a seal - or paste a consignment below'
  },
  {
    type: 'Show',
    when: {var: 'loadedPicture'},
    children: [
      {type: 'Image', value: {var: 'loadedPicture.dataUrl'}},
      {
        type: 'Text',
        value: {helper: 'loadedPictureLine', args: [{var: 'loadedPicture'}]}
      },
      {
        type: 'Show',
        when: {helper: 'consignmentOfPicture', args: [{var: 'loadedPicture'}]},
        children: [
          {
            type: 'Button',
            label: 'Use this picture’s consignment',
            onClick: {
              action: 'set',
              path: 'consignmentInput',
              value: {
                helper: 'consignmentOfPicture',
                args: [{var: 'loadedPicture'}]
              }
            }
          }
        ]
      }
    ]
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
      {
        type: 'Show',
        when: {
          helper: 'pictureMatchLine',
          args: [{var: 'consignmentInput'}, {var: 'loadedPicture'}]
        },
        children: [
          {
            type: 'Text',
            value: {
              helper: 'pictureMatchLine',
              args: [{var: 'consignmentInput'}, {var: 'loadedPicture'}]
            }
          }
        ]
      },
      {
        type: 'Text',
        value: {
          cat: [
            'This consignment says the seal lives at ',
            {helper: 'consignmentHost', args: [{var: 'consignmentInput'}]},
            '. Nobody signed that line: make sure it is the mint you expect before you rely on anything it answers.'
          ]
        }
      },
      {
        type: 'Text',
        value:
          'The history above only shows it is self-consistent. Whether its current note is still unspent, and whether the mint certified every transition, is one question to that mint - by the note’s public key alone, nothing that could spend it.'
      },
      {
        type: 'Button',
        label: 'Check at the mint',
        onClick: {
          verb: 'seal.check',
          args: {consignment: {var: 'consignmentInput'}},
          result: 'checkResult'
        }
      },
      {
        type: 'List',
        each: {
          helper: 'checkReport',
          args: [
            {var: 'consignmentInput'},
            {var: 'checkResult'},
            {var: 'transitionResult'}
          ]
        },
        children: [{type: 'Text', value: {var: 'item'}}]
      },
      {
        type: 'Text',
        value:
          'Or check the certificates offline, against a mint key you already trust:'
      },
      {
        type: 'Input',
        bind: 'mintKeyInput',
        label: 'Mint signing key (66 hex characters, optional)'
      },
      {
        type: 'Show',
        when: {
          helper: 'offlineCertificateLine',
          args: [{var: 'consignmentInput'}, {var: 'mintKeyInput'}]
        },
        children: [
          {
            type: 'Text',
            value: {
              helper: 'offlineCertificateLine',
              args: [{var: 'consignmentInput'}, {var: 'mintKeyInput'}]
            }
          }
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
      {
        type: 'Show',
        when: {
          helper: 'not',
          args: [
            {
              helper: 'transitionFollows',
              args: [{var: 'consignmentInput'}, {var: 'transitionResult'}]
            }
          ]
        },
        children: [
          {
            type: 'Text',
            value: 'Transition to a new owner',
            style: 'subheading'
          },
          {
            type: 'Text',
            value:
              'Only possible if you hold the CURRENT owner’s own secret key. Never transmitted anywhere; used only to sign locally.'
          },
          {
            type: 'Show',
            when: {
              helper: 'claimKeyOfPicture',
              args: [{var: 'loadedPicture'}, {var: 'consignmentInput'}]
            },
            children: [
              {
                type: 'Text',
                value:
                  'The loaded picture carries the current owner’s key itself. Anyone with a copy of the file can use it - take the key, then transition the seal to an address of your own.'
              },
              {
                type: 'Button',
                label: 'Use the key this picture carries',
                onClick: {
                  action: 'set',
                  path: 'ownerSecretKeyHex',
                  value: {
                    helper: 'claimKeyOfPicture',
                    args: [{var: 'loadedPicture'}, {var: 'consignmentInput'}]
                  }
                }
              }
            ]
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
            when: {
              helper: 'pictureMatches',
              args: [{var: 'consignmentInput'}, {var: 'loadedPicture'}]
            },
            children: [
              {
                type: 'Text',
                value: 'Or hand it on as a bearer picture',
                style: 'subheading'
              },
              {
                type: 'Text',
                value:
                  'Instead of naming the next owner, move the seal to a one-time key and put that key into the picture: whoever holds the file holds the seal, and the first to move it to a key of their own keeps it. Like cash - a copy of the file is a copy of the key.'
              },
              {
                type: 'Show',
                when: {helper: 'not', args: [{var: 'claimKey'}]},
                children: [
                  {
                    type: 'Button',
                    label: 'Make a one-time key',
                    onClick: {
                      action: 'set',
                      path: 'claimKey',
                      value: {helper: 'newClaimKey', args: []}
                    }
                  }
                ]
              },
              {
                type: 'Show',
                when: {var: 'claimKey'},
                children: [
                  {
                    type: 'Text',
                    value: {
                      cat: [
                        'One-time secret key: ',
                        {var: 'claimKey.secretKeyHex'}
                      ]
                    },
                    style: 'response-block'
                  },
                  {
                    type: 'Text',
                    value:
                      'Copy this key somewhere safe BEFORE the next step. Once the seal has moved, it is the only thing that can move it again - this page forgets it on reload, and it only reaches the picture when you download it.'
                  },
                  {
                    type: 'Button',
                    label: 'Copy one-time key',
                    onClick: {
                      verb: 'clipboard.copy',
                      args: {text: {var: 'claimKey.secretKeyHex'}}
                    }
                  },
                  {
                    type: 'Button',
                    label: 'Move the seal to the one-time key',
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
                        nextOwnerPubkeyHex: {var: 'claimKey.pubkeyHex'}
                      },
                      result: 'transitionResult'
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
        when: {
          helper: 'transitionFollows',
          args: [{var: 'consignmentInput'}, {var: 'transitionResult'}]
        },
        children: [
          {type: 'Text', value: '✓ Transitioned', style: 'subheading'},
          {
            type: 'Text',
            value:
              'The seal has moved: its old note is spent. This page is done with it - what follows is the only record of where it went.'
          },
          {
            type: 'Show',
            when: {
              helper: 'not',
              args: [
                {
                  helper: 'nextConsignment',
                  args: [{var: 'consignmentInput'}, {var: 'transitionResult'}]
                }
              ]
            },
            children: [
              {
                type: 'Text',
                value:
                  'The new consignment could not be built here. The transition has landed all the same - copy the new state below and keep it with the consignment you pasted:'
              },
              {
                type: 'Text',
                value: {
                  helper: 'transitionStateText',
                  args: [{var: 'transitionResult'}]
                },
                style: 'response-block'
              }
            ]
          },
          {
            type: 'Text',
            value: {
              helper: 'transitionCertificateLine',
              args: [{var: 'transitionResult'}]
            }
          },
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
          },
          {
            type: 'Show',
            when: {
              helper: 'canDownloadTransitioned',
              args: [
                {var: 'loadedPicture'},
                {var: 'consignmentInput'},
                {var: 'transitionResult'},
                {var: 'claimKey'}
              ]
            },
            children: [
              {
                type: 'Text',
                value: {
                  helper: 'transitionedPictureLine',
                  args: [{var: 'transitionResult'}, {var: 'claimKey'}]
                }
              },
              {
                type: 'Button',
                label: 'Download picture with the new consignment',
                onClick: {
                  verb: 'file.download',
                  args: {
                    filename: {
                      helper: 'pictureFileName',
                      args: [{var: 'loadedPicture'}, {var: 'consignmentInput'}]
                    },
                    content: {
                      helper: 'transitionedPicture',
                      args: [
                        {var: 'loadedPicture'},
                        {var: 'consignmentInput'},
                        {var: 'transitionResult'},
                        {var: 'claimKey'}
                      ]
                    },
                    mime: {var: 'loadedPicture.type'}
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
      'To transition, the current owner reveals their own current state and signs with their own key, in the same step rotating the note directly into a fresh leaf committing to the next owner. A new consignment goes out carrying the extended history.',
      'A seal can be about a picture: pick a JPG or PNG when you issue it and the seal’s asset id is that file’s sha256. The consignment can then travel inside the file itself, in a place every viewer skips - the picture shows exactly as before, and "Manage" reads the seal back out of it and checks the file against the asset id.',
      'The mint answers that rotate with a rotation certificate: its signature that this note was burned into exactly that one. The consignment carries one per transition, so the next holder can check offline that no step is a look-alike note minted on the side, or one half of a split.'
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
      'A picture is a file, not a look: the asset id is over its exact bytes. A screenshot, a resized or recompressed copy, or one a chat app stripped of its metadata is a different file - send the file itself. A bearer picture also carries the current owner’s key, so every copy of it can take the seal; the first one to move it keeps it. And a picture can have more than one seal: anyone who has the file can issue another about it. What tells them apart is the mint and the owner of state #0.'
  },
  {
    type: 'Text',
    value:
      'Honest limits: transfers name a specific next owner, unless you make a bearer picture - then it is race-to-claim by design. An unredeemed transition is a promise, not a guarantee, until it actually lands at the mint - the underlying note can still only be redeemed once. A certified history is as good as the mint that signed it: the mint could sign a second history, and only the mint knows whether the last note is still unspent - "Check at the mint" asks it. A seal from a mint that issues no rotation certificates stays valid, but its history is only self-consistent, not certified.'
  },
  {
    type: 'Text',
    value:
      'Two things no certificate says. Which mint: a consignment names its own mint, unsigned, and any server can answer "unspent" and name any key - a history is only worth what the mint you know says about it. And who issued it: certificates start at the first transfer, so anyone can issue another seal with the same name. What tells two apart is the mint and the owner of state #0.'
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
    {
      verb: 'seal.check',
      reason:
        'Ask a seal’s own mint whether its current note is still unspent, and check the mint’s certificate for every transition'
    },
    {verb: 'clipboard.copy', reason: 'Copy a consignment'},
    {
      verb: 'file.download',
      reason: 'Save a consignment file, or a picture that carries one'
    }
  ],
  nav: {position: 'right', icon: 'fingerprint', label: 'Seals'},
  state: {
    name: '',
    description: '',
    picture: null,
    firstOwnerAddress: '',
    firstOwnerPubkeyHex: '',
    selectedNote: null,
    genesisPlan: null,
    issuedNote: null,
    loadedPicture: null,
    consignmentInput: '',
    checkResult: null,
    mintKeyInput: '',
    myAddress: '',
    myResolvedPubkeyHex: '',
    ownerSecretKeyHex: '',
    nextOwnerAddress: '',
    nextOwnerPubkeyHex: '',
    claimKey: null,
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
  nextConsignment: nextConsignment as AddonHelper,
  transitionFollows: transitionFollows as AddonHelper,
  transitionCertificateLine: transitionCertificateLine as AddonHelper,
  transitionStateText: transitionStateText as AddonHelper,
  consignmentHost: consignmentHost as AddonHelper,
  checkReport: checkReport as AddonHelper,
  offlineCertificateLine: offlineCertificateLine as AddonHelper,
  planMatchesPicture: planMatchesPicture as AddonHelper,
  issuedPicture: issuedPicture as AddonHelper,
  pictureFileName: pictureFileName as AddonHelper,
  consignmentOfPicture: consignmentOfPicture as AddonHelper,
  loadedPictureLine: loadedPictureLine as AddonHelper,
  claimKeyOfPicture: claimKeyOfPicture as AddonHelper,
  pictureMatches: pictureMatches as AddonHelper,
  pictureMatchLine: pictureMatchLine as AddonHelper,
  // a fresh, random keypair for a bearer picture's hand-over - made and
  // held in this page's own state only, never from this wallet's seed
  newClaimKey: generateKeypair as AddonHelper,
  transitionedPicture: transitionedPicture as AddonHelper,
  canDownloadTransitioned: canDownloadTransitioned as AddonHelper,
  transitionedPictureLine: transitionedPictureLine as AddonHelper
}

export const sealsAddon: Addon = {
  manifest: sealsManifest,
  helpers: sealsHelpers
}
