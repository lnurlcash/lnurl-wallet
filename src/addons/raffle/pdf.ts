// Ported from /home/user/repos/raffle/src/lib/pdf.ts - renders the
// finished ticket plan to a print-ready PDF: a grid of cards, four side by
// side across the page, each with its QR code on top and the rest of the
// ticket's text below. The QR is drawn as filled rectangles from the QR
// matrix directly (see drawQr) rather than embedded as a raster image, so
// it stays crisp at any print size/DPI. The one external import
// (toBech32Lnurl) is redirected from the source project's `lnurlcash-kit`
// package to this wallet's own lnurlcash.ts. Trimmed of the source
// project's preview mode and ticket-pricing cover-page section, neither of
// which this addon's manifest uses.
//
// pdf-lib/qrcode are dynamically imported inside buildTicketPdf rather than
// statically at the top of this file - both are sizeable (pdf-lib alone
// roughly doubled the app's main bundle when imported statically), and
// every other holder who never opens an addon shouldn't pay for them. Only
// type-only imports stay static (erased at compile time, zero runtime/
// bundle cost).
import type {PDFFont, PDFPage} from 'pdf-lib'
import {toBech32Lnurl} from '../../lnurlcash'
import type {PaperSize} from './lottery'

export type PrintedTicket = {
  index: number
  amountSat: number
  label: string
  url: string
}

export type PdfConfig = {
  title: string
  paper: PaperSize
  showAmount: boolean
}

const MM = 2.8346456693 // points per mm, pdf-lib works in points

const PAGE_SIZE_MM: Record<PaperSize, [number, number]> = {
  a4: [210, 297],
  letter: [215.9, 279.4]
}

const MARGIN_MM = 10
const COLUMNS = 4
const ROWS = 4
const GAP_MM = 4
const CARD_PADDING_MM = 2.5

type Rgb = (typeof import('pdf-lib'))['rgb']
type QrModule = typeof import('qrcode')

const drawQr = (
  QRCode: QrModule,
  rgb: Rgb,
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  size: number
): void => {
  const qr = QRCode.create(text, {errorCorrectionLevel: 'M'})
  const n = qr.modules.size
  const cell = size / n
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (!qr.modules.get(row, col)) continue
      page.drawRectangle({
        x: x + col * cell,
        // PDF y grows upward; row 0 of the matrix is the top of the code
        y: y + size - (row + 1) * cell,
        width: cell,
        height: cell,
        color: rgb(0, 0, 0)
      })
    }
  }
}

// wraps a string into lines no wider than maxWidth at this font/size,
// breaking at word boundaries - for prose, where a mid-word break would be
// unreadable
const wrapWords = (
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number
): string[] => {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word
    if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line)
  return lines
}

// A short summary page ahead of the ticket grid, so the printed packet is
// self-contained and doesn't depend on whoever printed it also keeping the
// app state around.
const drawCoverPage = (
  rgb: Rgb,
  doc: import('pdf-lib').PDFDocument,
  config: PdfConfig,
  tickets: PrintedTicket[],
  fonts: {font: PDFFont; boldFont: PDFFont},
  pageWidth: number,
  pageHeight: number
): void => {
  const {font, boldFont} = fonts
  const margin = MARGIN_MM * MM
  const contentWidth = pageWidth - 2 * margin
  const page = doc.addPage([pageWidth, pageHeight])
  let cursorY = pageHeight - margin

  page.drawText(config.title, {
    x: margin,
    y: cursorY,
    size: 22,
    font: boldFont,
    maxWidth: contentWidth
  })
  cursorY -= 10 * MM

  page.drawText('LNURLcash Raffle', {
    x: margin,
    y: cursorY,
    size: 11,
    font,
    color: rgb(0.45, 0.45, 0.45)
  })
  cursorY -= 9 * MM

  const explanation =
    'Each ticket on the following pages is a self-contained LNURLcash ' +
    'bearer note: whoever holds it holds the prize. Scan its QR code with ' +
    'any LNURL-compatible Lightning wallet to check its value and claim ' +
    'it - no registration or verification with the organizer is needed.'
  for (const line of wrapWords(explanation, font, 9.5, contentWidth)) {
    page.drawText(line, {x: margin, y: cursorY, size: 9.5, font})
    cursorY -= 4.8 * MM
  }
  cursorY -= 5 * MM

  const totalSat = tickets.reduce((sum, t) => sum + t.amountSat, 0)
  page.drawText(
    `${tickets.length} tickets total, ${totalSat.toLocaleString()} sat prize pool`,
    {x: margin, y: cursorY, size: 12, font: boldFont}
  )
}

