import type {Addon, AddonHelper, AddonManifest, UiNode} from '../types'
import {generateSeedPhrase} from '../../keys'
import {trustedMints} from '../../trustedMints'
import {deriveOnchainReceive, type OnchainReceiveResult} from './onchainReceive'

// see onchainReceive.ts's own header comment for the full picture (why
// reusing the SAME cp1 keypair for a real onchain output is safe, and why
// the seed phrase here is page-local holder-entered state, never this
// wallet's real unlocked cash root - same boundary as the sibling bip85/
// seedGenerator addons). This manifest is pure UI glue around one pure
// derivation.

const trimmedString = (value: unknown): string => String(value ?? '').trim()

const onchainProblem = (
  seedPhrase: unknown,
  domain: unknown,
  index: unknown
): string => {
  if (!trimmedString(domain)) return 'Enter the SERVICE domain first.'
  const i = Number(index)
  if (!Number.isInteger(i) || i < 0) {
    return 'Index must be a non-negative whole number.'
  }
  if (!deriveOnchainReceive(seedPhrase, domain, index)) {
    return 'Enter a valid BIP39 seed phrase first (12/15/18/21/24 real words).'
  }
  return ''
}

// each helper below recomputes the same (small, pure) derivation and picks
// out one field - avoids needing shared mutable state across helper calls,
// same "recompute rather than cache" pattern bip85's own derivedOutputFor
// uses, and keeps every Text/Button binding trivially guaranteed to agree
const resultFor = (
  seedPhrase: unknown,
  domain: unknown,
  index: unknown
): OnchainReceiveResult | null =>
  deriveOnchainReceive(seedPhrase, domain, index)

const cp1For = (s: unknown, d: unknown, i: unknown): string =>
  resultFor(s, d, i)?.cp1 ?? ''
const pubkeyFor = (s: unknown, d: unknown, i: unknown): string =>
  resultFor(s, d, i)?.internalPubkeyHex ?? ''
const addressFor = (s: unknown, d: unknown, i: unknown): string =>
  resultFor(s, d, i)?.address ?? ''
const wifFor = (s: unknown, d: unknown, i: unknown): string =>
  resultFor(s, d, i)?.wif ?? ''

// this wallet's own trusted-mint registry (Mint page) - read-only here,
// just to pick a real domain without hand-typing one, same as
// seedGenerator's own trustedMintServers/hasTrustedMints
const trustedMintServers = (): string[] => trustedMints().map(m => m.server)
const hasTrustedMints = (): boolean => trustedMints().length > 0

const trustedMintRow: UiNode = {
  type: 'View',
  style: 'row',
  children: [
    {type: 'Text', value: {var: 'item'}},
    {
      type: 'Button',
      label: 'Select',
      onClick: {action: 'set', path: 'domain', value: {var: 'item'}}
    }
  ]
}

