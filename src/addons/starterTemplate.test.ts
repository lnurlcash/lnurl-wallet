import {describe, expect, it} from 'vitest'

import {STARTER_TEMPLATE} from './starterTemplate'
import {validateManifest} from './validate'
import {isBundledAddon} from './registry'

describe('addon builder starter template', () => {
  it('is valid JSON that passes manifest validation', () => {
    const parsed: unknown = JSON.parse(STARTER_TEMPLATE)
    expect(() => validateManifest(parsed)).not.toThrow()
  })

  it("doesn't collide with a bundled addon's id", () => {
    const parsed = JSON.parse(STARTER_TEMPLATE) as {id: string}
    expect(isBundledAddon(parsed.id)).toBe(false)
  })
})
