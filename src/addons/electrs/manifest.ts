import type {Addon, AddonHelper, AddonManifest, UiNode} from '../types'

// A thin UI around electrsClient.ts's own read-only calls - see that
// file's header comment for the actual REST contract and SSRF posture.
// No key material anywhere in this addon at all: it only ever asks a
// holder-chosen server about a plain address string, useful for checking
// the balance/UTXOs of an address this wallet derived elsewhere (e.g. the
// sibling onchain-receive addon), or any address pasted in.

const trimmedString = (value: unknown): string => String(value ?? '').trim()

const electrsProblem = (baseUrl: unknown, address: unknown): string => {
  if (!trimmedString(baseUrl)) {
    return "Enter the electrs/esplora server's URL first."
  }
  if (!trimmedString(address)) return 'Enter an onchain address first.'
  return ''
}

const hasSummary = (summary: unknown): boolean =>
  summary !== null && typeof summary === 'object'

const utxoRow: UiNode = {
  type: 'View',
  style: 'row',
  children: [
    {
      type: 'Text',
      value: {
        cat: [
          {var: 'item.valueSat'},
          ' sat - ',
          {var: 'item.confirmed'},
          ' - ',
          {var: 'item.txid'},
          ':',
          {var: 'item.vout'}
        ]
      }
    }
  ]
}

const electrsManifest: AddonManifest = {
  id: 'electrs',
  name: 'Electrs',
  version: '1',
  icon: 'server',
  experimental: true,
  description:
    'Checks the balance and UTXOs of a plain onchain address against any electrs/esplora-compatible REST server you point it at - your own self-hosted electrs, or a public one like mempool.space/api.',
  permissions: [
    {
      verb: 'electrs.address',
      reason:
        "Fetch that address's confirmed/unconfirmed balance and transaction count"
    },
    {
      verb: 'electrs.utxos',
      reason: "List that address's spendable outputs"
    }
  ],
  nav: {position: 'right', icon: 'server', label: 'Electrs'},
  state: {
    baseUrl: '',
    address: '',
    summary: null,
    utxos: []
  },
  ui: {
    type: 'View',
    children: [
      {type: 'Text', value: 'Electrs', style: 'heading'},
      {
        type: 'Text',
        value:
          "Read-only: asks the server below about one address's public chain data. Never sends a private key or signs anything - point this at your own electrs/esplora instance, or a public one, as you prefer."
      },
      {
        type: 'Input',
        bind: 'baseUrl',
        label: 'Server URL (e.g. https://mempool.space/api)'
      },
      {type: 'Input', bind: 'address', label: 'Onchain address'},
      {
        type: 'Show',
        when: {
          helper: 'electrsProblem',
          args: [{var: 'baseUrl'}, {var: 'address'}]
        },
        children: [
          {
            type: 'Text',
            value: {
              helper: 'electrsProblem',
              args: [{var: 'baseUrl'}, {var: 'address'}]
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
              helper: 'electrsProblem',
              args: [{var: 'baseUrl'}, {var: 'address'}]
            }
          ]
        },
        children: [
          {
            type: 'View',
            style: 'row',
            children: [
              {
                type: 'Button',
                label: 'Check balance',
                onClick: {
                  verb: 'electrs.address',
                  args: {baseUrl: {var: 'baseUrl'}, address: {var: 'address'}},
                  result: 'summary'
                }
              },
              {
                type: 'Button',
                label: 'List UTXOs',
                onClick: {
                  verb: 'electrs.utxos',
                  args: {baseUrl: {var: 'baseUrl'}, address: {var: 'address'}},
                  result: 'utxos'
                }
              }
            ]
          }
        ]
      },
      {
        type: 'Show',
        when: {helper: 'hasSummary', args: [{var: 'summary'}]},
        children: [
          {type: 'Text', value: 'Balance', style: 'subheading'},
          {
            type: 'Text',
            value: {
              cat: [
                'Confirmed: ',
                {var: 'summary.confirmedBalanceSat'},
                ' sat (',
                {var: 'summary.confirmed.txCount'},
                ' onchain tx)'
              ]
            },
            style: 'response-block'
          },
          {
            type: 'Show',
            when: {gt: [{var: 'summary.mempool.txCount'}, 0]},
            children: [
              {
                type: 'Text',
                value: {
                  cat: [
                    'Unconfirmed: ',
                    {var: 'summary.mempool.fundedTxoSum'},
                    ' sat in, ',
                    {var: 'summary.mempool.spentTxoSum'},
                    ' sat out (',
                    {var: 'summary.mempool.txCount'},
                    ' pending tx)'
                  ]
                }
              }
            ]
          }
        ]
      },
      {
        type: 'Show',
        when: {gt: [{helper: 'arrayLength', args: [{var: 'utxos'}]}, 0]},
        children: [
          {type: 'Text', value: 'UTXOs', style: 'subheading'},
          {type: 'For', each: {var: 'utxos'}, children: [utxoRow]}
        ]
      }
    ]
  }
}

const electrsHelpers: Record<string, AddonHelper> = {
  electrsProblem: electrsProblem as AddonHelper,
  hasSummary: hasSummary as AddonHelper,
  arrayLength: ((value: unknown) =>
    Array.isArray(value) ? value.length : 0) as AddonHelper
}

export const electrsAddon: Addon = {
  manifest: electrsManifest,
  helpers: electrsHelpers
}
