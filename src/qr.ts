import {create} from 'qrcode'

// QR code -> SVG, built on the `qrcode` package's own encoder (create()
// only computes the module matrix - no canvas, no DOM). Replaces
// solid-qr-code, which never moved past Solid 1.x. Error correction stays
// at LOW, same as before: these codes are shown on a screen or saved as a
// vector, never printed small and scuffed, and LOW keeps a long bolt11
// invoice at the lowest version (= biggest modules) it can be.
//
// No quiet zone is drawn into the image itself - .qrcode's white border in
// style.scss provides it on screen, same as it did for solid-qr-code.

export interface QrMatrix {
  // modules per side
  size: number
  // a single path covering every dark module, in module units - drawn
  // against a viewBox of `0 0 size size`
  path: string
}

export const qrMatrix = (value: string): QrMatrix => {
  const {modules} = create(value, {errorCorrectionLevel: 'L'})
  const {size, data} = modules
  // one horizontal run per stretch of adjacent dark modules in a row,
  // instead of one square per module - several times shorter for a dense
  // code, and no hairline seams between neighbors when rasterized
  const parts: string[] = []
  for (let y = 0; y < size; y++) {
    let x = 0
    while (x < size) {
      if (!data[y * size + x]) {
        x++
        continue
      }
      const start = x
      while (x < size && data[y * size + x]) x++
      parts.push(`M${start} ${y}h${x - start}v1h${start - x}z`)
    }
  }
  return {size, path: parts.join('')}
}

// standalone SVG document - what a download saves, and identical to what
// Qr.tsx puts on screen for the same value and pixel size
export const qrSvg = (value: string, pixels = 512): string => {
  const {size, path} = qrMatrix(value)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}" ` +
    `viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/>` +
    `<path fill="#000" d="${path}"/></svg>`
  )
}
