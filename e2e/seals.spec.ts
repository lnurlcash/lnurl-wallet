import {readFileSync} from 'node:fs'
import {deflateSync} from 'node:zlib'
import {
  test,
  expect,
  type Download,
  type Page,
  type Route
} from '@playwright/test'
import {schnorr, secp256k1} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  utf8ToBytes
} from '@noble/hashes/utils.js'

import {
  decodeCp1,
  encodeCp1,
  encodeCr1WithAmount,
  encodeCs1WithAmount,
  isCk1,
  outputKeyOfCw1
} from '../src/lib/recoverableNotes'
import {ck1Pubkey} from '../src/lib/signature'
import {bearerNoteIdOfHash, bearerNoteIdOfPreimage} from '../src/lib/spend'
import {
  crc32,
  embedSealEnvelope,
  sealEnvelopeOf,
  stripSealEnvelope
} from '../src/addons/seals/picture'
import {
  decodeSealConsignment,
  sealCertificateProblem
} from '../src/addons/seals/seals'
import {setUpWallet, enableAddon} from './helpers'

// A picture seal's whole life, through the real UI and a mint that
// certifies rotations the way lnurl-mint does: issued with a picture, read
// back out of the downloaded file, handed on as a bearer picture, claimed
// from it to a named owner - and what the mint then says about each file.

const MINT = 'https://mint-seals.example.test'
const AMOUNT_MSAT = 21_000
const SOURCE_K1 = 'ab'.repeat(32)

const MINT_PRIV = new Uint8Array(32).fill(11)
const MINT_PUBKEY = bytesToHex(secp256k1.getPublicKey(MINT_PRIV, true))

const keypair = (fill: number) => {
  const secretKey = new Uint8Array(32).fill(fill)
  return {
    secretKeyHex: bytesToHex(secretKey),
    pubkeyHex: bytesToHex(schnorr.getPublicKey(secretKey))
  }
}
const ISSUER = keypair(21)
const BUYER = keypair(42)

// a real PNG, big enough to see: a 96x128 gradient
const makePng = (width: number, height: number): Uint8Array => {
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const typeAndData = concatBytes(utf8ToBytes(type), data)
    const framed = new Uint8Array(8 + typeAndData.length)
    const view = new DataView(framed.buffer)
    view.setUint32(0, data.length, false)
    framed.set(typeAndData, 4)
    view.setUint32(4 + typeAndData.length, crc32(typeAndData), false)
    return framed
  }
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width, false)
  view.setUint32(4, height, false)
  header.set([8, 2, 0, 0, 0], 8) // 8 bit, RGB, no interlace
  const rows = new Uint8Array(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * (1 + width * 3) + 1 + x * 3
      rows.set(
        [247, Math.floor((147 * y) / height), Math.floor((255 * x) / width)],
        at
      )
    }
  }
  return concatBytes(
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk('IHDR', header),
    chunk('IDAT', new Uint8Array(deflateSync(rows))),
    chunk('IEND', new Uint8Array(0))
  )
}
const PICTURE = makePng(96, 128)
const PICTURE_HASH = bytesToHex(sha256(PICTURE))
const MINT_HOST = new URL(MINT).host

// a real 8x8 JFIF JPG, written by Pillow
const JPG = new Uint8Array(
  Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCrpHhn7v7v9KKKKITdisux9f2C1P/Z',
    'base64'
  )
)

// cross-origin from the dev server, so the browser needs CORS headers to
// hand the body to the wallet
const json = (route: Route, body: object) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: {'access-control-allow-origin': '*'},
    body: JSON.stringify(body)
  })

const signAsMint = (message: string): Uint8Array => {
  const digest = sha256(
    sha256(
      concatBytes(
        utf8ToBytes('Lightning Signed Message:'),
        utf8ToBytes(message)
      )
    )
  )
  const sig = secp256k1.sign(digest, MINT_PRIV, {
    format: 'recovered',
    prehash: false
  })
  return concatBytes(sig.subarray(1), sig.subarray(0, 1))
}