const onchainReceiveManifest: AddonManifest = {
  id: 'onchain-receive',
  name: 'Onchain Receiving',
  version: '1',
  icon: 'link',
  experimental: true,
  description:
    'Derives the same LUD-25 Part 2 note keypair (cp1) this wallet already uses for a SERVICE/index, wrapped in the standard BIP341/BIP86 Taproot key-path tweak so it is ALSO a real mainnet bc1p... onchain address - the exact same underlying note, receivable either way.',
  permissions: [],
  nav: {position: 'right', icon: 'link', label: 'Onchain'},
  state: {
    seedPhrase: '',
    domain: '',
    index: 0
  },
  ui: {
    type: 'View',
    children: [
      {type: 'Text', value: 'Onchain Receiving', style: 'heading'},
      {
        type: 'Text',
        value:
          'This is a real cryptographic operation, not a demo - whatever seed phrase you type here is used exactly as entered. Held only on this page (never persisted, never this wallet’s own unlocked seed) and gone the moment you reload or leave. The derived address is spendable with the WIF shown below via any Taproot-capable onchain wallet - treat it with the same care as any other private key.'
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
      {type: 'Text', value: 'SERVICE domain', style: 'subheading'},
      {
        type: 'Show',
        when: {
          helper: 'not',
          args: [{helper: 'hasTrustedMints', args: []}]
        },
        children: [
          {
            type: 'Text',
            value:
              'No trusted mints yet - add one on the Mint page, or type a domain below.'
          }
        ]
      },
      {
        type: 'Show',
        when: {helper: 'hasTrustedMints', args: []},
        children: [
          {
            type: 'For',
            each: {helper: 'trustedMintServers', args: []},
            children: [trustedMintRow]
          }
        ]
      },
      {type: 'Input', bind: 'domain', label: 'Domain (e.g. mint.600.wtf)'},
      {type: 'Input', bind: 'index', kind: 'number', label: 'Index'},
      {
        type: 'Show',
        when: {
          helper: 'onchainProblem',
          args: [{var: 'seedPhrase'}, {var: 'domain'}, {var: 'index'}]
        },
        children: [
          {
            type: 'Text',
            value: {
              helper: 'onchainProblem',
              args: [{var: 'seedPhrase'}, {var: 'domain'}, {var: 'index'}]
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
              helper: 'onchainProblem',
              args: [{var: 'seedPhrase'}, {var: 'domain'}, {var: 'index'}]
            }
          ]
        },
        children: [
          {
            type: 'Text',
            value: 'Onchain address (bc1p...)',
            style: 'subheading'
          },
          {
            type: 'Text',
            value: {
              helper: 'addressFor',
              args: [{var: 'seedPhrase'}, {var: 'domain'}, {var: 'index'}]
            },
            style: 'response-block'
          },
          {
            type: 'Button',
            label: 'Copy address',
            onClick: {
              verb: 'clipboard.copy',
              args: {
                text: {
                  helper: 'addressFor',
                  args: [{var: 'seedPhrase'}, {var: 'domain'}, {var: 'index'}]
                }
              }
            }
          },
          {
            type: 'Text',
            value: 'This note’s cp1 (same key)',
            style: 'subheading'
          },
          {
            type: 'Text',
            value: {
              helper: 'cp1For',
              args: [{var: 'seedPhrase'}, {var: 'domain'}, {var: 'index'}]
            },
            style: 'response-block'
          },
          {
            type: 'Text',
            value: 'Internal pubkey (x-only hex)',
            style: 'subheading'
          },
          {
            type: 'Text',
            value: {
              helper: 'pubkeyFor',
              args: [{var: 'seedPhrase'}, {var: 'domain'}, {var: 'index'}]
            },
            style: 'response-block'
          },
          {
            type: 'Text',
            value: 'Spending WIF (tweaked key path)',
            style: 'subheading'
          },
          {
            type: 'Text',
            value: {
              helper: 'wifFor',
              args: [{var: 'seedPhrase'}, {var: 'domain'}, {var: 'index'}]
            },
            style: 'response-block'
          },
          {
            type: 'Button',
            label: 'Copy WIF',
            onClick: {
              verb: 'clipboard.copy',
              args: {
                text: {
                  helper: 'wifFor',
                  args: [{var: 'seedPhrase'}, {var: 'domain'}, {var: 'index'}]
                }
              }
            }
          }
        ]
      }
    ]
  }
}

const onchainReceiveHelpers: Record<string, AddonHelper> = {
  generateSeedPhrase: generateSeedPhrase as AddonHelper,
  trustedMintServers: trustedMintServers as AddonHelper,
  hasTrustedMints: hasTrustedMints as AddonHelper,
  onchainProblem: onchainProblem as AddonHelper,
  cp1For: cp1For as AddonHelper,
  pubkeyFor: pubkeyFor as AddonHelper,
  addressFor: addressFor as AddonHelper,
  wifFor: wifFor as AddonHelper
}

export const onchainReceiveAddon: Addon = {
  manifest: onchainReceiveManifest,
  helpers: onchainReceiveHelpers
}
