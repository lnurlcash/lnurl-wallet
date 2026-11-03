// A seal's picture: the consignment travels INSIDE the image file it is
// about, so handing someone the file hands them the picture, the whole
// ownership history and the mint's certificates in one piece - by mail, on
// a stick, as a download. And the picture is what the seal IS: its asset id
// is the sha256 of the picture's own bytes, so a holder checks "this file is
// the one the seal was issued for" with nothing but a hash.
//
// The consignment sits in an "envelope" that is not part of the picture:
//   JPG - one or more COM (comment) segments, each starting with
//         ENVELOPE_KEYWORD and a NUL; their texts are joined in file order
//         (a segment holds under 64 KB, a long history needs more than one).
//   PNG - one tEXt chunk with ENVELOPE_KEYWORD as its keyword.
// WRITING puts a JPG's segments after the leading APPn segments and a PNG's
// chunk right before IEND. READING takes an envelope wherever it sits among
// the segments before a JPG's image data, or the chunks before a PNG's
// IEND - so a file another tool wrote differently still reads, hashes to
// the same picture, and is put back in the usual place on the next write.
// What is not an envelope: anything after a JPG's first SOS, which is image
// data and hashed as such. A PNG with two envelope chunks, or one whose CRC
// is wrong, carries no readable envelope (both are still taken out for the
// hash). A JPG cannot tell two envelopes from one long one split in two:
// two texts joined are no consignment, so such a file reads as carrying
// none.
// Both are metadata every decoder skips: the picture shows exactly as it
// did. Taking the envelope out again (stripSealEnvelope) gives back the
// original file byte for byte, and THAT is what gets hashed - so the asset
// id never depends on whose consignment the file happens to carry, and a
// new owner's consignment can replace the old one in the same file.
//
// Nothing here decodes a pixel, and nothing re-encodes: a picture is walked
// marker by marker (JPG) or chunk by chunk (PNG) up to its image data and
// otherwise left alone. That is also the honest limit - the hash is over
// bytes, not looks. A screenshot, a resize, a recompression or a chat app
// that strips metadata produces a different file: either the envelope is
// gone, or the bytes no longer hash to the asset id. Send the file itself.
//
// Everything here is synchronous and pure (see taproot.ts's own note on why
// a helper bound to a live Text/set must not return a Promise).
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, concatBytes, hexToBytes} from '@noble/hashes/utils.js'
import {schnorr} from '@noble/curves/secp256k1.js'
import {
  IMAGE_EXTENSION,
  IMAGE_MIME,
  imageDataUrl,
  imageFormatOf,
  imageFromDataUrl,
  type ImageFormat
} from '../imageData'
import {decodeSealConsignment, type SealState} from './seals'

// a seal's picture is whatever the addon renderer itself calls a picture
// (see ../imageData.ts) - a JPG or a PNG, as bytes or as a data URL
export type PictureFormat = ImageFormat
export const PICTURE_MIME = IMAGE_MIME
export const PICTURE_EXTENSION = IMAGE_EXTENSION
export const pictureFormatOf = imageFormatOf
export const pictureFromDataUrl = imageFromDataUrl
export const pictureDataUrl = imageDataUrl

// what marks a COM segment / tEXt chunk as this envelope - a valid PNG
// keyword (1-79 printable Latin-1 characters, no leading/trailing space)
const ENVELOPE_KEYWORD = 'LNURLcash seal'

const ascii = (text: string): Uint8Array =>
  Uint8Array.from(text, char => char.charCodeAt(0))

const ENVELOPE_PREFIX = concatBytes(ascii(ENVELOPE_KEYWORD), Uint8Array.of(0))

// an envelope's text is a consignment (bech32m) and at most a hex key -
// printable ASCII only, so it reads the same under a JPG comment's
// unspecified charset and a PNG tEXt's Latin-1
const isPrintableAscii = (text: string): boolean => /^[\x20-\x7e]+$/.test(text)

const startsWith = (bytes: Uint8Array, prefix: Uint8Array, at = 0): boolean =>
  bytes.length >= at + prefix.length &&
  prefix.every((byte, i) => bytes[at + i] === byte)

