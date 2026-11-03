import {describe, expect, it} from 'vitest'
import {base64} from '@scure/base'
import {
  IMAGE_EXTENSION,
  IMAGE_MIME,
  imageDataUrl,
  imageFormatOf,
  imageFromDataUrl,
  isImageDataUrl
} from './imageData'
import {defaultNodeFor, describeNode, isSafeUiNode} from './uiTree'
import {validateManifest} from './validate'
import type {UiNode} from './types'

// real 8x8 files written by Pillow 12.1.1
const PNG = base64.decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAG0lEQVR4nGNkYGBQYBDARCwMCgIMDFjQ4JQAAIWuBc6DYRwvAAAAAElFTkSuQmCC'
)
const JPG = base64.decode(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCrpHhn7v7v9KKKKITdisux9f2C1P/Z'
)

const ascii = (text: string): Uint8Array =>
  Uint8Array.from(text, char => char.charCodeAt(0))

describe('imageFormatOf', () => {
  it('knows a JPG and a PNG by their first bytes, and nothing else', () => {
    expect(imageFormatOf(JPG)).toBe('jpeg')
    expect(imageFormatOf(PNG)).toBe('png')
    expect(IMAGE_MIME[imageFormatOf(JPG)!]).toBe('image/jpeg')
    expect(IMAGE_EXTENSION[imageFormatOf(JPG)!]).toBe('jpg')
    expect(imageFormatOf(ascii('GIF89a'))).toBeNull()
    expect(imageFormatOf(ascii('RIFF....WEBPVP8 '))).toBeNull()
    expect(
      imageFormatOf(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'))
    ).toBeNull()
    expect(imageFormatOf(PNG.subarray(0, 7))).toBeNull()
    expect(imageFormatOf(new Uint8Array(0))).toBeNull()
  })
})

describe('a picture as a data URL', () => {
  it('round-trips a JPG and a PNG', () => {
    expect(imageDataUrl(JPG)).toBe(
      `data:image/jpeg;base64,${base64.encode(JPG)}`
    )
    expect(imageDataUrl(PNG)).toBe(
      `data:image/png;base64,${base64.encode(PNG)}`
    )
    expect(imageFromDataUrl(imageDataUrl(JPG))).toEqual(JPG)
    expect(imageFromDataUrl(imageDataUrl(PNG))).toEqual(PNG)
    expect(isImageDataUrl(imageDataUrl(PNG))).toBe(true)
  })

  it('reads the URL out of what an ImagePicker bound', () => {
    const picked = {
      name: 'a.png',
      type: 'image/png',
      size: PNG.length,
      dataUrl: imageDataUrl(PNG)!
    }
    expect(imageFromDataUrl(picked)).toEqual(PNG)
    // but only a URL itself is one - the renderer's Image takes no object
    expect(isImageDataUrl(picked)).toBe(false)
  })

  it('is never a remote URL, a script-capable type, or bytes that lie about themselves', () => {
    const png = base64.encode(PNG)
    for (const value of [
      'https://example.com/picture.png',
      '//example.com/picture.png',
      'javascript:alert(1)',
      `data:image/svg+xml;base64,${base64.encode(ascii('<svg onload="alert(1)"/>'))}`,
      `data:text/html;base64,${base64.encode(ascii('<script>alert(1)</script>'))}`,
      `data:image/gif;base64,${png}`,
      `data:image/jpeg;base64,${png}`, // a PNG labelled JPG
      `data:image/png;base64,${base64.encode(ascii('not a png'))}`,
      `data:image/png;charset=utf-8;base64,${png}`,
      `data:image/png,${png}`,
      `data:image/png;base64,${png}"><script>`,
      ` data:image/png;base64,${png}`,
      'data:image/png;base64,!!!',
      '',
      null,
      undefined,
      42,
      {dataUrl: 42}
    ]) {
      expect(imageFromDataUrl(value)).toBeNull()
      expect(isImageDataUrl(value)).toBe(false)
    }
    expect(imageDataUrl(ascii('nope'))).toBeNull()
    expect(imageDataUrl('nope')).toBeNull()
  })
})

describe('the ImagePicker and Image nodes', () => {
  const manifestWith = (ui: unknown) => ({
    id: 'my-addon',
    name: 'My Addon',
    version: '1',
    icon: 'pricetags',
    permissions: [],
    state: {},
    ui
  })

  it('are valid in a manifest, a custom one included', () => {
    const ui = {
      type: 'View',
      children: [
        {type: 'ImagePicker', bind: 'picture', label: 'Picture'},
        {type: 'Image', value: {var: 'picture.dataUrl'}}
      ]
    }
    expect(validateManifest(manifestWith(ui)).ui).toEqual(ui)
  })

  it('are refused without what they need', () => {
    expect(() => validateManifest(manifestWith({type: 'ImagePicker'}))).toThrow(
      /bind must be a string/
    )
    expect(() => validateManifest(manifestWith({type: 'Image'}))).toThrow(
      /value/
    )
  })

  it('have an inert default the builder can add, and a line that describes them', () => {
    for (const type of ['ImagePicker', 'Image'] as UiNode['type'][]) {
      const node = defaultNodeFor(type)
      expect(node.type).toBe(type)
      expect(isSafeUiNode(node)).toBe(true)
      expect(() => validateManifest(manifestWith(node))).not.toThrow()
    }
    expect(describeNode({type: 'ImagePicker', bind: 'picture'})).toBe(
      'ImagePicker -> picture'
    )
    expect(describeNode({type: 'ImagePicker', bind: ''})).toBe(
      'ImagePicker -> (unbound)'
    )
    expect(describeNode({type: 'Image', value: {var: 'picture.dataUrl'}})).toBe(
      'Image {picture.dataUrl}'
    )
  })
})
