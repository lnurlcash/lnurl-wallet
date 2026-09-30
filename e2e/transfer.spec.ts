import {test, expect, type Page, type Route} from '@playwright/test'
import {schnorr, secp256k1} from '@noble/curves/secp256k1.js'
import {bytesToHex} from '@noble/hashes/utils.js'

import {encodeCx1} from '../src/lib/recoverableNotes'
import {setUpWallet} from './helpers'

// Transferring a note to someone's registered Lightning Address (a payRequest
// advertising LUD-25's `text/cpub`) is a payment, not a move between mints:
// the recipient's mint always auto-mints onto the owner's own branch, so
// TransferDialog must request the invoice WITHOUT a comment (and without
// requiring commentAllowed, which such an address doesn't advertise), melt
// the source note to pay it, and finish once the payment is confirmed -
// there is no destination note for this wallet to claim.

const SOURCE = 'https://mint-a.example.test'
const DEST = 'https://mint-b.example.test'
const ADDRESS = 'alice@mint-b.example.test'
const AMOUNT_MSAT = 10_000
const INVOICE = 'lnbcmocktransfer'
const SOURCE_MINT_PUBKEY = bytesToHex(
  secp256k1.getPublicKey(new Uint8Array(32).fill(9), true)
)
const CX1 = encodeCx1(
  schnorr.getPublicKey(new Uint8Array(32).fill(7)),
  new Uint8Array(32).fill(0x22)
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

// a minimal source mint: one note that accepts a rotate (the receive flow's
// own secret refresh) until it's melted, after which every k1 is spent
const mockSourceMint = async (page: Page) => {
  const state = {melted: null as string | null}
  await page.route(`${SOURCE}/**`, route => {
    const url = new URL(route.request().url())
    const params = url.searchParams
    if (url.pathname === '/w') {
      if (state.melted && params.has('k1')) {
        return json(route, {status: 'ERROR', reason: 'Note already spent.'})
      }
      return json(route, {
        tag: 'withdrawRequest',
        callback: `${SOURCE}/w/cb`,
        ...(params.get('k1') ? {k1: params.get('k1')} : {}),
        minWithdrawable: AMOUNT_MSAT,
        maxWithdrawable: AMOUNT_MSAT,
        defaultDescription: 'test note',
        mintPubkey: SOURCE_MINT_PUBKEY
      })
    }
    if (url.pathname === '/w/cb') {
      if (state.melted) {
        return json(route, {status: 'ERROR', reason: 'Note already spent.'})
      }
      if (params.has('pr')) state.melted = params.get('pr')
      return json(route, {status: 'OK'})
    }
    return route.fulfill({status: 404})
  })
  return state
}

// the recipient's mint: a registered username's payRequest - text/cpub in
// its metadata, no commentAllowed - and its pay callback
const mockDestinationAddress = async (
  page: Page,
  source: {melted: string | null},
  {withVerify}: {withVerify: boolean}
) => {
  const payCallbacks: URL[] = []
  await page.route(`${DEST}/**`, route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/.well-known/lnurlp/alice') {
      return json(route, {
        tag: 'payRequest',
        callback: `${DEST}/p/alice`,
        minSendable: 1000,
        maxSendable: 100_000_000,
        metadata: JSON.stringify([
          [
            'text/plain',
            'Mint an lnurlcash bearer note on mint-b.example.test'
          ],
          ['text/identifier', ADDRESS],
          ['text/cpub', `${CX1}:0`]
        ]),
        withdrawLink: `${DEST}/w`
      })
    }
    if (url.pathname === '/p/alice') {
      payCallbacks.push(url)
      return json(route, {
        pr: INVOICE,
        ...(withVerify ? {verify: `${DEST}/verify/1`} : {})
      })
    }
    if (url.pathname === '/verify/1') {
      return json(route, {
        status: 'OK',
        settled: source.melted === INVOICE,
        preimage: null,
        pr: INVOICE
      })
    }
    return route.fulfill({status: 404})
  })
  return payCallbacks
}

const receiveSourceNote = async (page: Page) => {
  const k1 = 'ab'.repeat(32)
  await page
    .getByPlaceholder('Note, invoice, or Lightning Address...')
    .locator('visible=true')
    .first()
    .fill(`${SOURCE}/w?k1=${k1}&amount=${AMOUNT_MSAT}`)
  await page.keyboard.press('Enter')
  await expect(page.locator('.bearer-card')).toHaveCount(1)
}

const transferToAddress = async (page: Page) => {
  await page.locator('.bearer-card').first().click()
  await page.locator('.transfer-btn').click()
  await page.getByPlaceholder('lnurl1... or mint@example.com').fill(ADDRESS)
  await page.getByRole('button', {name: 'Look up mint'}).click()
  await expect(
    page.getByRole('heading', {name: /to a Lightning Address/})
  ).toBeVisible()
  await expect(
    page.getByText(`to ${ADDRESS}? It lands as a note`)
  ).toBeVisible()
  await page.getByRole('button', {name: 'Confirm transfer'}).click()
}

test.describe('Transfer to a Lightning Address', () => {
  for (const withVerify of [true, false]) {
    test(`pays the advertised cpub without a comment and finishes without a claim (${
      withVerify ? 'confirmed by verify' : 'confirmed by the source burning'
    })`, async ({page}) => {
      await setUpWallet(page)
      const source = await mockSourceMint(page)
      const payCallbacks = await mockDestinationAddress(page, source, {
        withVerify
      })

      await receiveSourceNote(page)
      await transferToAddress(page)

      // one poll tick (TRANSFER_POLL_SECONDS) confirms it
      await expect(page.getByText(`Sent 10 sats to ${ADDRESS}.`)).toBeVisible({
        timeout: 15_000
      })

      expect(payCallbacks).toHaveLength(1)
      expect(payCallbacks[0].searchParams.get('amount')).toBe(
        String(AMOUNT_MSAT)
      )
      // the recipient's mint derives the output from its cpub - this wallet
      // must never name one
      expect(payCallbacks[0].searchParams.has('comment')).toBe(false)
      expect(source.melted).toBe(INVOICE)
    })
  }
})
