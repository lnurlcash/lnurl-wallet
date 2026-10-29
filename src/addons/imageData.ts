// Pictures as plain data: how an image a holder picked lives in an addon's
// own JSON state, and the only shape the renderer will ever show as one.
//
// A picture is a JPG or a PNG, told apart by its first bytes - never by a
// file name or a browser-reported type - and it travels as a `data:` URL of
// exactly that type, base64. Nothing else is a picture here: no SVG (which
// is a document that can carry script), no GIF/WebP (no addon needs them
// yet), and above all no http(s) URL - an `Image` node that took one would
// let an addon make the holder's browser fetch from anywhere, telling
// whoever runs that server when the addon's page was opened and from where.
import {base64} from '@scure/base'

export type ImageFormat = 'jpeg' | 'png'

export const IMAGE_MIME: Record<ImageFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png'
}

export const IMAGE_EXTENSION: Record<ImageFormat, string> = {
  jpeg: 'jpg',
  png: 'png'
}

// what an ImagePicker accepts - a picture held as a data URL in a store
// costs a third more than its file, on every copy of that state
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export const imageFormatOf = (bytes: Uint8Array): ImageFormat | null => {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return 'jpeg'
  }
  return bytes.length >= PNG_SIGNATURE.length &&
    PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)
    ? 'png'
    : null
}

const DATA_URL = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]*={0,2})$/

// what an ImagePicker binds: the file's own name, its real type, its size
// in bytes, and the file itself as a data URL
export type PickedImage = {
  name: string
  type: string
  size: number
  dataUrl: string
}

// The bytes behind a picture's data URL - handed either the URL itself or
// whatever an ImagePicker bound. Null (never throws) for anything else,
// including a URL whose bytes are not what its own type says.
export const imageFromDataUrl = (value: unknown): Uint8Array | null => {
  const dataUrl =
    typeof value === 'string'
      ? value
      : (value as {dataUrl?: unknown} | null)?.dataUrl
  const match = typeof dataUrl === 'string' ? DATA_URL.exec(dataUrl) : null
  if (!match) return null
  try {
    const bytes = base64.decode(match[2]!)
    // the URL's own type is only a label - the bytes decide
    return imageFormatOf(bytes) === match[1] ? bytes : null
  } catch {
    return null
  }
}

export const imageDataUrl = (bytes: unknown): string | null => {
  if (!(bytes instanceof Uint8Array)) return null
  const format = imageFormatOf(bytes)
  return format
    ? `data:${IMAGE_MIME[format]};base64,${base64.encode(bytes)}`
    : null
}

// the one test the renderer's `Image` node applies before it lets a value
// anywhere near an <img src>
export const isImageDataUrl = (value: unknown): value is string =>
  typeof value === 'string' && imageFromDataUrl(value) !== null
