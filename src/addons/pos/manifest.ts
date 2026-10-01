import type {Addon, AddonHelper, AddonManifest} from '../types'
import {
  KEYPAD_KEYS,
  pressKey,
  amountSats,
  formatAmount,
  hasInvoice,
  canCharge,
  isPaid,
  keepPolling,
  awaitingPayment,
  invoiceUri,
  invoiceAmount,
  statusText,
  claimText
} from './keypad'

// A till: type an amount on the keypad, and one of this wallet's own
// registered Lightning Addresses (addressRegistry.ts) issues the invoice -
// the same request any payer's wallet makes, so the customer can pay with
// any Lightning wallet. The payment mints a note on that address's own
// watch-only branch; lnaddress.checkPayment polls the mint's LUD-21 verify
// and, once settled, runs the same "check notes" pass the Mint page does,
// so the note lands in this wallet without leaving the till.
const posManifest: AddonManifest = {
  id: 'pos',
  name: 'Point of Sale',
  version: '1',
  icon: 'calculator',
  description:
    'A keypad till: charge any amount as a Lightning invoice to one of your registered Lightning Addresses, and collect the payment into this wallet once it settles.',
  permissions: [
    {
      verb: 'lnaddress.invoice',
      reason:
        "Asks the mint behind the Lightning Address you pick for an invoice of the amount you typed - the same request any payer's wallet makes."
    },
    {
      verb: 'lnaddress.checkPayment',
      reason:
        "Polls the mint for whether that invoice was paid, then adds the resulting note to your wallet by checking that address's notes."
    },
    {
      verb: 'clipboard.copy',
      reason: 'Copies the invoice, for a customer who would rather paste it.'
    }
  ],
  nav: {position: 'left', icon: 'calculator', label: 'PoS'},
  state: {
    address: null,
    amount: '0',
    invoice: null,
    status: null
  },
  settings: {
    state: {address: null},
    ui: {
      type: 'View',
      children: [
        {
          type: 'AddressPicker',
          bind: 'address',
          label: 'Default Lightning Address'
        }
      ]
    }
  },
  ui: {
    type: 'View',
    children: [
      {type: 'Text', value: 'Point of Sale', style: 'heading'},

      {
        type: 'Show',
        when: {
          helper: 'not',
          args: [{helper: 'hasInvoice', args: [{var: 'invoice'}]}]
        },
        children: [
          {
            type: 'AddressPicker',
            bind: 'address',
            label: 'Receive to'
          },
          {
            type: 'Text',
            value: {helper: 'formatAmount', args: [{var: 'amount'}]},
            style: 'pos-amount'
          },
          {
            type: 'View',
            style: 'keypad',
            children: [
              {
                type: 'For',
                each: [...KEYPAD_KEYS],
                children: [
                  {
                    type: 'Button',
                    label: {var: 'item'},
                    onClick: {
                      action: 'set',
                      path: 'amount',
                      value: {
                        helper: 'pressKey',
                        args: [{var: 'amount'}, {var: 'item'}]
                      }
                    }
                  }
                ]
              }
            ]
          },
          {
            type: 'Show',
            when: {
              helper: 'canCharge',
              args: [{var: 'address'}, {var: 'amount'}]
            },
            children: [
              {
                type: 'Button',
                label: {
                  cat: [
                    'Charge ',
                    {helper: 'formatAmount', args: [{var: 'amount'}]}
                  ]
                },
                onClick: {
                  verb: 'lnaddress.invoice',
                  args: {
                    address: {var: 'address.address'},
                    amountSat: {helper: 'amountSats', args: [{var: 'amount'}]}
                  },
                  result: 'invoice'
                }
              }
            ]
          }
        ]
      },

      {
        type: 'Show',
        when: {
          helper: 'awaitingPayment',
          args: [{var: 'invoice'}, {var: 'status'}]
        },
        children: [
          {
            type: 'Text',
            value: {helper: 'invoiceAmount', args: [{var: 'invoice'}]},
            style: 'pos-amount'
          },
          {
            type: 'QrDisplay',
            value: {helper: 'invoiceUri', args: [{var: 'invoice'}]}
          },
          {
            type: 'Text',
            value: {
              helper: 'statusText',
              args: [{var: 'invoice'}, {var: 'status'}]
            }
          },
          {
            type: 'View',
            style: 'row',
            children: [
              {
                type: 'Button',
                label: 'Copy invoice',
                onClick: {
                  verb: 'clipboard.copy',
                  args: {text: {var: 'invoice.pr'}}
                }
              },
              {
                type: 'Button',
                label: 'Cancel',
                onClick: {action: 'set', path: 'invoice', value: null}
              }
            ]
          }
        ]
      },

      {
        type: 'Show',
        when: {helper: 'isPaid', args: [{var: 'invoice'}, {var: 'status'}]},
        children: [
          {
            type: 'Text',
            value: {
              cat: [
                'Paid: ',
                {helper: 'invoiceAmount', args: [{var: 'invoice'}]}
              ]
            },
            style: 'pos-paid'
          },
          {
            type: 'Text',
            value: {
              helper: 'claimText',
              args: [{var: 'invoice'}, {var: 'status'}]
            }
          },
          {
            type: 'Button',
            label: 'New sale',
            onClick: {action: 'set', path: 'invoice', value: null}
          }
        ]
      },

      {
        type: 'Poll',
        every: 3,
        when: {
          helper: 'keepPolling',
          args: [{var: 'invoice'}, {var: 'status'}]
        },
        onTick: {
          verb: 'lnaddress.checkPayment',
          args: {invoice: {var: 'invoice'}},
          result: 'status'
        }
      }
    ]
  }
}

const posHelpers: Record<string, AddonHelper> = {
  pressKey: pressKey as AddonHelper,
  amountSats: amountSats as AddonHelper,
  formatAmount: formatAmount as AddonHelper,
  hasInvoice: hasInvoice as AddonHelper,
  canCharge: canCharge as AddonHelper,
  isPaid: isPaid as AddonHelper,
  keepPolling: keepPolling as AddonHelper,
  awaitingPayment: awaitingPayment as AddonHelper,
  invoiceUri: invoiceUri as AddonHelper,
  invoiceAmount: invoiceAmount as AddonHelper,
  statusText: statusText as AddonHelper,
  claimText: claimText as AddonHelper
}

export const posAddon: Addon = {manifest: posManifest, helpers: posHelpers}
