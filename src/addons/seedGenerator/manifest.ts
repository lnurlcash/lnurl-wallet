import {HARDENED_OFFSET, type HDKey} from '@scure/bip32'
import type {Addon, AddonHelper, AddonManifest, UiNode} from '../types'
import {
  generateSeedPhrase,
  isValidSeedPhrase,
  deriveLud25CashRootNode,
  lud05PathSuffix
} from '../../keys'
import {deriveNotePubkey, encodeCp1, encodeCx1} from '../../lnurlcash'
import {trustedMints} from '../../trustedMints'

// A throwaway-seed sandbox for exploring LUD-25 Part 2's own derivation
// (see cashSecrets.ts's cashAddressBranch/cashAddressSecretAtIndex) without
// touching this wallet's real seed at all - "Generate new seed" makes a
// fresh BIP39 mnemonic entirely in the browser, held only in this addon's
// own page-local state (see AddonRun.tsx/Renderer.tsx's 'run' mode - never
// persisted, gone the moment this page is left or reloaded), and every
// derivation below is a pure function of (that ephemeral seed, a mint
// domain) - never cashSecrets.ts's own module-level wallet state.
// Reimplements the same small amount of path-walking cashSecrets.ts's
// addressDomainNode does (rather than importing it) specifically so this
// can never be confused with, or accidentally reach, the real unlocked
// cash root. Public-only output: derives pubkeys straight off the
// branch's own public key + chain code (deriveNotePubkey, the same
// watch-only math a mint uses against a cx1 export) rather than via each
// index's private key, so there is no private scalar to accidentally show.
const KEYPAIR_COUNT = 10

const trimmedString = (value: unknown): string => String(value ?? '').trim()

// mirrors cashSecrets.ts's own addressDomainNode (m/139'/1'/d1/d2/d3/d4) -
// see this file's own header comment for why it's reimplemented here
// rather than imported
const addressDomainNode = (cashRoot: HDKey, domain: string): HDKey | null => {
  const addressRoot = cashRoot.deriveChild(1 + HARDENED_OFFSET) // m/139'/1'
  const hashingNode = addressRoot.deriveChild(0)
  if (!hashingNode.privateKey) return null
  const suffix = lud05PathSuffix(hashingNode.privateKey, domain)
  let node = addressRoot
  for (const index of suffix) node = node.deriveChild(index)
  return node
}

const branchFor = (
  seedPhrase: unknown,
  domain: unknown
): {pubkeyXOnly: Uint8Array; chainCode: Uint8Array} | null => {
  const seed = trimmedString(seedPhrase)
  const d = trimmedString(domain)
  if (!seed || !d || !isValidSeedPhrase(seed)) return null
  const node = addressDomainNode(deriveLud25CashRootNode(seed), d)
  if (!node?.publicKey || !node.chainCode) return null
  return {pubkeyXOnly: node.publicKey.slice(1), chainCode: node.chainCode}
}

const xpubDisplay = (seedPhrase: unknown, domain: unknown): string => {
  const branch = branchFor(seedPhrase, domain)
  return branch ? encodeCx1(branch.pubkeyXOnly, branch.chainCode) : '-'
}

export type SeedPubkeyRow = {index: number; pubkey: string}

const keypairsForSeed = (
  seedPhrase: unknown,
  domain: unknown
): SeedPubkeyRow[] => {
  const branch = branchFor(seedPhrase, domain)
  if (!branch) return []
  const rows: SeedPubkeyRow[] = []
  for (let i = 0; i < KEYPAIR_COUNT; i++) {
    const pubkey = deriveNotePubkey(branch.pubkeyXOnly, branch.chainCode, i)
    rows.push({index: i, pubkey: encodeCp1(pubkey)})
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
    "Generates a fresh, ephemeral seed phrase (never connected to this wallet's own seed) and derives the first 10 LUD-25 Part 2 pubkeys (cp1) plus the watch-only branch export (cx1) for one of your trusted mints - for exploring the derivation, not for holding real funds.",
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
