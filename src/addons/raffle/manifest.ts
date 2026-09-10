import type {Addon, AddonHelper, AddonManifest, UiNode} from '../types'
import {tierPreset, newTier, ticketCount, totalAmountSat, planTickets} from './lottery'
import {buildTicketPdf} from './pdf'

const tierRow: UiNode = {
  type: 'View',
  style: 'row',
  children: [
    {type: 'Input', bind: 'item.count', kind: 'number', label: 'Tickets'},
    {type: 'Input', bind: 'item.amountSat', kind: 'number', label: 'Sats each'},
    {type: 'Input', bind: 'item.label', label: 'Prize name (optional)'},
    {
      type: 'Button',
      label: 'Remove',
      onClick: {action: 'removeAt', path: 'tiers', index: {var: 'index'}}
    }
  ]
}

const presetButton = (id: string, label: string): UiNode => ({
  type: 'Button',
  label,
  onClick: {
    action: 'set',
    path: 'tiers',
    value: {helper: 'tierPreset', args: [id]}
  }
})

const ui: UiNode = {
  type: 'View',
  children: [
    {type: 'Text', value: 'Raffle Tickets', style: 'heading'},
    {type: 'Input', bind: 'title', label: 'Title'},
    {
      type: 'NotePicker',
      bind: 'sourceNote',
      filter: {spent: false},
      label: 'Note to fund the prize pool'
    },
    {type: 'Text', value: 'Start from a preset', style: 'subheading'},
    {
      type: 'View',
      style: 'row',
      children: [
        presetButton('single-winner', 'Single winner'),
        presetButton('classic-raffle', 'Classic raffle'),
        presetButton('pyramid', 'Prize pyramid'),
        presetButton('even-split', 'Even split')
      ]
    },
    {type: 'Text', value: 'Prize tiers', style: 'subheading'},
    {type: 'For', each: {var: 'tiers'}, children: [tierRow]},
    {
      type: 'Button',
      label: 'Add tier',
      onClick: {action: 'push', path: 'tiers', value: {helper: 'newTier', args: []}}
    },
    {
      type: 'Text',
      value: {
        cat: [
          {helper: 'ticketCount', args: [{var: 'tiers'}]},
          ' tickets · ',
          {helper: 'totalAmountSat', args: [{var: 'tiers'}]},
          ' sat total'
        ]
      }
    },
    {
      type: 'Input',
      bind: 'showAmount',
      kind: 'checkbox',
      label: 'Print the sat amount on each ticket'
    },
    {
      type: 'Show',
      when: {
        and: [
          {var: 'sourceNote'},
          {gt: [{helper: 'ticketCount', args: [{var: 'tiers'}]}, 0]},
          {
            lte: [
              {helper: 'totalAmountSat', args: [{var: 'tiers'}]},
              {var: 'sourceNote.amountSat'}
            ]
          }
        ]
      },
      children: [
        {
          type: 'Button',
          label: 'Run raffle',
          onClick: {
            verb: 'note.split',
            args: {
              note: {var: 'sourceNote.id'},
              tickets: {helper: 'planTickets', args: [{var: 'tiers'}, {var: 'runId'}]}
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
        {type: 'Text', value: 'Tickets', style: 'subheading'},
        {
          type: 'For',
          each: {var: 'results'},
          children: [
            {
              type: 'View',
              style: 'ticket',
              children: [
                {type: 'QrDisplay', value: {var: 'item.url'}},
                {
                  type: 'Show',
                  when: {var: 'showAmount'},
                  children: [{type: 'Text', value: {var: 'item.amountSat'}}]
                },
                {
                  type: 'Show',
                  when: {var: 'item.label'},
                  children: [{type: 'Text', value: {var: 'item.label'}}]
                }
              ]
            }
          ]
        },
        {
          type: 'Button',
          label: 'Download printable PDF',
          onClick: {
            verb: 'file.download',
            args: {
              filename: {cat: [{var: 'title'}, '.pdf']},
              content: {
                helper: 'buildTicketPdf',
                args: [{var: 'title'}, {var: 'results'}, {var: 'showAmount'}, {var: 'paper'}]
              }
            }
          }
        }
      ]
    }
  ]
}

const settingsUi: UiNode = {
  type: 'View',
  children: [
    {type: 'Text', value: 'Raffle', style: 'subheading'},
    {
      type: 'View',
      style: 'row',
      children: [
        {
          type: 'Button',
          label: 'A4',
          onClick: {action: 'set', path: 'paper', value: 'a4'}
        },
        {
          type: 'Button',
          label: 'Letter',
          onClick: {action: 'set', path: 'paper', value: 'letter'}
        }
      ]
    },
    {
      type: 'Input',
      bind: 'showAmount',
      kind: 'checkbox',
      label: 'Print the sat amount on each ticket by default'
    }
  ]
}

export const raffleManifest: AddonManifest = {
  id: 'raffle',
  name: 'Raffle Tickets',
  version: '1',
  icon: 'pricetags',
  description: 'Split a held note into prize-tiered raffle tickets and print them.',
  permissions: [
    {
      verb: 'note.query',
      scope: 'spent:false',
      reason: "Let you pick which held note funds the prize pool"
    },
    {
      verb: 'note.split',
      reason: "Split the chosen note into one ticket per prize, tagged as it's created"
    },
    {verb: 'file.download', reason: 'Save the printable ticket PDF'}
  ],
  nav: {position: 'right', icon: 'pricetags', label: 'Raffle'},
  state: {
    runId: '',
    title: 'Lottery',
    sourceNote: null,
    tiers: [{id: 't1', count: 1, amountSat: 100000, label: 'Grand prize'}],
    showAmount: true,
    paper: 'a4',
    results: []
  },
  ui,
  settings: {
    state: {paper: 'a4', showAmount: true},
    ui: settingsUi
  }
}

export const raffleHelpers: Record<string, AddonHelper> = {
  tierPreset: tierPreset as AddonHelper,
  newTier: newTier as AddonHelper,
  ticketCount: ticketCount as AddonHelper,
  totalAmountSat: totalAmountSat as AddonHelper,
  planTickets: planTickets as AddonHelper,
  buildTicketPdf: buildTicketPdf as AddonHelper
}

export const raffleAddon: Addon = {
  manifest: raffleManifest,
  helpers: raffleHelpers
}
