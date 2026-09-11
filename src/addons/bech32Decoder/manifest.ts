import type {Addon, AddonHelper, AddonManifest} from '../types'
import {isBech32Lnurl, fromBech32Lnurl, toBech32Lnurl} from '../../lnurlcash'

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

const bech32DecoderManifest: AddonManifest = {
  id: 'bech32-decoder',
  name: 'Bech32 Decoder',
  version: '1',
  icon: 'code',
  description:
    'Decode an LNURL (or lightning: URI) to its plain URL, or encode a plain URL to bech32 - detects which direction automatically.',
  permissions: [],
  nav: {position: 'right', icon: 'code', label: 'Decode'},
  state: {
    input: ''
  },
  ui: {
    type: 'View',
    children: [
      {type: 'Text', value: 'Bech32 Decoder', style: 'heading'},
      {
        type: 'Input',
        bind: 'input',
        label: 'LNURL, lightning: URI, or a plain https:// URL'
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
            }
          ]
        },
        children: [
          {
            type: 'Text',
            value: "Doesn't look like an LNURL or a plain https:// URL."
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
  stringLength: ((value: unknown) =>
    String(value ?? '').trim().length) as AddonHelper
}

export const bech32DecoderAddon: Addon = {
  manifest: bech32DecoderManifest,
  helpers: bech32DecoderHelpers
}