// A mint that holds notes by their output key, rotates one into another on
// any spend naming a live note (checking a spend's signature is the
// kernel's business, not this test's), and answers a rotate with the new
// note's certificate and the rotation's own.
const mockMint = async (page: Page) => {
  const live = new Map<string, number>([
    [bearerNoteIdOfPreimage(SOURCE_K1), AMOUNT_MSAT]
  ])
  const spent = new Set<string>()
  const noteOfSpend = (k1: string): string =>
    /^[0-9a-f]{64}$/.test(k1)
      ? bearerNoteIdOfPreimage(k1)
      : isCk1(k1)
        ? bytesToHex(ck1Pubkey(k1)!)
        : outputKeyOfCw1(k1)!
  const noteOfRef = (ref: string): string =>
    /^[0-9a-f]{64}$/.test(ref)
      ? bearerNoteIdOfHash(ref)
      : bytesToHex(decodeCp1(ref)!)

  await page.route(`${MINT}/**`, route => {
    const url = new URL(route.request().url())
    const params = url.searchParams
    if (url.pathname === '/w') {
      const k1 = params.get('k1')
      const note = k1 ? noteOfSpend(k1) : noteOfRef(params.get('p') ?? '')
      if (spent.has(note)) {
        return json(route, {status: 'ERROR', reason: 'Note already spent.'})
      }
      const amountMsat = live.get(note)
      if (amountMsat === undefined) {
        return json(route, {status: 'ERROR', reason: 'Unknown note.'})
      }
      return json(route, {
        tag: 'withdrawRequest',
        callback: `${MINT}/w/cb`,
        ...(k1 ? {k1} : {}),
        minWithdrawable: amountMsat,
        maxWithdrawable: amountMsat,
        defaultDescription: 'test note',
        mintPubkey: MINT_PUBKEY,
        c: encodeCs1WithAmount(
          amountMsat,
          signAsMint(`LNURLcash:${amountMsat}:${note}`)
        )
      })
    }
    if (url.pathname === '/w/cb') {
      const burned = noteOfSpend(params.get('k1') ?? '')
      const amountMsat = live.get(burned)
      if (amountMsat === undefined) {
        return json(route, {status: 'ERROR', reason: 'Note already spent.'})
      }
      const note = noteOfRef(params.get('p1') ?? '')
      live.delete(burned)
      spent.add(burned)
      live.set(note, amountMsat)
      return json(route, {
        status: 'OK',
        c: encodeCs1WithAmount(
          amountMsat,
          signAsMint(`LNURLcash:${amountMsat}:${note}`)
        ),
        r: encodeCr1WithAmount(
          amountMsat,
          signAsMint(`LNURLcash:rotate:${amountMsat}:${burned}:${note}`)
        )
      })
    }
    return route.fulfill({status: 404})
  })
  return {live, spent}
}

const receiveSourceNote = async (page: Page) => {
  await page
    .getByPlaceholder('Note, invoice, or Lightning Address...')
    .locator('visible=true')
    .first()
    .fill(`${MINT}/w?k1=${SOURCE_K1}&amount=${AMOUNT_MSAT}`)
  await page.keyboard.press('Enter')
  await expect(page.locator('.bearer-card')).toHaveCount(1)
}

const openSeals = async (page: Page) => {
  await page.goto('/#/settings')
  const experimental = page.getByRole('button', {name: /Experimental addons/})
  if (!(await experimental.getAttribute('class'))?.includes('active')) {
    await experimental.click()
  }
  await enableAddon(page, 'Seals')
  await page.goto('/#/addons/seals')
  await expect(page.getByText('Issue a new seal')).toBeVisible()
}

const cp1Of = (pubkeyHex: string): string => encodeCp1(hexToBytes(pubkeyHex))

const fileOf = (name: string, bytes: Uint8Array) => ({
  name,
  mimeType: 'image/png',
  buffer: Buffer.from(bytes)
})

const downloaded = async (
  page: Page,
  buttonName: string
): Promise<{download: Download; bytes: Uint8Array}> => {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', {name: buttonName}).click()
  ])
  return {download, bytes: new Uint8Array(readFileSync(await download.path()))}
}

