import type {Addon, AddonHelper, AddonManifest} from '../types'
import {
  isBech32Lnurl,
  fromBech32Lnurl,
  toBech32Lnurl,
  noteK1,
  noteDeclaredAmount,
  noteSignature,
  serviceOriginOf,
  verifyNoteSignature,
  isCk1,
  isBolt11Invoice,
  decodeBolt11AmountMsat,
  decodeBolt11PaymentHash
} from '../../lnurlcash'

// A pure text transform, nothing more - no verb/permission needed at all,
// same reasoning as the currency converter: this never touches a note, a
// secret, or the network. Reuses this wallet's own LUD-01 bech32 codec
// (src/lib/urls.ts) rather than re-implementing it, so it decodes/encodes
// exactly the same way every note URL in this wallet already does.
const stripScheme = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .replace(/^lightning:/i, '')
    .trim()

const isDecodable = (value: unknown): boolean =>
  isBech32Lnurl(stripScheme(value))

const decodeLnurl = (value: unknown): string | null =>
  fromBech32Lnurl(stripScheme(value))

const looksLikeUrl = (value: unknown): boolean =>
  /^https?:\/\//i.test(stripScheme(value))

const encodeLnurl = (value: unknown): string | null => {
  const stripped = stripScheme(value)
  return looksLikeUrl(stripped) ? toBech32Lnurl(stripped) : null
}

// A pasted lnurlcash bearer note URL (see src/lib/urls.ts) - same shape
// this wallet's own bearers are stored as, but detected from plain pasted
// text rather than something already held. `amount` is only this wallet's
// own convention when it builds a note url (buildNoteUrl) - plenty of
// real note urls carry just k1 (+ sig), no declared amount - so k1 alone
// is the actual required field; amount/sig only disambiguate it from some
// other k1-bearing LNURL (e.g. LNURL-auth's own callback) that isn't a
// note at all. noteK1/noteDeclaredAmount/noteSignature are all null-safe
// on a non-URL/malformed string, so this never throws.
const looksLikeNoteUrl = (value: unknown): boolean => {
  const stripped = stripScheme(value)
  return (
    noteK1(stripped) !== null &&
    (noteDeclaredAmount(stripped) !== null || noteSignature(stripped) !== null)
  )
}

const noteKindDisplay = (value: unknown): string => {
  const k1 = noteK1(stripScheme(value))
  if (!k1) return '-'
  return isCk1(k1)
    ? 'LUD-25 Part 2 (ck1 signature, address-bound)'
    : 'Legacy hash-keyed (Part 1)'
}

const noteAmountDisplay = (value: unknown): string => {
  const msat = noteDeclaredAmount(stripScheme(value))
  return msat === null
    ? 'not declared in this url'
    : `${Math.floor(msat / 1000).toLocaleString()} sats`
}

const noteK1Display = (value: unknown): string =>
  noteK1(stripScheme(value)) ?? '-'

const noteOriginDisplay = (value: unknown): string => {
  try {
    return serviceOriginOf(stripScheme(value))
  } catch {
    return '-'
  }
}

// Same verifyNoteSignature call BearerCard.tsx's own offlineVerified check
// makes, just against a mintPubkey typed in here rather than this wallet's
// own trusted-mints registry: this addon stays a pure text transform (see
// the file's own header comment) with no wallet-state reads of its own, so
// it works the same for a note from a mint this device has never seen -
// paste the mint's advertised mintPubkey (Mint page's mint-list entry, or
// the note issuer's own disclosure) alongside the note to check it.
// verifyNoteSignature itself dispatches on k1's own shape (legacy preimage
// vs ck1 signature).
const noteVerifiedDisplay = (value: unknown, mintPubkey: unknown): string => {
  const url = stripScheme(value)
  const sig = noteSignature(url)
  if (!sig) return 'No signature attached - cannot verify offline.'
  const k1 = noteK1(url)
  const amount = noteDeclaredAmount(url)
  if (!k1 || amount === null) return 'Malformed note URL.'
  const key = String(mintPubkey ?? '').trim()
  if (!key) {
    return "Signature attached - enter the mint's public key above to verify it."
  }
  return verifyNoteSignature(k1, amount, sig, key)
    ? 'Verified - signature matches the mint key entered above.'
    : 'NOT verified - signature does not match the mint key entered above.'
}

const isBolt11Value = (value: unknown): boolean =>
  isBolt11Invoice(stripScheme(value))

const BOLT11_NETWORK_LABELS: Record<string, string> = {
  bc: 'mainnet',
  tb: 'testnet',
  bcrt: 'regtest',
  tbs: 'signet',
  sb: 'signet'
}

const bolt11NetworkDisplay = (value: unknown): string => {
  const match = stripScheme(value)
    .trim()
    .toLowerCase()
    .match(/^ln(bc|tb|bcrt|tbs|sb)/)
  return match ? (BOLT11_NETWORK_LABELS[match[1]] ?? match[1]) : '-'
}

const bolt11AmountDisplay = (value: unknown): string => {
  const msat = decodeBolt11AmountMsat(stripScheme(value))
  return msat === null
    ? 'Any amount'
    : `${Math.floor(msat / 1000).toLocaleString()} sats`
}

const bolt11HashDisplay = (value: unknown): string =>
  decodeBolt11PaymentHash(stripScheme(value)) ??
  'Could not decode payment hash.'

