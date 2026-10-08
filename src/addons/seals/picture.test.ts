import {describe, expect, it} from 'vitest'
import {schnorr} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, concatBytes} from '@noble/hashes/utils.js'
import {base64} from '@scure/base'
import {
  crc32,
  decodeSealEnvelope,
  embedSealEnvelope,
  encodeSealEnvelope,
  pictureDataUrl,
  pictureFormatOf,
  pictureFromDataUrl,
  pictureHash,
  sealEnvelopeOf,
  sealPictureHashProblem,
  sealPictureProblem,
  stripSealEnvelope
} from './picture'
import {encodeSealConsignment, genesisState, nextState} from './seals'

// Real files, 8x8 pixels, written by Pillow 12.1.1:
// a baseline JFIF JPG,
const JPG = base64.decode(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCrpHhn7v7v9KKKKITdisux9f2C1P/Z'
)
// the same picture as a PNG,
const PNG = base64.decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAG0lEQVR4nGNkYGBQYBDARCwMCgIMDFjQ4JQAAIWuBc6DYRwvAAAAAElFTkSuQmCC'
)
// a JPG with an Exif APP1 after its JFIF APP0 and a comment of its own,
const JPG_EXIF = base64.decode(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/4QAsRXhpZgAATU0AKgAAAAgAAQEOAAIAAAAKAAAAGgAAAABhIHBpY3R1cmUA//4AEGp1c3QgYSBjb21tZW50/9sAQwANCQoLCggNCwoLDg4NDxMgFRMSEhMnHB4XIC4pMTAuKS0sMzpKPjM2RjcsLUBXQUZMTlJTUjI+WmFaUGBKUVJP/9sAQwEODg4TERMmFRUmTzUtNU9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09P/8AAEQgACAAIAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/aAAwDAQACEQMRAD8Aq6R4Z+7+7/SiiiiE3YrLsfX9gtT/2Q=='
)
// and a PNG with a tEXt chunk ("Comment") of its own
const PNG_TEXT = base64.decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFnRFWHRDb21tZW50AGp1c3QgYSBjb21tZW50P++T6gAAABtJREFUeJxjZGBgUGAQwEQsDAoCDAxY0OCUAACFrgXOg2EcLwAAAABJRU5ErkJggg=='
)

const PICTURES: [string, Uint8Array][] = [
  ['a JFIF JPG', JPG],
  ['a PNG', PNG],
  ['a JPG with Exif and a comment', JPG_EXIF],
  ['a PNG with a text chunk', PNG_TEXT]
]

const ascii = (text: string): Uint8Array =>
  Uint8Array.from(text, char => char.charCodeAt(0))

const indexOf = (bytes: Uint8Array, needle: Uint8Array, from = 0): number => {
  for (let i = from; i + needle.length <= bytes.length; i++) {
    if (needle.every((byte, j) => bytes[i + j] === byte)) return i
  }
  return -1
}

const count = (bytes: Uint8Array, needle: Uint8Array): number => {
  let found = 0
  for (let at = indexOf(bytes, needle); at >= 0;) {
    found++
    at = indexOf(bytes, needle, at + 1)
  }
  return found
}

const KEYWORD = ascii('LNURLcash seal\0')