// loads a picture into "Manage" and takes the consignment it carries
const manage = async (page: Page, bytes: Uint8Array) => {
  await page
    .getByLabel(/^Load a picture that carries a seal/)
    .setInputFiles(fileOf('loaded.png', bytes))
  await page
    .getByRole('button', {name: 'Use this picture’s consignment'})
    .click()
  await expect(page.getByText(/^✓ Valid history - Test Card #17/)).toBeVisible()
}

test('a picture seal: issued, read out of its file, handed on as a bearer picture, claimed', async ({
  page
}) => {
  await setUpWallet(page)
  const mint = await mockMint(page)
  await receiveSourceNote(page)
  await openSeals(page)

  // ---- issue, with a picture
  await page.getByLabel('Asset name').fill('Test Card #17')
  await page.getByLabel('Description (optional)').fill('600B-E1#17')
  await page
    .getByLabel(/^Picture \(optional\)/)
    .setInputFiles(fileOf('card.png', PICTURE))
  await expect(page.locator('img.addon-image')).toBeVisible()
  await expect(page.locator('img.addon-image')).toHaveAttribute(
    'src',
    /^data:image\/png;base64,/
  )
  await page
    .getByLabel(/^Their Lightning Address/)
    .fill(cp1Of(ISSUER.pubkeyHex))
  await page.getByLabel(/^Note to lock/).selectOption({index: 1})
  await page.getByRole('button', {name: 'Resolve owner pubkey'}).click()
  await expect(
    page.getByText(`Owner pubkey: ${ISSUER.pubkeyHex}`)
  ).toBeVisible()
  await page.getByRole('button', {name: 'Prepare'}).click()
  await expect(
    page.getByText(`Asset id (the picture’s own sha256): ${PICTURE_HASH}`)
  ).toBeVisible()
  await page.getByRole('button', {name: 'Issue', exact: true}).click()
  await expect(page.getByText('✓ Seal issued')).toBeVisible()

  const issued = await downloaded(page, 'Download picture with consignment')
  expect(issued.download.suggestedFilename()).toBe('test-card-17.seal.png')
  // the file is the picture, untouched, plus the consignment
  expect(stripSealEnvelope(issued.bytes)!.picture).toEqual(PICTURE)
  const issuedEnvelope = sealEnvelopeOf(issued.bytes)!
  expect(issuedEnvelope.claimSecretKeyHex).toBeUndefined()
  const genesis = decodeSealConsignment(issuedEnvelope.consignment)!
  expect(genesis.states).toHaveLength(1)
  expect(genesis.states[0]).toMatchObject({
    assetId: PICTURE_HASH,
    name: 'Test Card #17',
    description: '600B-E1#17',
    ownerPubkeyHex: ISSUER.pubkeyHex
  })
  expect(genesis.amountMsat).toBe(AMOUNT_MSAT)
  // the wallet's own note is gone into the seal
  expect(mint.live.size).toBe(1)

  // ---- manage: read the seal back out of that file
  await page
    .getByLabel(/^Load a picture that carries a seal/)
    .setInputFiles(fileOf('test-card-17.seal.png', issued.bytes))
  await expect(
    page.getByText('This picture carries a seal’s consignment.')
  ).toBeVisible()
  await page
    .getByRole('button', {name: 'Use this picture’s consignment'})
    .click()
  await expect(
    page.getByText('✓ Valid history - Test Card #17 - 600B-E1#17')
  ).toBeVisible()
  await expect(
    page.getByText(/^✓ This file is the picture the seal was issued for/)
  ).toBeVisible()
  // the mint it names is on screen before anything is asked of it
  await expect(
    page.getByText(`This consignment says the seal lives at ${MINT_HOST}.`, {
      exact: false
    })
  ).toBeVisible()
  await page.getByRole('button', {name: 'Check at the mint'}).click()
  await expect(page.getByText(`Asked ${MINT_HOST}.`)).toBeVisible()
  // this wallet holds a key for that mint, pinned when its note arrived
  await expect(
    page.getByText(new RegExp(`^✓ Live at ${MINT_HOST.replace(/\./g, '\\.')}`))
  ).toBeVisible()
  await expect(page.getByText(/^Never transferred/)).toBeVisible()

  // ---- hand it on as a bearer picture
  await page
    .getByLabel('Your secret key (32-byte hex)')
    .fill(ISSUER.secretKeyHex)
  await page.getByRole('button', {name: 'Make a one-time key'}).click()
  await expect(
    page.getByText(/^One-time secret key: [0-9a-f]{64}$/)
  ).toBeVisible()
  // one key per page: a second would replace the only key to a seal that
  // is about to move to the first
  await expect(
    page.getByRole('button', {name: 'Make a one-time key'})
  ).toHaveCount(0)
  await page
    .getByRole('button', {name: 'Move the seal to the one-time key'})
    .click()
  await expect(page.getByText('✓ Transitioned')).toBeVisible()
  // the seal has moved: nothing on this page can move it again, and the
  // check made before it is no longer shown as current
  await expect(page.getByLabel('Your secret key (32-byte hex)')).toHaveCount(0)
  await expect(
    page.getByRole('button', {name: 'Move the seal to the one-time key'})
  ).toHaveCount(0)
  await expect(page.getByText(`Asked ${MINT_HOST}.`)).toHaveCount(0)
  await expect(
    page.getByText(/^✓ The mint certified this transition/)
  ).toBeVisible()
  await expect(page.getByText(/BEARER picture/)).toBeVisible()
  await page.screenshot({
    path: test.info().outputPath('bearer-picture.png'),
    fullPage: true
  })

  const bearer = await downloaded(
    page,
    'Download picture with the new consignment'
  )
  expect(stripSealEnvelope(bearer.bytes)!.picture).toEqual(PICTURE)
  const bearerEnvelope = sealEnvelopeOf(bearer.bytes)!
  expect(bearerEnvelope.claimSecretKeyHex).toMatch(/^[0-9a-f]{64}$/)
  const afterFirst = decodeSealConsignment(bearerEnvelope.consignment)!
  expect(afterFirst.states).toHaveLength(2)
  expect(afterFirst.certificates).toHaveLength(1)
  // certified by the mint, checked here outside the wallet
  expect(sealCertificateProblem(afterFirst, MINT_PUBKEY)).toBe('')

  // ---- someone else holds the file now: a fresh page, nothing but the picture
  await page.reload()
  await expect(page.getByText('Manage or verify a seal')).toBeVisible()
  await page
    .getByLabel(/^Load a picture that carries a seal/)
    .setInputFiles(fileOf('test-card-17.seal.png', bearer.bytes))
  await expect(page.getByText(/a bearer picture\. Whoever holds/)).toBeVisible()
  await page
    .getByRole('button', {name: 'Use this picture’s consignment'})
    .click()
  await expect(page.getByText(/^✓ Valid history - Test Card #17/)).toBeVisible()
  await page
    .getByRole('button', {name: 'Use the key this picture carries'})
    .click()
  await page.getByLabel('Next owner’s address').fill(cp1Of(BUYER.pubkeyHex))
  await page.getByRole('button', {name: 'Resolve next owner pubkey'}).click()
  await expect(page.getByText(`Next owner: ${BUYER.pubkeyHex}`)).toBeVisible()
  await page.getByRole('button', {name: 'Transition', exact: true}).click()
  await expect(page.getByText('✓ Transitioned')).toBeVisible()
  await expect(
    page.getByText(/^✓ The mint certified this transition/)
  ).toBeVisible()

  const claimed = await downloaded(
    page,
    'Download picture with the new consignment'
  )
  expect(stripSealEnvelope(claimed.bytes)!.picture).toEqual(PICTURE)
  const claimedEnvelope = sealEnvelopeOf(claimed.bytes)!
  // named now: the buyer's own key is nowhere but with the buyer
  expect(claimedEnvelope.claimSecretKeyHex).toBeUndefined()
  const afterSecond = decodeSealConsignment(claimedEnvelope.consignment)!
  expect(afterSecond.states).toHaveLength(3)
  expect(afterSecond.states[2]!.ownerPubkeyHex).toBe(BUYER.pubkeyHex)
  expect(afterSecond.states[0]!.assetId).toBe(PICTURE_HASH)
  expect(sealCertificateProblem(afterSecond, MINT_PUBKEY)).toBe('')
  // one note in, one note out, every time - the received note, the wallet's
  // own, the genesis, the bearer state: four burned, exactly one live
  expect(mint.live.size).toBe(1)
  expect(mint.spent.size).toBe(4)

  // ---- what the mint says about each file now
  await manage(page, claimed.bytes)
  await page.getByRole('button', {name: 'Check at the mint'}).click()
  await expect(page.getByText(/^✓ Live at mint-seals/)).toBeVisible()
  await expect(
    page.getByText(/^✓ Every one of its 2 transition\(s\) is certified/)
  ).toBeVisible()
  await page.screenshot({
    path: test.info().outputPath('claimed-picture.png'),
    fullPage: true
  })

  // the bearer picture is a copy of a key that already moved the seal
  await manage(page, bearer.bytes)
  await page.getByRole('button', {name: 'Check at the mint'}).click()
  await expect(
    page.getByText(/^✗ Its current note is already spent/)
  ).toBeVisible()
})

test('a picture that is not the seal’s own is told apart from the one that is', async ({
  page
}) => {
  await setUpWallet(page)
  await mockMint(page)
  await receiveSourceNote(page)
  await openSeals(page)

  await page.getByLabel('Asset name').fill('Test Card #17')
  await page
    .getByLabel(/^Picture \(optional\)/)
    .setInputFiles(fileOf('card.png', PICTURE))
  await page
    .getByLabel(/^Their Lightning Address/)
    .fill(cp1Of(ISSUER.pubkeyHex))
  await page.getByLabel(/^Note to lock/).selectOption({index: 1})
  await page.getByRole('button', {name: 'Resolve owner pubkey'}).click()
  await page.getByRole('button', {name: 'Prepare'}).click()
  await page.getByRole('button', {name: 'Issue', exact: true}).click()
  await expect(page.getByText('✓ Seal issued')).toBeVisible()
  const consignment = sealEnvelopeOf(
    (await downloaded(page, 'Download picture with consignment')).bytes
  )!.consignment

  // the same seal, pasted, next to a different picture
  await page.getByLabel('Consignment', {exact: true}).fill(consignment)
  await page
    .getByLabel(/^Load a picture that carries a seal/)
    .setInputFiles(fileOf('other.png', makePng(64, 64)))
  await expect(page.getByText('This picture carries no seal.')).toBeVisible()
  await expect(
    page.getByText(/^✗ This is not the picture the seal/)
  ).toBeVisible()
  // and no way to put this seal into that file
  await page
    .getByLabel('Your secret key (32-byte hex)')
    .fill(ISSUER.secretKeyHex)
  await expect(page.getByLabel('Next owner’s address')).toBeVisible()
  await expect(
    page.getByRole('button', {name: 'Make a one-time key'})
  ).toHaveCount(0)

  // a JPG that carries this seal: the browser still shows it as the
  // picture it is, the seal is read out of it - and it is not the PNG the
  // seal was issued for
  await page.getByLabel(/^Load a picture that carries a seal/).setInputFiles({
    name: 'card.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from(embedSealEnvelope(JPG, consignment))
  })
  await expect(
    page.getByText('This picture carries a seal’s consignment.')
  ).toBeVisible()
  const shown = page.locator('img.addon-image')
  await expect(shown).toHaveAttribute('src', /^data:image\/jpeg;base64,/)
  expect(
    await shown.evaluate(img => {
      const image = img as HTMLImageElement
      return [image.complete, image.naturalWidth, image.naturalHeight]
    })
  ).toEqual([true, 8, 8])
  await expect(
    page.getByText(/^✗ This is not the picture the seal/)
  ).toBeVisible()

  // a file over the picker's limit is refused, whatever it is
  const tooLarge = Buffer.alloc(8 * 1024 * 1024 + 1)
  tooLarge.set(PICTURE)
  await page.getByLabel(/^Load a picture that carries a seal/).setInputFiles({
    name: 'huge.png',
    mimeType: 'image/png',
    buffer: tooLarge
  })
  await expect(
    page.getByText('That picture is too large - 8 MB at most.')
  ).toBeVisible()
  await expect(page.locator('img.addon-image')).toHaveCount(0)

  // something that is no picture at all is refused at the picker
  await page.getByLabel(/^Load a picture that carries a seal/).setInputFiles({
    name: 'card.png',
    mimeType: 'image/png',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
  })
  await expect(page.getByText('Pick a JPG or PNG picture.')).toBeVisible()
  await expect(page.locator('img.addon-image')).toHaveCount(0)
})
