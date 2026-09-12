import type {Addon, AddonHelper, AddonManifest} from '../types'
import {generateSeedPhrase} from '../../keys'
import {
  NPUB_HRP,
  NSEC_HRP,
  encodeBech32,
  generateNostrKeypair,
  bechToHex,
  parseHexBytes,
  deriveNostrKeypair
} from './nostr'

// Nostr (NIP-01/NIP-06/NIP-19) key tooling - see nostr.ts for the actual
// math. Entirely independent of this wallet's own seed: "Generate
// keypair" and "Derive from seed phrase" below both work purely off
// values held in this addon's own page-local state (see AddonRun.tsx/
// Renderer.tsx's 'run' mode - never persisted, gone on reload), never
// cashSecrets.ts or the wallet's unlocked cash root.
const trimmedString = (value: unknown): string => String(value ?? '').trim()

const stringLength = (value: unknown): number => trimmedString(value).length

const bechToHexDisplay = (value: unknown): string =>
  bechToHex(trimmedString(value)) ?? '-'

// shown for whatever length hex is typed in - not just a strict 32-byte
// pubkey/privkey - so pasting something the wrong length still shows a
// clear reason rather than a silent dash
const hexToBechDisplay = (value: unknown, hrp: string): string => {
  const raw = trimmedString(value)
  const bytes = parseHexBytes(raw)
  if (!bytes) return raw ? 'Not valid hex' : '-'
  if (bytes.length !== 32) {
    return `Not 32 bytes (got ${bytes.length}) - ${hrp} needs exactly 32`
  }
  return encodeBech32(hrp, bytes)
}

const hexToNpubDisplay = (value: unknown): string =>
  hexToBechDisplay(value, NPUB_HRP)

const hexToNsecDisplay = (value: unknown): string =>
  hexToBechDisplay(value, NSEC_HRP)

const derivedNpubDisplay = (
  seedPhrase: unknown,
  accountIndex: unknown
): string =>
  deriveNostrKeypair(trimmedString(seedPhrase), Number(accountIndex) || 0)
    ?.npub ?? '-'

const derivedNsecDisplay = (
  seedPhrase: unknown,
  accountIndex: unknown
): string =>
  deriveNostrKeypair(trimmedString(seedPhrase), Number(accountIndex) || 0)
    ?.nsec ?? '-'

