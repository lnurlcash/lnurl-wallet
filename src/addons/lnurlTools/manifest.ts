import type {Addon, AddonHelper, AddonManifest} from '../types'
import {isBech32Lnurl, toBech32Lnurl} from '../../lnurlcash'

// This addon's own network fetch (see verbs.ts's lnurl.fetch) is the first
// one in this app that isn't the wallet's own already-running feed
// (compare the currency addon's rates()) - a read-only informational GET
// against whatever service the holder points it at, using the exact same
// resolveLnurlInput/lnurlFetch every other LNURL-touching flow in this
// wallet already goes through (same SSRF allowlist, same offline-mode
// guard). Never a note, secret, or wallet-state access.
const stripScheme = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .replace(/^lightning:/i, '')

const stringLength = (value: unknown): number => String(value ?? '').length

// the same value a paste/scan of this input would resolve to for a QR: an
// already-bech32/lightning:/lnurl-scheme string is shown as-is, a plain
// https:// URL is bech32-encoded first (LUD-01) since that's the form most
// LNURL-reading wallets actually expect to scan
const qrValue = (input: unknown): string => {
  const trimmed = stripScheme(input)
  if (!trimmed) return ''
  if (/^https?:\/\//i.test(trimmed) && !isBech32Lnurl(trimmed)) {
    return toBech32Lnurl(trimmed)
  }
  return trimmed
}

type FetchResult = {url: string; body: unknown} | null

const hasResponse = (response: unknown): boolean =>
  !!(response as FetchResult)?.body

const resolvedUrlDisplay = (response: unknown): string => {
  const r = response as FetchResult
  return r?.url ?? '-'
}

// picks out the fields worth reading at a glance from whatever shape the
// response turned out to be (LUD-06 payRequest, LUD-03 withdrawRequest, an
// error, or something this addon doesn't specifically know about) - never
// throws on an unexpected shape, just shows whichever of these fields
// happen to be present. The raw JSON below always has the rest.
const formatLnurlResponse = (response: unknown): string => {
  const body = (response as FetchResult)?.body
  if (!body || typeof body !== 'object') return ''
  const b = body as Record<string, unknown>
  if (b.status === 'ERROR') {
    return `Error: ${typeof b.reason === 'string' && b.reason ? b.reason : '(no reason given)'}`
  }
  const lines: string[] = []
  if (typeof b.tag === 'string') lines.push(`Tag: ${b.tag}`)
  if (typeof b.callback === 'string') lines.push(`Callback: ${b.callback}`)
  if (typeof b.minSendable === 'number' && typeof b.maxSendable === 'number') {
    lines.push(
      `Sendable: ${Math.floor(b.minSendable / 1000).toLocaleString()} - ${Math.floor(b.maxSendable / 1000).toLocaleString()} sats`
    )
  }
  if (
    typeof b.minWithdrawable === 'number' &&
    typeof b.maxWithdrawable === 'number'
  ) {
    lines.push(
      `Withdrawable: ${Math.floor(b.minWithdrawable / 1000).toLocaleString()} - ${Math.floor(b.maxWithdrawable / 1000).toLocaleString()} sats`
    )
  }
  if (typeof b.metadata === 'string') {
    try {
      const entries: unknown = JSON.parse(b.metadata)
      const textEntry = Array.isArray(entries)
        ? entries.find(e => Array.isArray(e) && e[0] === 'text/plain')
        : null
      if (textEntry) lines.push(`Description: ${textEntry[1]}`)
    } catch {
      // metadata wasn't valid JSON - the raw JSON dump below still shows it
    }
  }
  if (typeof b.defaultDescription === 'string') {
    lines.push(`Description: ${b.defaultDescription}`)
  }
  if (typeof b.withdrawLink === 'string') {
    lines.push(`Withdraw link (LUD-25): ${b.withdrawLink}`)
  }
  if (typeof b.mintPubkey === 'string')
    lines.push(`Mint pubkey: ${b.mintPubkey}`)
  if (typeof b.commentAllowed === 'number') {
    lines.push(`Comment allowed: ${b.commentAllowed} characters`)
  }
  return lines.join('\n')
}

const rawResponseDisplay = (response: unknown): string => {
  const body = (response as FetchResult)?.body
  return body ? JSON.stringify(body, null, 2) : ''
}

const lnurlToolsManifest: AddonManifest = {
  id: 'lnurl-tools',
  name: 'LNURL Tools',
  version: '1',
  icon: 'globe',
  description:
    'Resolve and fetch any LNURL, Lightning Address, lightning: URI, or https:// URL from its actual service, and generate a QR code for it.',
  permissions: [
    {
      verb: 'lnurl.fetch',
      reason:
        'Fetches whatever LNURL, Lightning Address, or URL you enter, to show its response - contacts that service directly.'
    }
  ],
  nav: {position: 'right', icon: 'globe', label: 'LNURL'},
  state: {
    input: '',
    response: null
  },
  ui: {
    type: 'View',
    children: [
      {type: 'Text', value: 'LNURL Tools', style: 'heading'},
      {
        type: 'Text',
        value:
          'Resolve and fetch any LNURL, Lightning Address, lightning: URI, or https:// URL - and generate a QR code for it.'
      },
      {
        type: 'Input',
        bind: 'input',
        label: 'LNURL, Lightning Address, or URL'
      },
      {
        type: 'Show',
        when: {
          gt: [
            {
              helper: 'stringLength',
              args: [{helper: 'qrValue', args: [{var: 'input'}]}]
            },
            0
          ]
        },
        children: [
          {type: 'Text', value: 'QR code', style: 'subheading'},
          {
            type: 'QrDisplay',
            value: {helper: 'qrValue', args: [{var: 'input'}]}
          }
        ]
      },
      {
        type: 'Button',
        label: 'Fetch',
        onClick: {
          verb: 'lnurl.fetch',
          args: {input: {var: 'input'}},
          result: 'response'
        }
      },
      {
        type: 'Show',
        when: {helper: 'hasResponse', args: [{var: 'response'}]},
        children: [
          {type: 'Text', value: 'Resolved to', style: 'subheading'},
          {
            type: 'Text',
            value: {helper: 'resolvedUrlDisplay', args: [{var: 'response'}]}
          },
          {type: 'Text', value: 'Response', style: 'subheading'},
          {
            type: 'Text',
            value: {helper: 'formatLnurlResponse', args: [{var: 'response'}]},
            style: 'response-block'
          },
          {type: 'Text', value: 'Raw JSON', style: 'subheading'},
          {
            type: 'Text',
            value: {helper: 'rawResponseDisplay', args: [{var: 'response'}]},
            style: 'response-block'
          }
        ]
      }
    ]
  }
}

const lnurlToolsHelpers: Record<string, AddonHelper> = {
  stringLength: stringLength as AddonHelper,
  qrValue: qrValue as AddonHelper,
  hasResponse: hasResponse as AddonHelper,
  resolvedUrlDisplay: resolvedUrlDisplay as AddonHelper,
  formatLnurlResponse: formatLnurlResponse as AddonHelper,
  rawResponseDisplay: rawResponseDisplay as AddonHelper
}

export const lnurlToolsAddon: Addon = {
  manifest: lnurlToolsManifest,
  helpers: lnurlToolsHelpers
}
