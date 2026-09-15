import type {Page} from '@playwright/test'

/** Generate a deterministic raster fixture without downloading external artwork. */
export const artwork = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 320
    const c = canvas.getContext('2d')!
    c.fillStyle = '#dfbd78'
    c.fillRect(0, 0, 320, 320)
    c.fillStyle = '#fbefc2'
    c.beginPath()
    c.arc(213, 94, 51, 0, Math.PI * 2)
    c.fill()
    c.fillStyle = '#315c42'
    c.beginPath()
    c.moveTo(0, 300)
    c.lineTo(90, 115)
    c.lineTo(196, 300)
    c.fill()
    c.fillStyle = '#224436'
    c.beginPath()
    c.moveTo(110, 320)
    c.lineTo(225, 153)
    c.lineTo(320, 310)
    c.fill()
    return canvas.toDataURL('image/png')
  })
