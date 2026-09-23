import type {Addon, AddonHelper, AddonManifest, UiNode} from '../types'
import {generateSeedPhrase} from '../../keys'
import {
  BIP39_WORD_COUNT_BITS,
  deriveBip39Mnemonic,
  deriveHexEntropy,
  deriveWif,
  deriveXprv,
  isUsableSeedPhrase
} from './bip85'

// BIP85 "Deterministic Entropy From BIP32 Keychains" - see bip85.ts's own
// header comment for the full picture (why the seed phrase here is
// deliberately holder-entered page-local state, never this wallet's real
// unlocked cash root, and why byte-exact spec compatibility matters more
// than usual for this one). This manifest is pure UI glue: which of the
// four applications is selected, and dispatching to the matching pure
// function in bip85.ts.

const APPLICATIONS = ['bip39', 'hex', 'wif', 'xprv'] as const
const WORD_COUNTS = [12, 15, 18, 21, 24]

const APPLICATION_LABEL: Record<string, string> = {
  bip39: 'BIP39 mnemonic',
  hex: 'Hex entropy',
  wif: 'WIF private key',
  xprv: 'XPRV root'
}

// checkmark on whichever exclusive option (application, word count) is
// currently selected - same pattern the sibling betlocker addon's own
// outcomeButtonLabel uses for its outcome picker
const pickerLabel = (item: unknown, selected: unknown): string =>
  String(item) === String(selected)
    ? `✓ ${APPLICATION_LABEL[String(item)] ?? String(item)}`
    : (APPLICATION_LABEL[String(item)] ?? String(item))

const wordCountLabel = (item: unknown, selected: unknown): string =>
  Number(item) === Number(selected) ? `✓ ${item}` : `${item}`

// the DSL's Expr grammar has no eq operator (types.ts - only and/gt/lte
// besides helper/var/cat), so an exact-match Show condition goes through a
// named helper instead, same as every other addon's own equivalent check
const isApplication = (application: unknown, name: unknown): boolean =>
  String(application) === String(name)

// '' when usable, else why not - the live validation message shown above
// the derived output
const bip85Problem = (
  seedPhrase: unknown,
  application: unknown,
  wordCount: unknown,
  numBytes: unknown,
  index: unknown
): string => {
  if (!isUsableSeedPhrase(seedPhrase)) {
    return 'Enter a valid BIP39 seed phrase first (12/15/18/21/24 real words).'
  }
  const i = Number(index)
  if (!Number.isInteger(i) || i < 0) {
    return 'Index must be a non-negative whole number.'
  }
  if (
    String(application) === 'bip39' &&
    !BIP39_WORD_COUNT_BITS[Number(wordCount)]
  ) {
    return 'Pick a word count.'
  }
  if (String(application) === 'hex') {
    const n = Number(numBytes)
    if (!Number.isInteger(n) || n < 16 || n > 64) {
      return 'Byte count must be a whole number between 16 and 64.'
    }
  }
  return ''
}

// dispatches to whichever of bip85.ts's four pure derivations matches the
// selected application - the one thing every button/output below reads,
// so "what's currently shown" and "what Copy copies" can never drift apart
const derivedOutputFor = (
  seedPhrase: unknown,
  application: unknown,
  wordCount: unknown,
  numBytes: unknown,
  index: unknown
): string => {
  switch (String(application)) {
    case 'bip39':
      return deriveBip39Mnemonic(seedPhrase, wordCount, index) ?? ''
    case 'hex':
      return deriveHexEntropy(seedPhrase, numBytes, index) ?? ''
    case 'wif':
      return deriveWif(seedPhrase, index) ?? ''
    case 'xprv':
      return deriveXprv(seedPhrase, index) ?? ''
    default:
      return ''
  }
}

const applicationRow: UiNode = {
  type: 'View',
  style: 'row',
  children: [
    {
      type: 'For',
      each: {var: 'applications'},
      children: [
        {
          type: 'Button',
          label: {
            helper: 'pickerLabel',
            args: [{var: 'item'}, {var: 'application'}]
          },
          onClick: {action: 'set', path: 'application', value: {var: 'item'}}
        }
      ]
    }
  ]
}

