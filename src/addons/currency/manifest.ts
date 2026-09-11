import type {Addon, AddonHelper, AddonManifest, UiNode} from '../types'
import {rates} from '../../currency'

// quick-fill denominations for the fiat amount field - round, common price
// points rather than round sat counts (100-1000 sats is trivial; $10-$1000
// is the actual range someone converting a price would reach for)
const QUICK_FIAT_AMOUNTS = [10, 50, 100, 200, 500, 1000]

// A calculator, not a wallet action - reuses the wallet's own already-
// running price feed (currency.ts, Settings > Currency) rather than
// fetching anything itself: rates() already holds usd/eur/gbp together
// once ANY currency is selected there, regardless of which one is picked
// for the global fiat-estimate display, so this addon's own currency
// picker (below) is independent of that display preference - it only
// needs polling to be active at all. No verb/permission is needed at all:
// this never touches a note, a secret, or a network request of its own.
type FiatCode = 'usd' | 'eur' | 'gbp'

const SYMBOL: Record<FiatCode, string> = {usd: '$', eur: '€', gbp: '£'}

const isFiatCode = (code: unknown): code is FiatCode =>
  code === 'usd' || code === 'eur' || code === 'gbp'

const ratesAvailable = (): boolean => rates() !== null

const satsToFiatAmount = (sats: unknown, code: unknown): number | null => {
  const r = rates()
  if (!r || !isFiatCode(code)) return null
  const n = Number(sats)
  return Number.isFinite(n) ? (n / 100_000_000) * r[code] : null
}

const fiatToSatsAmount = (amount: unknown, code: unknown): number | null => {
  const r = rates()
  if (!r || !isFiatCode(code)) return null
  const n = Number(amount)
  return Number.isFinite(n) ? Math.round((n / r[code]) * 100_000_000) : null
}

const formatFiatAmount = (amount: unknown, code: unknown): string => {
  if (
    typeof amount !== 'number' ||
    !Number.isFinite(amount) ||
    !isFiatCode(code)
  ) {
    return '-'
  }
  return `${SYMBOL[code]}${amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`
}

const formatSats = (sats: unknown): string => {
  const n = Number(sats)
  return Number.isFinite(n) ? `${Math.round(n).toLocaleString()} sats` : '-'
}

// the raw feed price (1 BTC in the selected currency), same rates() value
// satsToFiatAmount/fiatToSatsAmount both already divide/multiply through -
// shown as-is so a holder can sanity-check the rate this calculator is
// actually using right now, not just its outputs
const currentRateDisplay = (code: unknown): string => {
  const r = rates()
  if (!r || !isFiatCode(code)) return '-'
  return `1 BTC = ${SYMBOL[code]}${r[code].toLocaleString(undefined, {
    maximumFractionDigits: 2
  })}`
}

const currencyManifest: AddonManifest = {
  id: 'currency-converter',
  name: 'Currency Converter',
  version: '1',
  icon: 'swap',
  description:
    'Convert between sats and USD/EUR/GBP using price.lnurlcash.com - the same feed as Settings > Currency.',
  permissions: [],
  nav: {position: 'right', icon: 'swap', label: 'Convert'},
  state: {
    currency: 'usd',
    sats: 100000,
    fiatAmount: 10
  },
  ui: {
    type: 'View',
    children: [
      {type: 'Text', value: 'Currency Converter', style: 'heading'},
      {
        type: 'Show',
        when: {helper: 'not', args: [{helper: 'ratesAvailable', args: []}]},
        children: [
          {
            type: 'Text',
            value:
              'No live rate yet - pick a currency under Settings > Currency first (this addon reuses that same feed).'
          }
        ]
      },
      {
        type: 'Show',
        when: {helper: 'ratesAvailable', args: []},
        children: [
          {type: 'Text', value: 'Convert to', style: 'subheading'},
          {
            type: 'View',
            style: 'row',
            children: [
              {
                type: 'Button',
                label: 'USD',
                onClick: {action: 'set', path: 'currency', value: 'usd'}
              },
              {
                type: 'Button',
                label: 'EUR',
                onClick: {action: 'set', path: 'currency', value: 'eur'}
              },
              {
                type: 'Button',
                label: 'GBP',
                onClick: {action: 'set', path: 'currency', value: 'gbp'}
              }
            ]
          },
          {
            type: 'Text',
            value: {helper: 'currentRateDisplay', args: [{var: 'currency'}]}
          },
          {
            type: 'Input',
            bind: 'sats',
            kind: 'number',
            label: 'Sats'
          },
          {
            type: 'Text',
            value: {
              helper: 'formatFiatAmount',
              args: [
                {
                  helper: 'satsToFiatAmount',
                  args: [{var: 'sats'}, {var: 'currency'}]
                },
                {var: 'currency'}
              ]
            },
            style: 'subheading'
          },
          {
            type: 'Input',
            bind: 'fiatAmount',
            kind: 'number',
            label: 'Amount (in the currency picked above)'
          },
          {
            type: 'View',
            style: 'row',
            children: QUICK_FIAT_AMOUNTS.map(amount => ({
              type: 'Button',
              label: String(amount),
              onClick: {action: 'set', path: 'fiatAmount', value: amount}
            }))
          },
          {
            type: 'Text',
            value: {
              helper: 'formatSats',
              args: [
                {
                  helper: 'fiatToSatsAmount',
                  args: [{var: 'fiatAmount'}, {var: 'currency'}]
                }
              ]
            },
            style: 'subheading'
          },
          {
            type: 'Button',
            label: 'Copy sats (unformatted)',
            onClick: {
              verb: 'clipboard.copy',
              args: {
                text: {
                  cat: [
                    {
                      helper: 'fiatToSatsAmount',
                      args: [{var: 'fiatAmount'}, {var: 'currency'}]
                    }
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

const currencyHelpers: Record<string, AddonHelper> = {
  ratesAvailable: ratesAvailable as AddonHelper,
  satsToFiatAmount: satsToFiatAmount as AddonHelper,
  fiatToSatsAmount: fiatToSatsAmount as AddonHelper,
  formatFiatAmount: formatFiatAmount as AddonHelper,
  formatSats: formatSats as AddonHelper,
  currentRateDisplay: currentRateDisplay as AddonHelper
}

export const currencyAddon: Addon = {
  manifest: currencyManifest,
  helpers: currencyHelpers
}
