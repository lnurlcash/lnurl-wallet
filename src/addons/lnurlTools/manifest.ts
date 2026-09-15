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
  if (b.allowsNostr === true) {
    lines.push(
      `Nostr zaps (NIP-57): allowed${typeof b.nostrPubkey === 'string' ? ` (pubkey ${b.nostrPubkey})` : ''}`
    )
  }
  return lines.join('\n')
}

// the raw response body as-is (not pre-stringified) - 'JsonDisplay' does
// its own parsing/formatting, so this just hands over the value
const rawResponseValue = (response: unknown): unknown =>
  (response as FetchResult)?.body ?? null

// human-readable labels for the LUD-06 metadata types worth calling out by
// name; anything else still shows up in the list under its raw mime type
const METADATA_LABELS: Record<string, string> = {
  'text/plain': 'Description',
  'text/long-desc': 'Long description',
  'text/email': 'Email',
  'text/identifier': 'Identifier',
  'image/png;base64': 'Image (PNG, base64)',
  'image/jpeg;base64': 'Image (JPEG, base64)',
  // this wallet's own LUD-25 Part 2 extension - see internalTransfer.ts's
  // parseInternalTransferHint, `cx1<...>:<i>`
  'text/xpub': 'Internal transfer xpub (LUD-25)'
}

const MAX_METADATA_VALUE_LENGTH = 160

const truncateMetadataValue = (value: string): string =>
  value.length > MAX_METADATA_VALUE_LENGTH
    ? `${value.slice(0, MAX_METADATA_VALUE_LENGTH)}… (${value.length} chars)`
    : value

type MetadataEntry = {label: string; value: string}

// LUD-06's metadata field is a JSON-encoded array of [type, value] pairs -
// parses it into a flat list the UI can render as an <ol>, one <li> per
// entry, instead of hand-picking just the text/plain description like
// before. Never throws on an unexpected shape - an empty list just hides
// the metadata section (see hasMetadataEntries below).
const metadataEntries = (response: unknown): MetadataEntry[] => {
  const body = (response as FetchResult)?.body
  if (!body || typeof body !== 'object') return []
  const metadata = (body as Record<string, unknown>).metadata
  if (typeof metadata !== 'string') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(metadata)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const raw = parsed
    .filter(
      (entry): entry is [string, unknown] =>
        Array.isArray(entry) && typeof entry[0] === 'string'
    )
    .map(([type, value]) => ({
      label: METADATA_LABELS[type] ?? type,
      value: truncateMetadataValue(
        typeof value === 'string' ? value : JSON.stringify(value)
      )
    }))
  // LUD-06 allows the same metadata type more than once (e.g. two
  // "text/plain" entries) - number same-labelled entries (Description 1,
  // Description 2, ...) instead of showing several identical-looking
  // "Description" rows a holder can't tell apart
  const counts: Record<string, number> = {}
  for (const entry of raw) counts[entry.label] = (counts[entry.label] ?? 0) + 1
  const seen: Record<string, number> = {}
  return raw.map(entry => {
    if (counts[entry.label] === 1) return entry
    seen[entry.label] = (seen[entry.label] ?? 0) + 1
    return {...entry, label: `${entry.label} ${seen[entry.label]}`}
  })
}

const hasMetadataEntries = (response: unknown): boolean =>
  metadataEntries(response).length > 0

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
          {
            type: 'Show',
            when: {helper: 'hasMetadataEntries', args: [{var: 'response'}]},
            children: [
              {type: 'Text', value: 'Metadata', style: 'subheading'},
              {
                type: 'List',
                ordered: true,
                each: {helper: 'metadataEntries', args: [{var: 'response'}]},
                children: [
                  {
                    type: 'Text',
                    value: {
                      cat: [{var: 'item.label'}, ': ', {var: 'item.value'}]
                    }
                  }
                ]
              }
            ]
          },
          {type: 'Text', value: 'Raw JSON', style: 'subheading'},
          {
            type: 'JsonDisplay',
            value: {helper: 'rawResponseValue', args: [{var: 'response'}]}
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
  rawResponseValue: rawResponseValue as AddonHelper,
  metadataEntries: metadataEntries as AddonHelper,
  hasMetadataEntries: hasMetadataEntries as AddonHelper
}

export const lnurlToolsAddon: Addon = {
  manifest: lnurlToolsManifest,
  helpers: lnurlToolsHelpers
}