const wordCountRow: UiNode = {
  type: 'Show',
  when: {helper: 'isApplication', args: [{var: 'application'}, 'bip39']},
  children: [
    {type: 'Text', value: 'Word count'},
    {
      type: 'View',
      style: 'row',
      children: [
        {
          type: 'For',
          each: {var: 'wordCounts'},
          children: [
            {
              type: 'Button',
              label: {
                helper: 'wordCountLabel',
                args: [{var: 'item'}, {var: 'wordCount'}]
              },
              onClick: {action: 'set', path: 'wordCount', value: {var: 'item'}}
            }
          ]
        }
      ]
    }
  ]
}

const bip85Manifest: AddonManifest = {
  id: 'bip85',
  name: 'BIP85',
  version: '1',
  icon: 'gitbranch',
  description:
    'Deterministic Entropy From BIP32 Keychains (BIP85) - derives an independent, deterministic BIP39 mnemonic, raw hex entropy, a WIF private key, or a whole new XPRV root from one seed phrase and an index. Nothing about the output lets anyone work backward to the seed that produced it, so a derived value is safe to use in, or hand to, a separate, less-trusted wallet or application.',
  permissions: [],
  experimental: true,
  nav: {position: 'right', icon: 'gitbranch', label: 'BIP85'},
  state: {
    seedPhrase: '',
    application: 'bip39',
    wordCount: 12,
    numBytes: 32,
    index: 0,
    applications: [...APPLICATIONS],
    wordCounts: WORD_COUNTS
  },
  ui: {
    type: 'View',
    children: [
      {type: 'Text', value: 'BIP85', style: 'heading'},
      {
        type: 'Text',
        value:
          'This is a real cryptographic operation, not a demo like the sibling Seed Generator addon - whatever seed phrase you type here is used exactly as entered. Held only on this page (never persisted, never this wallet’s own unlocked seed - this wallet never keeps its own real mnemonic in memory once unlocked, only keys already derived from it, so there is nothing to fill in automatically from it either) and gone the moment you reload or leave. Every application below is checked byte-for-byte against BIP85’s own published test vectors.'
      },
      {type: 'Input', bind: 'seedPhrase', label: 'Seed phrase (12/24 words)'},
      {
        type: 'Button',
        label: 'Generate new seed',
        onClick: {
          action: 'set',
          path: 'seedPhrase',
          value: {helper: 'generateSeedPhrase', args: []}
        }
      },
      {type: 'Text', value: 'Application', style: 'subheading'},
      applicationRow,
      wordCountRow,
      {
        type: 'Show',
        when: {helper: 'isApplication', args: [{var: 'application'}, 'hex']},
        children: [
          {
            type: 'Input',
            bind: 'numBytes',
            kind: 'number',
            label: 'Byte count (16-64)'
          }
        ]
      },
      {type: 'Input', bind: 'index', kind: 'number', label: 'Index'},
      {
        type: 'Show',
        when: {
          helper: 'bip85Problem',
          args: [
            {var: 'seedPhrase'},
            {var: 'application'},
            {var: 'wordCount'},
            {var: 'numBytes'},
            {var: 'index'}
          ]
        },
        children: [
          {
            type: 'Text',
            value: {
              helper: 'bip85Problem',
              args: [
                {var: 'seedPhrase'},
                {var: 'application'},
                {var: 'wordCount'},
                {var: 'numBytes'},
                {var: 'index'}
              ]
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
              helper: 'bip85Problem',
              args: [
                {var: 'seedPhrase'},
                {var: 'application'},
                {var: 'wordCount'},
                {var: 'numBytes'},
                {var: 'index'}
              ]
            }
          ]
        },
        children: [
          {
            type: 'Text',
            value: {
              helper: 'derivedOutputFor',
              args: [
                {var: 'seedPhrase'},
                {var: 'application'},
                {var: 'wordCount'},
                {var: 'numBytes'},
                {var: 'index'}
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
                  helper: 'derivedOutputFor',
                  args: [
                    {var: 'seedPhrase'},
                    {var: 'application'},
                    {var: 'wordCount'},
                    {var: 'numBytes'},
                    {var: 'index'}
                  ]
                }
              }
            }
          }
        ]
      }
    ]
  }
}

const bip85Helpers: Record<string, AddonHelper> = {
  pickerLabel: pickerLabel as AddonHelper,
  wordCountLabel: wordCountLabel as AddonHelper,
  isApplication: isApplication as AddonHelper,
  bip85Problem: bip85Problem as AddonHelper,
  derivedOutputFor: derivedOutputFor as AddonHelper,
  generateSeedPhrase: generateSeedPhrase as AddonHelper
}

export const bip85Addon: Addon = {
  manifest: bip85Manifest,
  helpers: bip85Helpers
}