export const buildTicketPdf = async (
  title: string,
  tickets: PrintedTicket[],
  showAmount: boolean,
  paper: PaperSize = 'a4'
): Promise<Uint8Array> => {
  const [{PDFDocument, StandardFonts, rgb}, QRCode] = await Promise.all([
    import('pdf-lib'),
    import('qrcode')
  ])

  const config: PdfConfig = {title, paper, showAmount}
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold)

  const [pageWidthMm, pageHeightMm] = PAGE_SIZE_MM[config.paper]
  const pageWidth = pageWidthMm * MM
  const pageHeight = pageHeightMm * MM
  const margin = MARGIN_MM * MM
  const gap = GAP_MM * MM
  // both dimensions fill the page exactly - a fixed 4x4 grid per page,
  // rather than a fixed card size with leftover space at the bottom
  const cardWidth = (pageWidth - 2 * margin - (COLUMNS - 1) * gap) / COLUMNS
  const cardHeight = (pageHeight - 2 * margin - (ROWS - 1) * gap) / ROWS
  const padding = CARD_PADDING_MM * MM
  const cardsPerPage = ROWS * COLUMNS

  drawCoverPage(
    rgb,
    doc,
    config,
    tickets,
    {font, boldFont},
    pageWidth,
    pageHeight
  )

  const ordered = [...tickets].sort((a, b) => a.index - b.index)

  let page: PDFPage | null = null
  let cardOnPage = 0

  const addPage = () => {
    page = doc.addPage([pageWidth, pageHeight])
    cardOnPage = 0
  }

  for (const ticket of ordered) {
    if (!page || cardOnPage >= cardsPerPage) addPage()
    const p = page!

    const col = cardOnPage % COLUMNS
    const row = Math.floor(cardOnPage / COLUMNS)
    const left = margin + col * (cardWidth + gap)
    const top = pageHeight - margin - row * (cardHeight + gap)
    const bottom = top - cardHeight

    // a vertical cut line left of every card but the first in its row
    if (col > 0) {
      const cutX = left - gap / 2
      p.drawLine({
        start: {x: cutX, y: top},
        end: {x: cutX, y: bottom},
        thickness: 0.5,
        color: rgb(0.6, 0.6, 0.6),
        dashArray: [3, 3]
      })
    }
    // one horizontal cut line per row boundary, spanning the full row -
    // drawn once (from the row's first card) rather than once per card
    if (row > 0 && col === 0) {
      const cutY = top + gap / 2
      p.drawLine({
        start: {x: margin, y: cutY},
        end: {x: pageWidth - margin, y: cutY},
        thickness: 0.5,
        color: rgb(0.6, 0.6, 0.6),
        dashArray: [3, 3]
      })
    }

    const qrSize = cardWidth - 2 * padding
    const qrX = left + padding
    const qrY = top - padding - qrSize
    drawQr(QRCode, rgb, p, toBech32Lnurl(ticket.url), qrX, qrY, qrSize)

    const textX = left + padding
    const textWidth = cardWidth - 2 * padding
    let cursorY = qrY - 3 * MM

    p.drawText(config.title, {
      x: textX,
      y: cursorY,
      size: 7.5,
      font: boldFont,
      maxWidth: textWidth
    })
    cursorY -= 3.3 * MM
    p.drawText(`Ticket #${String(ticket.index + 1).padStart(3, '0')}`, {
      x: textX,
      y: cursorY,
      size: 6.5,
      font
    })

    if (config.showAmount) {
      cursorY -= 3 * MM
      p.drawText(`${ticket.amountSat.toLocaleString()} sat`, {
        x: textX,
        y: cursorY,
        size: 6.5,
        font
      })
    }
    if (ticket.label) {
      cursorY -= 3 * MM
      p.drawText(ticket.label, {
        x: textX,
        y: cursorY,
        size: 6.5,
        font,
        maxWidth: textWidth
      })
    }

    cardOnPage++
  }

  return doc.save()
}
