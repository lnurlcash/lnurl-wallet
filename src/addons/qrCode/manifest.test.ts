import {describe, expect, it} from 'vitest'

import {qrCodeAddon} from './manifest'
import type {AddonHelper} from '../types'

const {helpers} = qrCodeAddon

const call = (fn: AddonHelper, ...args: unknown[]): unknown =>
  fn(...(args as never[]))

describe('qrCode', () => {
  it('encodes exactly what was entered, trimmed', () => {
    expect(call(helpers.qrValue!, '  lightning:alice@example.test \n')).toBe(
      'lightning:alice@example.test'
    )
    expect(call(helpers.qrValue!, 'https://example.test/x')).toBe(
      'https://example.test/x'
    )
  })

  it('shows nothing for empty or whitespace-only input', () => {
    expect(call(helpers.hasValue!, '')).toBe(false)
    expect(call(helpers.hasValue!, '   ')).toBe(false)
    expect(call(helpers.hasValue!, undefined)).toBe(false)
    expect(call(helpers.hasValue!, 'x')).toBe(true)
  })
})
