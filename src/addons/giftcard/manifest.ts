import type {Addon, AddonHelper, AddonManifest, UiNode} from '../types'
import {
  buildGiftCardPdf,
  GIFT_CARD_TEMPLATES,
  GIFT_CARD_TEMPLATE_NAMES,
  type GiftCardTemplate
} from './pdf'

const isTemplate = (value: unknown): value is GiftCardTemplate =>
  typeof value === 'string' &&
  (GIFT_CARD_TEMPLATE_NAMES as string[]).includes(value)

// display-only - the DSL's View.style is a static string set at manifest-
// authoring time (see types.ts), not an Expr, so there's no way to swap a
// preview box's own CSS class to match the chosen template at runtime;
// this text line is the honest substitute for a live colour preview
const templateLabel = (value: unknown): string =>
  isTemplate(value) ? GIFT_CARD_TEMPLATES[value].label : String(value ?? '')

// note.split's own return shape (verbs.ts) always resolves amountSat as a
// plain Math.floor of the actual split msat amount - reading it back from
// `results` rather than echoing the holder's typed `amountSat` state keeps
// the printed card correct even if a mint's own rounding ever nudges it
const buildGiftCardPdfFromResult = async (
  message: unknown,
  results: unknown,
  template: unknown
): Promise<Uint8Array> => {
  const first = Array.isArray(results) ? results[0] : null
  if (!first) throw new Error('No gift card note to print yet.')
  return buildGiftCardPdf(
    String(message ?? ''),
    Number(first.amountSat) || 0,
    isTemplate(template) ? template : 'classic',
    String(first.url)
  )
}

// note.split's `tickets` arg needs a single-element array literal - built
// via a helper (mirrors raffle's own planTickets) rather than an inline
// Expr array literal, since a plain {amountMsat, tags} object isn't one
// of Expr's specifically-typed union members (see types.ts's own comment
// on why: TS structural typing would make a bare "any object" member
// overlap every operator shape). A helper's return type is just
// `unknown`, so this sidesteps that entirely instead of needing a cast.
const giftCardTickets = (
  amountSat: unknown
): {amountMsat: number; tags: string[]}[] => [
  {amountMsat: Math.round(Number(amountSat) * 1000), tags: ['gift-card']}
]

const templateButton = (id: GiftCardTemplate): UiNode => ({
  type: 'Button',
  label: GIFT_CARD_TEMPLATES[id].label,
  onClick: {action: 'set', path: 'template', value: id}
})

const ui: UiNode = {
  type: 'View',
  children: [
    {type: 'Text', value: 'Gift Card Designer', style: 'heading'},
    {
      type: 'Text',
      value:
        'Split part of a held note into a fresh bearer note, wrapped in a printable gift card - a message, an amount, and a QR the recipient scans to claim it in any LNURLcash wallet.'
    },
    {
      type: 'NotePicker',
      bind: 'sourceNote',
      filter: {spent: false},
      label: 'Note to fund the gift'
    },
    {
      type: 'Input',
      bind: 'amountSat',
      kind: 'number',
      label: 'Gift amount (sats)'
    },
    {type: 'Input', bind: 'message', label: 'Message'},
    {type: 'Text', value: 'Choose a design', style: 'subheading'},
    {
      type: 'View',
      style: 'row',
      children: GIFT_CARD_TEMPLATE_NAMES.map(templateButton)
    },
    {
      type: 'Text',
      value: {
        cat: [
          'Selected design: ',
          {helper: 'templateLabel', args: [{var: 'template'}]}
        ]
      }
    },
    {
      type: 'Show',
      when: {
        and: [
          {var: 'sourceNote'},
          {gt: [{var: 'amountSat'}, 0]},
          {lte: [{var: 'amountSat'}, {var: 'sourceNote.amountSat'}]}
        ]
      },
      children: [
        {
          type: 'Button',
          label: 'Create gift card',
          onClick: {
            verb: 'note.split',
            args: {
              note: {var: 'sourceNote.id'},
              tickets: {
                helper: 'giftCardTickets',
                args: [{var: 'amountSat'}]
              }
            },
            result: 'results'
          }
        }
      ]
    },
    {
      type: 'Show',
      when: {gt: [{var: 'results.length'}, 0]},
      children: [
        {type: 'Text', value: 'Gift card ready', style: 'subheading'},
        {
          type: 'Text',
          value:
            'The note has already been split off - download the card now, or come back for it later from this addon (the note itself stays in your wallet either way).'
        },
        {
          type: 'Button',
          label: 'Download gift card PDF',
          onClick: {
            verb: 'file.download',
            args: {
              filename: 'gift-card.pdf',
              content: {
                helper: 'buildGiftCardPdfFromResult',
                args: [{var: 'message'}, {var: 'results'}, {var: 'template'}]
              }
            }
          }
        }
      ]
    }
  ]
}

export const giftCardManifest: AddonManifest = {
  id: 'giftcard',
  name: 'Gift Card Designer',
  version: '1',
  icon: 'gift',
  description:
    'Split a held note into a gift amount and print it as a designed, QR-carrying gift card.',
  permissions: [
    {
      verb: 'note.query',
      scope: 'spent:false',
      reason: 'Let you pick which held note funds the gift'
    },
    {
      verb: 'note.split',
      reason:
        'Split the chosen note into the gift amount, tagged as it is created'
    },
    {verb: 'file.download', reason: 'Save the printable gift card PDF'}
  ],
  nav: {position: 'left', icon: 'gift', label: 'Gift Card'},
  state: {
    sourceNote: null,
    amountSat: 21000,
    message: 'Happy Birthday! Enjoy your gift.',
    template: 'classic',
    results: []
  },
  ui
}

export const giftCardHelpers: Record<string, AddonHelper> = {
  templateLabel: templateLabel as AddonHelper,
  giftCardTickets: giftCardTickets as AddonHelper,
  buildGiftCardPdfFromResult: buildGiftCardPdfFromResult as AddonHelper
}

export const giftCardAddon: Addon = {
  manifest: giftCardManifest,
  helpers: giftCardHelpers
}