describe('pictureFormatOf', () => {
  it('tells a JPG from a PNG by its first bytes, and knows nothing else', () => {
    expect(pictureFormatOf(JPG)).toBe('jpeg')
    expect(pictureFormatOf(JPG_EXIF)).toBe('jpeg')
    expect(pictureFormatOf(PNG)).toBe('png')
    expect(pictureFormatOf(ascii('GIF89a'))).toBeNull()
    expect(
      pictureFormatOf(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'))
    ).toBeNull()
    expect(pictureFormatOf(new Uint8Array(0))).toBeNull()
  })
})

describe('crc32', () => {
  it('is PNG’s own: the CRC every IEND chunk ends in', () => {
    expect(crc32(ascii('IEND'))).toBe(0xae426082)
    expect(crc32(new Uint8Array(0))).toBe(0)
    expect(crc32(ascii('123456789'))).toBe(0xcbf43926)
  })
})

describe.each(PICTURES)('an envelope in %s', (_name, picture) => {
  const text = 'seal1example and nothing else'

  it('a file that carries none comes back untouched', () => {
    const stripped = stripSealEnvelope(picture)!
    expect(stripped.envelope).toBeNull()
    expect(stripped.picture).toEqual(picture)
  })

  it('taking it out again gives back the original file, byte for byte', () => {
    const sealed = embedSealEnvelope(picture, text)
    expect(sealed).not.toEqual(picture)
    expect(sealed.length).toBeGreaterThan(picture.length)
    expect(pictureFormatOf(sealed)).toBe(pictureFormatOf(picture))
    const stripped = stripSealEnvelope(sealed)!
    expect(stripped.envelope).toBe(text)
    expect(stripped.picture).toEqual(picture)
  })

  it('a new envelope replaces the old one, it never piles up', () => {
    const once = embedSealEnvelope(picture, 'first')
    const twice = embedSealEnvelope(once, 'second')
    expect(count(twice, KEYWORD)).toBe(1)
    expect(stripSealEnvelope(twice)!.envelope).toBe('second')
    expect(stripSealEnvelope(twice)!.picture).toEqual(picture)
    expect(embedSealEnvelope(twice, 'first')).toEqual(once)
  })

  it('the picture’s hash is the bare file’s sha256, whatever it carries', () => {
    const hash = bytesToHex(sha256(picture))
    expect(pictureHash(picture)).toBe(hash)
    expect(pictureHash(embedSealEnvelope(picture, text))).toBe(hash)
    expect(pictureHash(embedSealEnvelope(picture, 'another one'))).toBe(hash)
  })
})

describe('where a JPG’s envelope goes', () => {
  it('is a COM segment right after the leading APPn segments', () => {
    const sealed = embedSealEnvelope(JPG, 'x')
    // SOI, then APP0 (JFIF, 16 bytes of payload and length), then ours
    const afterApp0 = 2 + 2 + 16
    expect(Array.from(sealed.subarray(afterApp0, afterApp0 + 4))).toEqual([
      0xff,
      0xfe,
      0x00,
      2 + KEYWORD.length + 1
    ])
    expect(indexOf(sealed, KEYWORD)).toBe(afterApp0 + 4)
    // everything before and after it is the file as it was
    expect(sealed.subarray(0, afterApp0)).toEqual(JPG.subarray(0, afterApp0))
    expect(sealed.subarray(afterApp0 + 4 + KEYWORD.length + 1)).toEqual(
      JPG.subarray(afterApp0)
    )
  })

  it('stays behind Exif, and leaves a comment that is not ours alone', () => {
    const sealed = embedSealEnvelope(JPG_EXIF, 'x')
    const exif = indexOf(sealed, ascii('Exif\0\0'))
    const ours = indexOf(sealed, KEYWORD)
    const theirs = indexOf(sealed, ascii('just a comment'))
    expect(exif).toBeGreaterThan(0)
    expect(ours).toBeGreaterThan(exif)
    expect(theirs).toBeGreaterThan(ours)
    expect(stripSealEnvelope(sealed)!.picture).toEqual(JPG_EXIF)
  })

  it('spreads a long envelope over as many segments as it needs', () => {
    // a segment holds under 64 KB; a long history is longer than that
    const text = 'seal1' + 'q'.repeat(150_000)
    const sealed = embedSealEnvelope(JPG, text)
    expect(count(sealed, KEYWORD)).toBe(3)
    const stripped = stripSealEnvelope(sealed)!
    expect(stripped.envelope).toBe(text)
    expect(stripped.picture).toEqual(JPG)
  })
})

describe('where a PNG’s envelope goes', () => {
  it('is a tEXt chunk right before IEND, with a CRC that checks out', () => {
    const sealed = embedSealEnvelope(PNG, 'x')
    const iend = sealed.length - 12
    expect(sealed.subarray(iend)).toEqual(PNG.subarray(PNG.length - 12))
    const chunk = sealed.subarray(PNG.length - 12, iend)
    const data = concatBytes(KEYWORD, ascii('x'))
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    expect(view.getUint32(0, false)).toBe(data.length)
    expect(chunk.subarray(4, 8)).toEqual(ascii('tEXt'))
    expect(chunk.subarray(8, 8 + data.length)).toEqual(data)
    expect(view.getUint32(8 + data.length, false)).toBe(
      crc32(concatBytes(ascii('tEXt'), data))
    )
    expect(sealed.subarray(0, PNG.length - 12)).toEqual(
      PNG.subarray(0, PNG.length - 12)
    )
  })

  it('leaves a text chunk that is not ours alone', () => {
    const sealed = embedSealEnvelope(PNG_TEXT, 'x')
    expect(indexOf(sealed, ascii('Comment\0just a comment'))).toBeGreaterThan(0)
    expect(stripSealEnvelope(sealed)!.picture).toEqual(PNG_TEXT)
  })

  it('holds a long envelope in its one chunk', () => {
    const text = 'seal1' + 'q'.repeat(150_000)
    const sealed = embedSealEnvelope(PNG, text)
    expect(count(sealed, KEYWORD)).toBe(1)
    expect(stripSealEnvelope(sealed)!.envelope).toBe(text)
  })

  it('reads none out of a file that carries two', () => {
    // two claims about one picture: picking either would be a guess - but
    // the picture under them is still the picture
    const once = embedSealEnvelope(PNG, 'first')
    const envelope = once.subarray(PNG.length - 12, once.length - 12)
    const twice = concatBytes(
      once.subarray(0, once.length - 12),
      envelope,
      once.subarray(once.length - 12)
    )
    const stripped = stripSealEnvelope(twice)!
    expect(stripped.envelope).toBeNull()
    expect(stripped.picture).toEqual(PNG)
  })
})

describe('an envelope another tool wrote, or damaged', () => {
  it('is read wherever it sits before the image data, and written back in the usual place', () => {
    // right after SOI, ahead of the JFIF segment
    const sealed = embedSealEnvelope(JPG, 'x')
    const start = indexOf(sealed, KEYWORD) - 4
    const segment = sealed.subarray(start, start + 4 + KEYWORD.length + 1)
    const early = concatBytes(JPG.subarray(0, 2), segment, JPG.subarray(2))
    expect(stripSealEnvelope(early)).toEqual({
      format: 'jpeg',
      picture: JPG,
      envelope: 'x'
    })
    expect(embedSealEnvelope(early, 'x')).toEqual(sealed)

    // a PNG's, right after IHDR instead of before IEND
    const sealedPng = embedSealEnvelope(PNG, 'x')
    const chunk = sealedPng.subarray(PNG.length - 12, sealedPng.length - 12)
    const ihdrEnd = 8 + 12 + 13
    const earlyPng = concatBytes(
      PNG.subarray(0, ihdrEnd),
      chunk,
      PNG.subarray(ihdrEnd)
    )
    expect(stripSealEnvelope(earlyPng)!.envelope).toBe('x')
    expect(stripSealEnvelope(earlyPng)!.picture).toEqual(PNG)
    expect(embedSealEnvelope(earlyPng, 'x')).toEqual(sealedPng)
  })

  it('reads nothing out of a PNG envelope whose CRC is wrong, and still takes it out', () => {
    const sealed = embedSealEnvelope(PNG, 'seal1example')
    const damaged = sealed.slice()
    damaged[damaged.length - 12 - 1]! ^= 1 // the envelope chunk's last CRC byte
    const stripped = stripSealEnvelope(damaged)!
    expect(stripped.envelope).toBeNull()
    expect(stripped.picture).toEqual(PNG)
    // a flipped byte in its text fails the same check
    const edited = sealed.slice()
    edited[indexOf(edited, KEYWORD) + KEYWORD.length]! ^= 1
    expect(stripSealEnvelope(edited)!.envelope).toBeNull()
    expect(pictureHash(edited)).toBe(pictureHash(PNG))
  })

  it('reads two envelopes in one JPG as one text, which is no seal', () => {
    // a JPG cannot tell two envelopes from one long one split in two
    const first = embedSealEnvelope(JPG, 'seal1first')
    const start = indexOf(first, KEYWORD) - 4
    const segment = first.subarray(start, start + 4 + KEYWORD.length + 10)
    const twice = concatBytes(
      first.subarray(0, start),
      segment,
      first.subarray(start)
    )
    const stripped = stripSealEnvelope(twice)!
    expect(stripped.envelope).toBe('seal1firstseal1first')
    expect(stripped.picture).toEqual(JPG)
    expect(sealEnvelopeOf(twice)).toBeNull()
  })

  it('takes a comment that merely mentions the keyword for the file’s own', () => {
    // not ours: the keyword is not at the start, followed by a NUL
    const comment = ascii('about LNURLcash seal\0x')
    const withComment = concatBytes(
      JPG.subarray(0, 20),
      Uint8Array.of(0xff, 0xfe, 0x00, comment.length + 2),
      comment,
      JPG.subarray(20)
    )
    expect(stripSealEnvelope(withComment)).toEqual({
      format: 'jpeg',
      picture: withComment,
      envelope: null
    })
  })
})

describe('files that are not what they claim', () => {
  it('reads nothing out of anything but a JPG or PNG', () => {
    for (const bytes of [
      new Uint8Array(0),
      ascii('GIF89a' + '\0'.repeat(20)),
      ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      ascii('seal1example')
    ]) {
      expect(stripSealEnvelope(bytes)).toBeNull()
      expect(pictureHash(bytes)).toBeNull()
      expect(() => embedSealEnvelope(bytes, 'x')).toThrow(/JPG or PNG/)
    }
    expect(stripSealEnvelope('not bytes')).toBeNull()
    expect(stripSealEnvelope(null)).toBeNull()
  })

  it('refuses a JPG cut off before its image data', () => {
    // inside the first quantisation table
    expect(stripSealEnvelope(JPG.subarray(0, 40))).toBeNull()
    // right after SOI
    expect(stripSealEnvelope(JPG.subarray(0, 4))).toBeNull()
    // a segment whose length runs past the end of the file
    const lying = JPG.slice(0, 30)
    lying[4] = 0xff
    lying[5] = 0xff
    expect(stripSealEnvelope(lying)).toBeNull()
  })

  it('refuses a PNG with a chunk that runs past the file, or no IEND', () => {
    expect(stripSealEnvelope(PNG.subarray(0, PNG.length - 12))).toBeNull()
    expect(stripSealEnvelope(PNG.subarray(0, 40))).toBeNull()
    expect(stripSealEnvelope(PNG.subarray(0, 8))).toBeNull()
    const lying = PNG.slice()
    lying[8] = 0x7f // the IHDR chunk now claims two gigabytes
    expect(stripSealEnvelope(lying)).toBeNull()
  })

  it('keeps whatever follows a PNG’s IEND where it was', () => {
    const trailing = concatBytes(PNG, ascii('trailing bytes'))
    const sealed = embedSealEnvelope(trailing, 'x')
    expect(stripSealEnvelope(sealed)!.picture).toEqual(trailing)
    expect(sealed.subarray(sealed.length - 14)).toEqual(ascii('trailing bytes'))
  })

  it('refuses text an envelope cannot hold', () => {
    expect(() => embedSealEnvelope(PNG, '')).toThrow(/ASCII/)
    expect(() => embedSealEnvelope(PNG, 'two\nlines')).toThrow(/ASCII/)
    expect(() => embedSealEnvelope(JPG, 'zero\0byte')).toThrow(/ASCII/)
    expect(() => embedSealEnvelope(JPG, 'ümlaut')).toThrow(/ASCII/)
  })
})

describe('what an envelope says', () => {
  const keypair = () => {
    const secretKey = schnorr.utils.randomSecretKey()
    return {
      secretKeyHex: bytesToHex(secretKey),
      pubkeyHex: bytesToHex(schnorr.getPublicKey(secretKey))
    }
  }
  const locked = {urlTemplate: 'https://mint.example.com/w', amountMsat: 1000}
  const issuer = keypair()
  const holder = keypair()
  const genesis = genesisState('Art #1', '', issuer.pubkeyHex)
  const consignment = encodeSealConsignment(locked, [
    genesis,
    nextState(genesis, holder.pubkeyHex)
  ])!

  it('is the consignment, alone, for a picture that names its owner', () => {
    const text = encodeSealEnvelope({consignment})
    expect(text).toBe(consignment)
    expect(decodeSealEnvelope(text)).toEqual({consignment})
    expect(decodeSealEnvelope(`  ${consignment}\n`)).toEqual({consignment})
  })

  it('adds the current owner’s secret key for a bearer picture', () => {
    const text = encodeSealEnvelope({
      consignment,
      claimSecretKeyHex: holder.secretKeyHex.toUpperCase()
    })
    expect(text).toBe(`${consignment} ${holder.secretKeyHex}`)
    expect(decodeSealEnvelope(text)).toEqual({
      consignment,
      claimSecretKeyHex: holder.secretKeyHex
    })
  })

  it('refuses to write a key that does not open the seal’s current state', () => {
    for (const claimSecretKeyHex of [
      issuer.secretKeyHex, // a past owner's
      keypair().secretKeyHex,
      'nope',
      '00'.repeat(32)
    ]) {
      expect(() =>
        encodeSealEnvelope({consignment, claimSecretKeyHex})
      ).toThrow(/current owner/)
    }
    expect(() => encodeSealEnvelope({consignment: 'nope'})).toThrow(
      /consignment/
    )
  })

  it('drops such a key when reading, and keeps the consignment', () => {
    expect(decodeSealEnvelope(`${consignment} ${issuer.secretKeyHex}`)).toEqual(
      {consignment}
    )
    expect(decodeSealEnvelope(`${consignment} nope`)).toEqual({consignment})
  })

  it('is nothing at all without a consignment', () => {
    expect(decodeSealEnvelope('')).toBeNull()
    expect(decodeSealEnvelope('nope')).toBeNull()
    expect(decodeSealEnvelope(holder.secretKeyHex)).toBeNull()
    expect(decodeSealEnvelope(`${consignment} a b`)).toBeNull()
    expect(decodeSealEnvelope(null)).toBeNull()
    expect(decodeSealEnvelope(42)).toBeNull()
  })

  it.each(PICTURES)('travels in %s and comes back out', (_name, picture) => {
    const envelope = {consignment, claimSecretKeyHex: holder.secretKeyHex}
    const sealed = embedSealEnvelope(picture, encodeSealEnvelope(envelope))
    expect(sealEnvelopeOf(sealed)).toEqual(envelope)
    expect(sealEnvelopeOf(picture)).toBeNull()
    expect(sealEnvelopeOf(embedSealEnvelope(picture, 'not a seal'))).toBeNull()
  })
})

describe('sealPictureProblem', () => {
  const owner = bytesToHex(
    schnorr.getPublicKey(schnorr.utils.randomSecretKey())
  )
  const states = [genesisState('Art #1', '', owner, pictureHash(JPG))]

  it('accepts the very file the seal was issued for, sealed or bare', () => {
    expect(states[0]!.assetId).toBe(bytesToHex(sha256(JPG)))
    expect(sealPictureProblem(states, JPG)).toBe('')
    expect(sealPictureProblem(states, embedSealEnvelope(JPG, 'x'))).toBe('')
  })

  it('rejects any other file - the same picture in another format included', () => {
    expect(sealPictureProblem(states, PNG)).toMatch(/not the picture/)
    expect(sealPictureProblem(states, JPG_EXIF)).toMatch(/not the picture/)
    const oneBitOff = JPG.slice()
    oneBitOff[oneBitOff.length - 3]! ^= 1
    expect(sealPictureProblem(states, oneBitOff)).toMatch(/not the picture/)
  })

  it('a seal issued without a picture matches no file', () => {
    expect(sealPictureProblem([genesisState('Art', '', owner)], JPG)).toMatch(
      /not the picture/
    )
  })

  it('says the same from a hash already taken', () => {
    expect(sealPictureHashProblem(states, pictureHash(JPG)!)).toBe('')
    expect(sealPictureHashProblem(states, pictureHash(PNG)!)).toMatch(
      /not the picture/
    )
    expect(sealPictureHashProblem(states, '')).toMatch(/not the picture/)
    expect(sealPictureHashProblem([], pictureHash(JPG)!)).toMatch(/No seal/)
  })

  it('says what is missing', () => {
    expect(sealPictureProblem(states, ascii('nope'))).toMatch(/JPG or PNG/)
    expect(sealPictureProblem([], JPG)).toMatch(/No seal/)
    expect(sealPictureProblem(null, JPG)).toMatch(/No seal/)
  })
})

describe('pictures as data URLs', () => {
  it('round-trips a JPG and a PNG', () => {
    expect(pictureDataUrl(JPG)).toMatch(/^data:image\/jpeg;base64,\/9j\//)
    expect(pictureDataUrl(PNG)).toMatch(/^data:image\/png;base64,iVBOR/)
    expect(pictureFromDataUrl(pictureDataUrl(JPG))).toEqual(JPG)
    expect(pictureFromDataUrl(pictureDataUrl(PNG))).toEqual(PNG)
    // what an ImagePicker binds
    expect(
      pictureFromDataUrl({name: 'a.png', dataUrl: pictureDataUrl(PNG)})
    ).toEqual(PNG)
  })

  it('reads nothing but a JPG or PNG data URL whose bytes are what it says', () => {
    const png = base64.encode(PNG)
    for (const value of [
      'https://example.com/picture.png',
      `data:image/svg+xml;base64,${base64.encode(ascii('<svg/>'))}`,
      `data:image/gif;base64,${png}`,
      `data:image/jpeg;base64,${png}`, // a PNG labelled JPG
      `data:image/png;base64,${base64.encode(ascii('not a png'))}`,
      'data:image/png;base64,!!!',
      `data:image/png,${png}`,
      '',
      null,
      {dataUrl: 42}
    ]) {
      expect(pictureFromDataUrl(value)).toBeNull()
    }
    expect(pictureDataUrl(ascii('nope'))).toBeNull()
    expect(pictureDataUrl('nope')).toBeNull()
  })
})
