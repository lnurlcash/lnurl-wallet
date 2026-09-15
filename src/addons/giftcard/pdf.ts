// Renders one gift card to a print-ready PDF, sized to the card itself
// (140x90mm landscape, roughly postcard-sized) rather than a grid on a
// full page - this addon makes one card at a time, unlike raffle's own
// multi-ticket sheet. Same QR-as-filled-rectangles approach as raffle
// (see pdfKit.ts's drawQr) so it stays crisp at any print size/DPI.
//
// pdf-lib/qrcode are dynamically imported inside buildGiftCardPdf, not
// statically at the top of this file - see raffle/pdf.ts's own top
// comment for why (bundle size for every holder who never opens this
// addon). Only type-only imports stay static (erased at compile time).
import {toBech32Lnurl} from '../../lnurlcash'
import {drawQr, wrapWords} from '../pdfKit'

export type GiftCardTemplate =
  'classic' | 'festive' | 'birthday' | 'ocean' | 'minimal'

type TemplateColors = {
  label: string
  bg: [number, number, number]
  accent: [number, number, number]
  text: [number, number, number]
}

// a fixed, curated set of colour themes rather than arbitrary background
// image upload - keeps this addon's own state/manifest plain JSON (a
// template name, not an uploaded asset) and keeps every card legible/
// printable regardless of what a holder picks
export const GIFT_CARD_TEMPLATES: Record<GiftCardTemplate, TemplateColors> = {
  classic: {
    label: 'Classic (amber & black)',
    bg: [0.06, 0.05, 0.04],
    accent: [1, 0.62, 0.25],
    text: [0.95, 0.95, 0.95]
  },
  festive: {
    label: 'Festive (red & green)',
    bg: [0.07, 0.02, 0.02],
    accent: [0.8, 0.16, 0.16],
    text: [0.95, 0.95, 0.95]
  },
  birthday: {
    label: 'Birthday (purple & gold)',
    bg: [0.08, 0.02, 0.13],
    accent: [0.85, 0.66, 0.16],
    text: [0.95, 0.95, 0.95]
  },
  ocean: {
    label: 'Ocean (blue & teal)',
    bg: [0.02, 0.06, 0.1],
    accent: [0.16, 0.66, 0.76],
    text: [0.95, 0.95, 0.95]
  },
  minimal: {
    label: 'Minimal (black on white)',
    bg: [1, 1, 1],
    accent: [0.1, 0.1, 0.1],
    text: [0.1, 0.1, 0.1]
  }
}

export const GIFT_CARD_TEMPLATE_NAMES = Object.keys(
  GIFT_CARD_TEMPLATES
) as GiftCardTemplate[]

const MM = 2.8346456693 // points per mm, pdf-lib works in points
const CARD_WIDTH_MM = 140
const CARD_HEIGHT_MM = 90
const MARGIN_MM = 8
const ACCENT_BAR_MM = 5

export const buildGiftCardPdf = async (
  message: string,
  amountSat: number,
  template: GiftCardTemplate,
  url: string
): Promise<Uint8Array> => {
  const [{PDFDocument, StandardFonts, rgb}, QRCode] = await Promise.all([
    import('pdf-lib'),
    import('qrcode')
  ])

  const colors = GIFT_CARD_TEMPLATES[template] ?? GIFT_CARD_TEMPLATES.classic
  const bg = rgb(...colors.bg)
  const accent = rgb(...colors.accent)
  const text = rgb(...colors.text)

  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold)

  const pageWidth = CARD_WIDTH_MM * MM
  const pageHeight = CARD_HEIGHT_MM * MM
  const margin = MARGIN_MM * MM
  const accentBar = ACCENT_BAR_MM * MM

  const page = doc.addPage([pageWidth, pageHeight])

  page.drawRectangle({
    x: 0,
    y: 0,
    width: pageWidth,
    height: pageHeight,
    color: bg
  })
  page.drawRectangle({
    x: 0,
    y: 0,
    width: accentBar,
    height: pageHeight,
    color: accent
  })
  // a thin frame - most printers can't bleed to the physical edge, so a
  // visible border reads intentional rather than "cut off"
  page.drawRectangle({
    x: 1,
    y: 1,
    width: pageWidth - 2,
    height: pageHeight - 2,
    borderColor: accent,
    borderWidth: 1
  })

  const contentX = accentBar + margin
  const contentWidth = pageWidth - accentBar - margin - margin
  let cursorY = pageHeight - margin

  page.drawText('GIFT CARD', {
    x: contentX,
    y: cursorY - 10,
    size: 11,
    font: boldFont,
    color: accent
  })
  cursorY -= 22

  const amountLabel = `${amountSat.toLocaleString()} sats`
  page.drawText(amountLabel, {
    x: contentX,
    y: cursorY - 20,
    size: 26,
    font: boldFont,
    color: text,
    maxWidth: contentWidth - 34 * MM // leave room for the QR to its right
  })
  cursorY -= 42

  const messageWidth = contentWidth - 34 * MM
  const messageLines = message ? wrapWords(message, font, 10, messageWidth) : []
  for (const line of messageLines.slice(0, 4)) {
    page.drawText(line, {
      x: contentX,
      y: cursorY,
      size: 10,
      font,
      color: text
    })
    cursorY -= 13
  }

  const qrSize = 26 * MM
  const qrX = pageWidth - margin - qrSize
  const qrY = margin + 6
  drawQr(QRCode, rgb, page, toBech32Lnurl(url), qrX, qrY, qrSize)
  page.drawText('Scan to claim', {
    x: qrX,
    y: qrY + qrSize + 4,
    size: 6.5,
    font,
    color: text
  })

  page.drawText(
    'A self-contained Lightning/LNURLcash bearer note - whoever holds this QR holds the funds.',
    {
      x: contentX,
      y: margin - 2,
      size: 6,
      font,
      color: text,
      maxWidth: contentWidth,
      opacity: 0.7
    }
  )

  return doc.save()
}
