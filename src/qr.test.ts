import {describe, expect, it} from 'vitest'
import {create} from 'qrcode'
import {qrMatrix, qrSvg} from './qr'

// decodes qrMatrix's run-length path back into a module grid
const rasterize = (size: number, path: string): Uint8Array => {
  const grid = new Uint8Array(size * size)
  for (const m of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    const [x, y, w] = [Number(m[1]), Number(m[2]), Number(m[3])]
    for (let i = 0; i < w; i++) grid[y * size + x + i] = 1
  }
  return grid
}

describe('qrMatrix', () => {
  it('draws exactly the dark modules the encoder produced', () => {
    // long enough to need a multi-block, higher-version code
    const value = `https://mint.test/withdraw?k1=${'ab12'.repeat(40)}`
    const {size, path} = qrMatrix(value)
    const expected = create(value, {errorCorrectionLevel: 'L'}).modules
    expect(size).toBe(expected.size)
    expect(Array.from(rasterize(size, path))).toEqual(
      Array.from(expected.data, b => (b ? 1 : 0))
    )
  })

  it('produces a standalone, scalable svg document', () => {
    const svg = qrSvg('hello', 256)
    const {size} = qrMatrix('hello')
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
    expect(svg).toContain('width="256" height="256"')
    expect(svg).toContain(`viewBox="0 0 ${size} ${size}"`)
  })
})
