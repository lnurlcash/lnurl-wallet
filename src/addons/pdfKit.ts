// Small pdf-lib/qrcode drawing helpers shared by every addon that renders
// a printable PDF (raffle/pdf.ts, giftcard/pdf.ts) - factored out once a
// second real consumer needed the exact same "draw a QR matrix as filled
// rectangles" and "wrap prose to a max width" logic, rather than each
// addon keeping its own copy. Both pdf-lib and qrcode stay type-only
// imports here (erased at compile time) - the actual modules are always
// dynamically imported by the caller (see either pdf.ts's own top
// comment on why), never pulled into the main bundle by this file.
import type {PDFFont, PDFPage} from 'pdf-lib'

export type Rgb = (typeof import('pdf-lib'))['rgb']
export type QrModule = typeof import('qrcode')

export const drawQr = (
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
export const wrapWords = (
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