const nostrToolsManifest: AddonManifest = {
  id: 'nostr-tools',
  name: 'Nostr Tools',
  version: '1',
  icon: 'radio',
  description:
    "Generate a Nostr keypair (npub/nsec), convert between bech32 and hex, and derive a Nostr identity from a BIP39 seed phrase (NIP-06) - entirely separate from this wallet's own seed.",
  permissions: [],
  nav: {position: 'right', icon: 'radio', label: 'Nostr'},
  state: {
    generated: null,
    bechInput: '',
    hexInput: '',
    seedPhrase: '',
    accountIndex: 0
  },
  ui: {
    type: 'View',
    children: [
      {type: 'Text', value: 'Nostr Tools', style: 'heading'},
      {
        type: 'Text',
        value:
          'Nostr (NIP-01/06/19) key tooling, independent of this wallet - nothing here is stored or connected to your wallet seed.'
      },

      {type: 'Text', value: 'Generate a keypair', style: 'subheading'},
      {
        type: 'Button',
        label: 'Generate new keypair',
        onClick: {
          action: 'set',
          path: 'generated',
          value: {helper: 'generateNostrKeypair', args: []}
        }
      },
      {
        type: 'Show',
        when: {var: 'generated'},
        children: [
          {
            type: 'Text',
            value: {cat: ['npub: ', {var: 'generated.npub'}]},
            style: 'seed-block'
          },
          {
            type: 'Button',
            label: 'Copy npub',
            onClick: {
              verb: 'clipboard.copy',
              args: {text: {var: 'generated.npub'}}
            }
          },
          {
            type: 'Text',
            value: {cat: ['nsec: ', {var: 'generated.nsec'}]},
            style: 'seed-block'
          },
          {
            type: 'Button',
            label: 'Copy nsec',
            onClick: {
              verb: 'clipboard.copy',
              args: {text: {var: 'generated.nsec'}}
            }
          }
        ]
      },

      {type: 'Text', value: 'Bech32 → hex', style: 'subheading'},
      {
        type: 'Input',
        bind: 'bechInput',
        label: 'npub1..., nsec1..., or any other bech32 value'
      },
      {
        type: 'Show',
        when: {gt: [{helper: 'stringLength', args: [{var: 'bechInput'}]}, 0]},
        children: [
          {
            type: 'Text',
            value: {
              cat: [
                'hex: ',
                {helper: 'bechToHexDisplay', args: [{var: 'bechInput'}]}
              ]
            }
          },
          {
            type: 'Button',
            label: 'Copy hex',
            onClick: {
              verb: 'clipboard.copy',
              args: {
                text: {helper: 'bechToHexDisplay', args: [{var: 'bechInput'}]}
              }
            }
          }
        ]
      },

      {type: 'Text', value: 'Hex → bech32', style: 'subheading'},
      {type: 'Input', bind: 'hexInput', label: '32-byte hex value'},
      {
        type: 'Show',
        when: {gt: [{helper: 'stringLength', args: [{var: 'hexInput'}]}, 0]},
        children: [
          {
            type: 'Text',
            value: {
              cat: [
                'As npub: ',
                {helper: 'hexToNpubDisplay', args: [{var: 'hexInput'}]}
              ]
            }
          },
          {
            type: 'Text',
            value: {
              cat: [
                'As nsec: ',
                {helper: 'hexToNsecDisplay', args: [{var: 'hexInput'}]}
              ]
            }
          }
        ]
      },

      {
        type: 'Text',
        value: 'Derive from a seed phrase (NIP-06)',
        style: 'subheading'
      },
      {
        type: 'Text',
        value:
          "Ephemeral - held only on this page, never connected to this wallet's real seed. Reloading or leaving this page discards it. Paste an existing BIP39 phrase, or generate a throwaway one."
      },
      {
        type: 'Button',
        label: 'Generate new seed',
        onClick: {
          action: 'set',
          path: 'seedPhrase',
          value: {helper: 'generateSeedPhrase', args: []}
        }
      },
      {type: 'Input', bind: 'seedPhrase', label: 'BIP39 seed phrase'},
      {
        type: 'Input',
        bind: 'accountIndex',
        kind: 'number',
        label: "Account index (NIP-06's own m/44'/1237'/<account>'/0/0)"
      },
      {
        type: 'Show',
        when: {
          gt: [{helper: 'stringLength', args: [{var: 'seedPhrase'}]}, 0]
        },
        children: [
          {
            type: 'Text',
            value: {
              cat: [
                'npub: ',
                {
                  helper: 'derivedNpubDisplay',
                  args: [{var: 'seedPhrase'}, {var: 'accountIndex'}]
                }
              ]
            }
          },
          {
            type: 'Text',
            value: {
              cat: [
                'nsec: ',
                {
                  helper: 'derivedNsecDisplay',
                  args: [{var: 'seedPhrase'}, {var: 'accountIndex'}]
                }
              ]
            }
          }
        ]
      }
    ]
  }
}

const nostrToolsHelpers: Record<string, AddonHelper> = {
  stringLength: stringLength as AddonHelper,
  generateSeedPhrase: generateSeedPhrase as AddonHelper,
  generateNostrKeypair: generateNostrKeypair as AddonHelper,
  bechToHexDisplay: bechToHexDisplay as AddonHelper,
  hexToNpubDisplay: hexToNpubDisplay as AddonHelper,
  hexToNsecDisplay: hexToNsecDisplay as AddonHelper,
  derivedNpubDisplay: derivedNpubDisplay as AddonHelper,
  derivedNsecDisplay: derivedNsecDisplay as AddonHelper
}

export const nostrToolsAddon: Addon = {
  manifest: nostrToolsManifest,
  helpers: nostrToolsHelpers
}
