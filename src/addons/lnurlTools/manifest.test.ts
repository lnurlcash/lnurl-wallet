import {describe, expect, it} from 'vitest'

import {lnurlToolsAddon} from './manifest'
import type {AddonHelper} from '../types'

const {helpers} = lnurlToolsAddon

// see globalHelpers.test.ts's own `call` - AddonHelper is deliberately
// typed uncallable-by-normal-code ((...args: never[])), only evaluate()
// in expr.ts is meant to invoke it, via this same cast
const call = (fn: AddonHelper, ...args: unknown[]): unknown =>
  fn(...(args as never[]))

// a real LUD-06 payRequest response, including this wallet's own text/xpub
// extension (see internalTransfer.ts), Nostr zap support (NIP-57), and two
// text/plain metadata entries (LUD-06 doesn't forbid repeating a type)
const PAY_REQUEST = {
  url: 'https://mint.lnurlcash.com/.well-known/lnurlp/dni2',
  body: {
    tag: 'payRequest',
    callback: 'https://mint.lnurlcash.com/p/dni2',
    minSendable: 14000,
    maxSendable: 200000000,
    metadata:
      '[["text/plain", "Mint an lnurlcash bearer note on mint.lnurlcash.com"], ["text/identifier", "dni2@mint.lnurlcash.com"], ["text/xpub", "cx15qwmqamrkyd0tkr8aawvkgdhpl0cw44sc5uealh9lpddqvtj22fy50dxfr082vy9h3wwq0f22gefdaprkuq9ap9qekfcn454dwg5nwc5rf47n:6"], ["text/plain", "Mint fees: 3000,2000"]]',
    withdrawLink: 'https://mint.lnurlcash.com/w',
    commentAllowed: 64,
    allowsNostr: true,
    nostrPubkey:
      '81559e260ef446c3adb3824f3f15f895979c28d9c1448d284348f7df4bc8fd93'
  }
}

describe('lnurlTools: a real payRequest with LUD-06 metadata + Nostr zaps', () => {
  it('formats every top-level field, including allowsNostr/nostrPubkey', () => {
    const summary = call(helpers.formatLnurlResponse!, PAY_REQUEST)
    expect(summary).toBe(
      [
        'Tag: payRequest',
        'Callback: https://mint.lnurlcash.com/p/dni2',
        'Sendable: 14 - 200,000 sats',
        'Withdraw link (LUD-25): https://mint.lnurlcash.com/w',
        'Comment allowed: 64 characters',
        'Nostr zaps (NIP-57): allowed (pubkey 81559e260ef446c3adb3824f3f15f895979c28d9c1448d284348f7df4bc8fd93)'
      ].join('\n')
    )
  })

  it('flattens metadata into a labelled, numbered-when-duplicate list', () => {
    expect(call(helpers.metadataEntries!, PAY_REQUEST)).toEqual([
      {
        label: 'Description 1',
        value: 'Mint an lnurlcash bearer note on mint.lnurlcash.com'
      },
      {label: 'Identifier', value: 'dni2@mint.lnurlcash.com'},
      {
        label: 'Internal transfer xpub (LUD-25)',
        value:
          'cx15qwmqamrkyd0tkr8aawvkgdhpl0cw44sc5uealh9lpddqvtj22fy50dxfr082vy9h3wwq0f22gefdaprkuq9ap9qekfcn454dwg5nwc5rf47n:6'
      },
      {label: 'Description 2', value: 'Mint fees: 3000,2000'}
    ])
    expect(call(helpers.hasMetadataEntries!, PAY_REQUEST)).toBe(true)
  })

  it('hands the raw body straight through for JsonDisplay', () => {
    expect(call(helpers.rawResponseValue!, PAY_REQUEST)).toEqual(
      PAY_REQUEST.body
    )
  })
})