const textOf = (bytes: Uint8Array): string =>
  Array.from(bytes, byte => String.fromCharCode(byte)).join('')

const PNG_SIGNATURE = Uint8Array.of(
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a
)

// ---- JPG ----

type JpegSegment = {
  marker: number
  // the whole segment, marker bytes included
  start: number
  end: number
  // its payload, after the two length bytes - empty for a standalone marker
  dataStart: number
}

const JPEG_COM = 0xfe
const JPEG_SOS = 0xda
const JPEG_EOI = 0xd9
// a JPG segment's length field is two bytes and counts itself
const JPEG_MAX_PAYLOAD = 0xffff - 2

// The marker segments between SOI and the image data, in file order, and
// where the rest (SOS and everything after it) begins. Null for anything
// that is not laid out that way - never guessed at, never repaired.
const jpegHeader = (
  bytes: Uint8Array
): {segments: JpegSegment[]; rest: number} | null => {
  const segments: JpegSegment[] = []
  let offset = 2
  for (;;) {
    if (offset >= bytes.length || bytes[offset] !== 0xff) return null
    // any number of 0xff fill bytes may precede a marker
    let at = offset + 1
    while (at < bytes.length && bytes[at] === 0xff) at++
    if (at >= bytes.length) return null
    const marker = bytes[at]!
    if (marker === JPEG_SOS || marker === JPEG_EOI) {
      return {segments, rest: offset}
    }
    // 0x00 is a stuffed byte of scan data, which cannot come before SOS
    if (marker === 0x00) return null
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      segments.push({marker, start: offset, end: at + 1, dataStart: at + 1})
      offset = at + 1
      continue
    }
    if (at + 2 >= bytes.length) return null
    const length = (bytes[at + 1]! << 8) | bytes[at + 2]!
    const end = at + 1 + length
    if (length < 2 || end > bytes.length) return null
    segments.push({marker, start: offset, end, dataStart: at + 3})
    offset = end
  }
}

const isJpegEnvelope = (bytes: Uint8Array, segment: JpegSegment): boolean =>
  segment.marker === JPEG_COM &&
  startsWith(bytes.subarray(0, segment.end), ENVELOPE_PREFIX, segment.dataStart)

const jpegEnvelopeSegment = (text: string): Uint8Array => {
  const payload = concatBytes(ENVELOPE_PREFIX, ascii(text))
  const length = payload.length + 2
  return concatBytes(
    Uint8Array.of(0xff, JPEG_COM, (length >> 8) & 0xff, length & 0xff),
    payload
  )
}

// ---- PNG ----

type PngChunk = {
  type: string
  // the whole chunk: length, type, data and CRC
  start: number
  end: number
  dataStart: number
  dataEnd: number
}

const readU32 = (bytes: Uint8Array, offset: number): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    offset,
    false
  )

const u32 = (value: number): Uint8Array => {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value >>> 0, false)
  return bytes
}

// Every chunk up to and including IEND, in file order, and where anything
// after IEND begins. Null when the chunks do not add up to the file or no
// IEND closes them.
const pngChunks = (
  bytes: Uint8Array
): {chunks: PngChunk[]; rest: number} | null => {
  const chunks: PngChunk[] = []
  let offset = PNG_SIGNATURE.length
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) return null
    const length = readU32(bytes, offset)
    const end = offset + 12 + length
    if (end > bytes.length) return null
    const type = textOf(bytes.subarray(offset + 4, offset + 8))
    chunks.push({
      type,
      start: offset,
      end,
      dataStart: offset + 8,
      dataEnd: offset + 8 + length
    })
    offset = end
    if (type === 'IEND') return {chunks, rest: offset}
  }
  return null
}

const isPngEnvelope = (bytes: Uint8Array, chunk: PngChunk): boolean =>
  chunk.type === 'tEXt' &&
  startsWith(bytes.subarray(0, chunk.dataEnd), ENVELOPE_PREFIX, chunk.dataStart)

