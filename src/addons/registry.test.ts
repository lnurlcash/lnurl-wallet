import {describe, expect, it} from 'vitest'
import {ADDONS} from './registry'
import {validateManifest} from './validate'

// every bundled addon's manifest must pass the exact same structural
// validation a holder-authored one does - catches a malformed UI tree or
// an unknown verb reference at test time rather than only when the addon
// is actually opened
describe('bundled addon manifests', () => {
  it('all pass validateManifest', () => {
    for (const addon of ADDONS) {
      expect(() => validateManifest(addon.manifest)).not.toThrow()
    }
  })

  it('have unique ids', () => {
    const ids = ADDONS.map(a => a.manifest.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
