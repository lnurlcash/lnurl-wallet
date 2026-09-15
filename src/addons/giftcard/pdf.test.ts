import {describe, expect, it} from 'vitest'
import {buildGiftCardPdf, GIFT_CARD_TEMPLATE_NAMES} from './pdf'

const URL = `https://mint.example.com/w?k1=${'a'.repeat(64)}&amount=21000000`

// Smoke test only - pdf-lib's own rendering internals aren't re-verified
// here, just that buildGiftCardPdf actually completes (a PDF header comes
// out) for every template, and doesn't throw on an empty message or an
// unknown template name.
describe('buildGiftCardPdf', () => {
  it('renders a PDF for every built-in template', async () => {
    for (const template of GIFT_CARD_TEMPLATE_NAMES) {
      const bytes = await buildGiftCardPdf(
        'Happy Birthday!',
        21000,
        template,
        URL
      )
      expect(bytes.length).toBeGreaterThan(0)
      // pdf-lib always starts a saved document with the standard PDF header
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
    }
  })

  it('still works with an empty message', async () => {
    const bytes = await buildGiftCardPdf('', 100, 'classic', URL)
    expect(bytes.length).toBeGreaterThan(0)
  })

  it('falls back to the classic template for an unknown name', async () => {
    const bytes = await buildGiftCardPdf(
      'hi',
      100,
      'not-a-real-template' as never,
      URL
    )
    expect(bytes.length).toBeGreaterThan(0)
  })
})
