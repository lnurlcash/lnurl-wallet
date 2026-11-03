import type {HDKey} from '@scure/bip32'
import type {Addon, AddonHelper, AddonManifest, UiNode} from '../types'
import {
  generateSeedPhrase,
  isValidSeedPhrase,
  deriveLud25CashRootNode
} from '../../keys'
import {
  deriveServiceRoot,
  deriveNoteKey,
  deriveShareNode,
  shareCx1,
  encodeCp1,
  encodeCx1
} from '../../lnurlcash'
import {trustedMints} from '../../trustedMints'

// A throwaway-seed sandbox for exploring LUD-26's derivation (see
// cashSecrets.ts) without touching this wallet's real seed at all -
// "Generate new seed" makes a fresh BIP39 mnemonic entirely in the browser,
// held only in this addon's own page-local state (see
// AddonRun.tsx/Renderer.tsx's 'run' mode - never persisted, gone the moment
// this page is left or reloaded), and every derivation below is a pure
// function of (that ephemeral seed, a mint domain) - never cashSecrets.ts's
// own module-level wallet state, so this can never reach the real unlocked
// cash root. Shows the first share's cx1 (what a Lightning Address
// registers) and the wallet notes S/0'/0/i (what a wallet mints, rotates
// and merges for itself) as public keys only - not the change chain or the
// share's notes, which this wallet's own recovery scans (recovery.ts,
// addressRecovery.ts) additionally walk.
const KEYPAIR_COUNT = 10

const trimmedString = (value: unknown): string => String(value ?? '').trim()

// S for this seed and domain, or null while either is not yet valid
const serviceRootFor = (seedPhrase: unknown, domain: unknown): HDKey | null => {
  const seed = trimmedString(seedPhrase)
  const d = trimmedString(domain)
  if (!seed || !d || !isValidSeedPhrase(seed)) return null
  try {
    return deriveServiceRoot(deriveLud25CashRootNode(seed), d)
  } catch {
    return null
  }
}

const xpubDisplay = (seedPhrase: unknown, domain: unknown): string => {
  const root = serviceRootFor(seedPhrase, domain)
  return root ? encodeCx1(shareCx1(deriveShareNode(root, 0, 0))) : '-'
}

export type SeedPubkeyRow = {index: number; pubkey: string}

const keypairsForSeed = (
  seedPhrase: unknown,
  domain: unknown
): SeedPubkeyRow[] => {
  const root = serviceRootFor(seedPhrase, domain)
  if (!root) return []
  const rows: SeedPubkeyRow[] = []
  for (let i = 0; i < KEYPAIR_COUNT; i++) {
    const {outputKey} = deriveNoteKey(root, {
      chain: 'wallet',
      account: 0,
      index: i
    })
    rows.push({index: i, pubkey: encodeCp1(outputKey)})
  }
  return rows
}

// this wallet's own trusted-mint registry (Mint page) - read-only here,
// just to pick a real domain to derive against without hand-typing one.
// Reactive: evaluated inside Solid's own tracking (same as the currency
// addon's rates()), so the selector updates live if a mint is trusted or
// removed while this page is open.
const trustedMintServers = (): string[] => trustedMints().map(m => m.server)

const hasTrustedMints = (): boolean => trustedMints().length > 0

// one row per trusted mint, rendered by For below - a Button's own label
// is always a fixed string (see types.ts's UiNode), never per-item Expr,
// so the mint's name is shown via a sibling Text bound to {var: 'item'}
// instead, with a same-labeled "Select" button next to it whose onClick
// value IS an Expr and so correctly picks up the right server per row
const trustedMintRow: UiNode = {
  type: 'View',
  style: 'row',
  children: [
    {type: 'Text', value: {var: 'item'}},
    {
      type: 'Button',
      label: 'Select',
      onClick: {action: 'set', path: 'mintDomain', value: {var: 'item'}}
    }
  ]
}

const seedGeneratorManifest: AddonManifest = {
  id: 'seed-generator',
  name: 'Seed Generator',
  version: '1',
  icon: 'key',
  description:
    "Generates a fresh, ephemeral seed phrase (never connected to this wallet's own seed) and derives the first 10 LUD-25 note pubkeys (cp1) plus the watch-only branch export (cx1) for one of your trusted mints - for exploring the derivation, not for holding real funds.",
  permissions: [],
  nav: {position: 'right', icon: 'key', label: 'Seeds'},
  state: {
    seedPhrase: '',
    mintDomain: ''
  },
  ui: {
    type: 'View',
    children: [
      {type: 'Text', value: 'Seed Generator', style: 'heading'},
      {
        type: 'Text',
        value:
          "Ephemeral - generated fresh in your browser, held only on this page, and never connected to this wallet's real seed. Reloading or leaving this page discards it. Public keys only - never send real funds to keys shown here."
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
      {
        type: 'Show',
        when: {gt: [{helper: 'stringLength', args: [{var: 'seedPhrase'}]}, 0]},
        children: [
          {
            type: 'Text',
            value: {var: 'seedPhrase'},
            style: 'seed-block'
          },
          {
            type: 'Button',
            label: 'Copy seed',
            onClick: {
              verb: 'clipboard.copy',
              args: {text: {var: 'seedPhrase'}}
            }
          },
          {type: 'Text', value: 'Trusted mint', style: 'subheading'},
          {
            type: 'Show',
            when: {
              helper: 'not',
              args: [{helper: 'hasTrustedMints', args: []}]
            },
            children: [
              {
                type: 'Text',
                value: 'No trusted mints yet - add one on the Mint page first.'
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
          {
            type: 'Show',
            when: {
              gt: [{helper: 'stringLength', args: [{var: 'mintDomain'}]}, 0]
            },
            children: [
              {
                type: 'Text',
                value: {cat: ['Selected mint: ', {var: 'mintDomain'}]}
              },
              {
                type: 'Text',
                value: {
                  cat: [
                    'xpub (watch-only branch export, cx1): ',
                    {
                      helper: 'xpubDisplay',
                      args: [{var: 'seedPhrase'}, {var: 'mintDomain'}]
                    }
                  ]
                }
              },
              {
                type: 'Button',
                label: 'Copy xpub',
                onClick: {
                  verb: 'clipboard.copy',
                  args: {
                    text: {
                      helper: 'xpubDisplay',
                      args: [{var: 'seedPhrase'}, {var: 'mintDomain'}]
                    }
                  }
                }
              },
              {
                type: 'Text',
                value: 'First 10 pubkeys (cp1)',
                style: 'subheading'
              },
              {
                type: 'For',
                each: {
                  helper: 'keypairsForSeed',
                  args: [{var: 'seedPhrase'}, {var: 'mintDomain'}]
                },
                children: [
                  {
                    type: 'Text',
                    value: {
                      cat: [
                        '#',
                        {var: 'item.index'},
                        ': ',
                        {var: 'item.pubkey'}
                      ]
                    }
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  }
}

const seedGeneratorHelpers: Record<string, AddonHelper> = {
  generateSeedPhrase: generateSeedPhrase as AddonHelper,
  xpubDisplay: xpubDisplay as AddonHelper,
  keypairsForSeed: keypairsForSeed as AddonHelper,
  trustedMintServers: trustedMintServers as AddonHelper,
  hasTrustedMints: hasTrustedMints as AddonHelper,
  stringLength: ((value: unknown) =>
    String(value ?? '').trim().length) as AddonHelper
}

export const seedGeneratorAddon: Addon = {
  manifest: seedGeneratorManifest,
  helpers: seedGeneratorHelpers
}