const bech32DecoderManifest: AddonManifest = {
  id: 'bech32-decoder',
  name: 'Bech32 Decoder',
  version: '1',
  icon: 'code',
  description:
    'Decode an LNURL (or lightning: URI) to its plain URL, encode a plain URL to bech32, or inspect a pasted lnurlcash note URL or bolt11 invoice - detects which one automatically.',
  permissions: [],
  nav: {position: 'right', icon: 'code', label: 'Decode'},
  state: {
    input: '',
    mintPubkey: ''
  },
  ui: {
    type: 'View',
    children: [
      {type: 'Text', value: 'Bech32 Decoder', style: 'heading'},
      {
        type: 'Input',
        bind: 'input',
        label:
          'LNURL, lightning: URI, note URL, bolt11 invoice, or a plain https:// URL'
      },
      {
        type: 'Show',
        when: {helper: 'isDecodable', args: [{var: 'input'}]},
        children: [
          {type: 'Text', value: 'Decoded URL', style: 'subheading'},
          {type: 'Text', value: {helper: 'decodeLnurl', args: [{var: 'input'}]}}
        ]
      },
      {
        type: 'Show',
        when: {helper: 'looksLikeNoteUrl', args: [{var: 'input'}]},
        children: [
          {type: 'Text', value: 'LNURLcash Note', style: 'subheading'},
          {
            type: 'Text',
            value: {helper: 'noteKindDisplay', args: [{var: 'input'}]}
          },
          {
            type: 'Text',
            value: {
              cat: [
                'Amount: ',
                {helper: 'noteAmountDisplay', args: [{var: 'input'}]}
              ]
            }
          },
          {
            type: 'Text',
            value: {
              cat: ['k1: ', {helper: 'noteK1Display', args: [{var: 'input'}]}]
            }
          },
          {
            type: 'Text',
            value: {
              cat: [
                'Mint: ',
                {helper: 'noteOriginDisplay', args: [{var: 'input'}]}
              ]
            }
          },
          {
            type: 'Input',
            bind: 'mintPubkey',
            label: "Mint's public key (optional, to verify the signature)"
          },
          {
            type: 'Text',
            value: {
              helper: 'noteVerifiedDisplay',
              args: [{var: 'input'}, {var: 'mintPubkey'}]
            }
          }
        ]
      },
      {
        type: 'Show',
        when: {helper: 'isBolt11Value', args: [{var: 'input'}]},
        children: [
          {type: 'Text', value: 'Bolt11 Invoice', style: 'subheading'},
          {
            type: 'Text',
            value: {
              cat: [
                'Network: ',
                {helper: 'bolt11NetworkDisplay', args: [{var: 'input'}]}
              ]
            }
          },
          {
            type: 'Text',
            value: {
              cat: [
                'Amount: ',
                {helper: 'bolt11AmountDisplay', args: [{var: 'input'}]}
              ]
            }
          },
          {
            type: 'Text',
            value: {
              cat: [
                'Payment hash: ',
                {helper: 'bolt11HashDisplay', args: [{var: 'input'}]}
              ]
            }
          }
        ]
      },
      {
        type: 'Show',
        when: {helper: 'looksLikeUrl', args: [{var: 'input'}]},
        children: [
          {type: 'Text', value: 'Bech32-encoded LNURL', style: 'subheading'},
          {type: 'Text', value: {helper: 'encodeLnurl', args: [{var: 'input'}]}}
        ]
      },
      {
        type: 'Show',
        when: {
          and: [
            {gt: [{helper: 'stringLength', args: [{var: 'input'}]}, 0]},
            {
              helper: 'not',
              args: [{helper: 'isDecodable', args: [{var: 'input'}]}]
            },
            {
              helper: 'not',
              args: [{helper: 'looksLikeUrl', args: [{var: 'input'}]}]
            },
            {
              helper: 'not',
              args: [{helper: 'isBolt11Value', args: [{var: 'input'}]}]
            }
          ]
        },
        children: [
          {
            type: 'Text',
            value:
              "Doesn't look like an LNURL, a note URL, a bolt11 invoice, or a plain https:// URL."
          }
        ]
      }
    ]
  }
}

const bech32DecoderHelpers: Record<string, AddonHelper> = {
  isDecodable: isDecodable as AddonHelper,
  decodeLnurl: decodeLnurl as AddonHelper,
  looksLikeUrl: looksLikeUrl as AddonHelper,
  encodeLnurl: encodeLnurl as AddonHelper,
  looksLikeNoteUrl: looksLikeNoteUrl as AddonHelper,
  noteKindDisplay: noteKindDisplay as AddonHelper,
  noteAmountDisplay: noteAmountDisplay as AddonHelper,
  noteK1Display: noteK1Display as AddonHelper,
  noteOriginDisplay: noteOriginDisplay as AddonHelper,
  noteVerifiedDisplay: noteVerifiedDisplay as AddonHelper,
  isBolt11Value: isBolt11Value as AddonHelper,
  bolt11NetworkDisplay: bolt11NetworkDisplay as AddonHelper,
  bolt11AmountDisplay: bolt11AmountDisplay as AddonHelper,
  bolt11HashDisplay: bolt11HashDisplay as AddonHelper,
  stringLength: ((value: unknown) =>
    String(value ?? '').trim().length) as AddonHelper
}

export const bech32DecoderAddon: Addon = {
  manifest: bech32DecoderManifest,
  helpers: bech32DecoderHelpers
}
