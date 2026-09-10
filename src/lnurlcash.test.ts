import {describe, expect, it} from 'vitest'
import {
  generateNoteSecret,
  hashK1,
  isPreimage,
  MIN_COMMENT_LENGTH_FOR_SECRET
} from './lnurlcash'

// Everything else this file used to test now lives in src/lib/*.test.ts,
// mirroring the protocol code's own extraction into src/lib (see its
// README) - generateNoteSecret is the one piece that stays wallet-specific
// (src/lib/secrets.ts only defines the injection point, see
// configureSecretProvider in this module), so it's the one test that
// stays here rather than moving with the rest.
describe('generateNoteSecret', () => {
  it('generateNoteSecret + hashK1 produce exactly a 64-char hex comment', () => {
    const secret = generateNoteSecret('mint.example.com')
    expect(isPreimage(secret)).toBe(true)
    const comment = hashK1(secret)
    expect(comment).toMatch(/^[0-9a-f]{64}$/)
    expect(comment.length).toBe(MIN_COMMENT_LENGTH_FOR_SECRET)
    // deterministic - SERVICE must be able to key its note by the same
    // hash WALLET discloses up front
    expect(hashK1(secret)).toBe(comment)
  })
})