// PNG's CRC-32 (ISO 3309, the same one zlib uses), over a chunk's type and
// data
const CRC_TABLE = Uint32Array.from({length: 256}, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

export const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const pngEnvelopeChunk = (text: string): Uint8Array => {
  const typeAndData = concatBytes(ascii('tEXt'), ENVELOPE_PREFIX, ascii(text))
  return concatBytes(
    u32(typeAndData.length - 4),
    typeAndData,
    u32(crc32(typeAndData))
  )
}

// ---- both ----

export type StrippedPicture = {
  format: PictureFormat
  // the file without any envelope - what the asset id is the hash of
  picture: Uint8Array
  // the envelope's text; null when the file carries none
  envelope: string | null
}

// Splits a JPG/PNG into the picture itself and the envelope it carries.
// Null for a file that is neither, or not laid out the way one must be -
// never throws. A file with no envelope comes back unchanged.
export const stripSealEnvelope = (bytes: unknown): StrippedPicture | null => {
  if (!(bytes instanceof Uint8Array)) return null
  const format = pictureFormatOf(bytes)
  if (format === 'jpeg') {
    const header = jpegHeader(bytes)
    if (!header) return null
    const kept: Uint8Array[] = [bytes.subarray(0, 2)]
    let envelope: string | null = null
    for (const segment of header.segments) {
      if (isJpegEnvelope(bytes, segment)) {
        envelope =
          (envelope ?? '') +
          textOf(
            bytes.subarray(
              segment.dataStart + ENVELOPE_PREFIX.length,
              segment.end
            )
          )
      } else {
        kept.push(bytes.subarray(segment.start, segment.end))
      }
    }
    kept.push(bytes.subarray(header.rest))
    return {format, picture: concatBytes(...kept), envelope}
  }
  if (format === 'png') {
    const parsed = pngChunks(bytes)
    if (!parsed) return null
    const kept: Uint8Array[] = [bytes.subarray(0, PNG_SIGNATURE.length)]
    const envelopes: string[] = []
    let damaged = false
    for (const chunk of parsed.chunks) {
      if (isPngEnvelope(bytes, chunk)) {
        // a chunk whose CRC does not match is one a PNG decoder would drop;
        // it is taken out like any envelope, and read as nothing
        damaged ||=
          readU32(bytes, chunk.dataEnd) !==
          crc32(bytes.subarray(chunk.start + 4, chunk.dataEnd))
        envelopes.push(
          textOf(
            bytes.subarray(
              chunk.dataStart + ENVELOPE_PREFIX.length,
              chunk.dataEnd
            )
          )
        )
      } else {
        kept.push(bytes.subarray(chunk.start, chunk.end))
      }
    }
    kept.push(bytes.subarray(parsed.rest))
    return {
      format,
      picture: concatBytes(...kept),
      // a PNG carries one envelope; two would be two claims about one
      // picture, and picking either would be a guess
      envelope: envelopes.length === 1 && !damaged ? envelopes[0]! : null
    }
  }
  return null
}

// The same picture carrying `envelope` - whatever envelope it carried
// before is replaced, never added to. Throws on a file that is not a
// JPG/PNG this module can walk, or on text an envelope cannot hold.
export const embedSealEnvelope = (
  bytes: Uint8Array,
  envelope: string
): Uint8Array => {
  if (!isPrintableAscii(envelope)) {
    throw new Error('An envelope holds printable ASCII text only.')
  }
  const stripped = stripSealEnvelope(bytes)
  if (!stripped) throw new Error('That file is not a JPG or PNG picture.')
  const {picture} = stripped
  if (stripped.format === 'jpeg') {
    const header = jpegHeader(picture)!
    // after the leading APPn segments: JFIF and Exif readers expect theirs
    // to come first
    let insertAt = 2
    for (const segment of header.segments) {
      if (segment.marker < 0xe0 || segment.marker > 0xef) break
      insertAt = segment.end
    }
    const perSegment = JPEG_MAX_PAYLOAD - ENVELOPE_PREFIX.length
    const segments: Uint8Array[] = []
    for (let offset = 0; offset < envelope.length; offset += perSegment) {
      segments.push(
        jpegEnvelopeSegment(envelope.slice(offset, offset + perSegment))
      )
    }
    return concatBytes(
      picture.subarray(0, insertAt),
      ...segments,
      picture.subarray(insertAt)
    )
  }
  const {chunks} = pngChunks(picture)!
  const iend = chunks[chunks.length - 1]!
  return concatBytes(
    picture.subarray(0, iend.start),
    pngEnvelopeChunk(envelope),
    picture.subarray(iend.start)
  )
}

// A picture's own hash - sha256 of the file without any envelope, hex. This
// is a picture seal's asset id. Null for a file that is no JPG/PNG.
export const pictureHash = (bytes: unknown): string | null => {
  const stripped = stripSealEnvelope(bytes)
  return stripped ? bytesToHex(sha256(stripped.picture)) : null
}

// ---- what an envelope says ----

export type SealEnvelope = {
  consignment: string
  // only in a BEARER picture: the secret key of the seal's current owner,
  // a one-time key made for this hand-over. Whoever holds the file holds
  // the seal - the first to move it to a key of their own keeps it.
  claimSecretKeyHex?: string
}

// "<consignment>" or "<consignment> <64 hex>" - one line, nothing else
export const encodeSealEnvelope = (envelope: SealEnvelope): string => {
  const consignment = String(envelope?.consignment ?? '').trim()
  if (!decodeSealConsignment(consignment)) {
    throw new Error('Not a valid seal consignment.')
  }
  const secret = String(envelope.claimSecretKeyHex ?? '')
    .trim()
    .toLowerCase()
  if (!secret) return consignment
  if (!claimKeyOpens(consignment, secret)) {
    throw new Error(
      'That key is not the secret key of this seal’s current owner.'
    )
  }
  return `${consignment} ${secret}`
}

const currentOwnerOf = (consignment: string): string | null => {
  const states = decodeSealConsignment(consignment)?.states
  return states?.length ? states[states.length - 1]!.ownerPubkeyHex : null
}

// whether `secretKeyHex` really is the secret key of the consignment's
// current owner - a key that opens nothing is noise, not a claim
const claimKeyOpens = (consignment: string, secretKeyHex: string): boolean => {
  if (!/^[0-9a-f]{64}$/.test(secretKeyHex)) return false
  try {
    return (
      bytesToHex(schnorr.getPublicKey(hexToBytes(secretKeyHex))) ===
      currentOwnerOf(consignment)
    )
  } catch {
    return false
  }
}

// Null for anything that is not an envelope's text (never throws). A key
// that does not open the consignment's current state is dropped, the
// consignment kept.
export const decodeSealEnvelope = (text: unknown): SealEnvelope | null => {
  if (typeof text !== 'string') return null
  const parts = text.trim().split(' ')
  if (parts.length > 2) return null
  const consignment = parts[0]!
  if (!decodeSealConsignment(consignment)) return null
  const secret = (parts[1] ?? '').toLowerCase()
  return secret && claimKeyOpens(consignment, secret)
    ? {consignment, claimSecretKeyHex: secret}
    : {consignment}
}

// The envelope a picture file carries, decoded - null when it carries none
// or the file is no JPG/PNG.
export const sealEnvelopeOf = (bytes: unknown): SealEnvelope | null =>
  decodeSealEnvelope(stripSealEnvelope(bytes)?.envelope)

// '' when `bytes` is the very picture this history's seal was issued for -
// its hash is the genesis state's asset id - else why not. A seal whose
// asset id is not a picture's hash (one issued without a picture) simply
// never matches any file.
export const sealPictureProblem = (states: unknown, bytes: unknown): string => {
  const hash = pictureHash(bytes)
  if (!hash && Array.isArray(states) && states[0]) {
    return 'That file is not a JPG or PNG picture.'
  }
  return sealPictureHashProblem(states, hash ?? '')
}

// sealPictureProblem for a caller that already has the picture's hash
// (pictureHash) - hashing megabytes is not something to repeat per check
export const sealPictureHashProblem = (
  states: unknown,
  pictureHashHex: string
): string => {
  const genesis = Array.isArray(states)
    ? (states[0] as SealState | undefined)
    : undefined
  if (!genesis) return 'No seal to compare the picture with.'
  return pictureHashHex === genesis.assetId
    ? ''
    : 'This is not the picture the seal was issued for - its bytes hash to something else. A screenshot, a resized or a recompressed copy is a different file.'
}
