import type {Addon, AddonHelper, AddonManifest} from '../types'

// A pure text-to-QR display - no verb/permission, no network, no wallet
// state. Encodes exactly what's entered (trimmed), nothing converted, so
// what's scanned is what was typed.
const qrValue = (input: unknown): string => String(input ?? '').trim()

const hasValue = (input: unknown): boolean => qrValue(input).length > 0

const qrCodeManifest: AddonManifest = {
  id: 'qr-code',
  name: 'QR Code',
  version: '1',
  icon: 'qrcode',
  description: 'Show a QR code for any text you enter.',
  permissions: [],
  nav: {position: 'right', icon: 'qrcode', label: 'QR'},
  state: {
    input: ''
  },
  ui: {
    type: 'View',
    children: [
      {type: 'Text', value: 'QR Code', style: 'heading'},
      {type: 'Input', bind: 'input', label: 'Text'},
      {
        type: 'Show',
        when: {helper: 'hasValue', args: [{var: 'input'}]},
        children: [
          {
            type: 'QrDisplay',
            value: {helper: 'qrValue', args: [{var: 'input'}]}
          }
        ]
      }
    ]
  }
}

const qrCodeHelpers: Record<string, AddonHelper> = {
  qrValue: qrValue as AddonHelper,
  hasValue: hasValue as AddonHelper
}

export const qrCodeAddon: Addon = {
  manifest: qrCodeManifest,
  helpers: qrCodeHelpers
}
