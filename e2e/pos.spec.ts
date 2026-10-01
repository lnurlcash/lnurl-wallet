import {test, expect} from '@playwright/test'

import {setUpWallet, enableAddon} from './helpers'

const MINT = 'https://pos-mint.test'
const PR = 'lnbc1pexampleinvoice'
const VERIFY = `${MINT}/verify/${'ab'.repeat(32)}`

test.describe('Point of Sale addon', () => {
  test('charges a keypad amount to a registered address and shows it paid', async ({
    page
  }) => {
    await setUpWallet(page)
    // registering a username at a mint is its own (signed) flow - this
    // test is about the till, so it seeds the registry record directly
    await page.evaluate(
      mint =>
        localStorage.setItem(
          'lnurlcash_registered_addresses',
          JSON.stringify([{server: mint, username: 'shop', registeredAt: 0}])
        ),
      MINT
    )
    // addressRegistry.ts reads storage once, at load - a hash navigation
    // alone would never see the seeded record
    await page.reload()
    await enableAddon(page, 'Point of Sale')

    const callbacks: URL[] = []
    let verifyCalls = 0
    await page.route(`${MINT}/**`, route => {
      const url = new URL(route.request().url())
      const json = (body: unknown) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(body)
        })
      if (url.pathname === '/.well-known/lnurlp/shop') {
        return json({
          tag: 'payRequest',
          callback: `${MINT}/p/shop`,
          minSendable: 1000,
          maxSendable: 100_000_000,
          metadata: '[["text/plain", "pay shop"]]'
        })
      }
      if (url.pathname === '/p/shop') {
        callbacks.push(url)
        return json({pr: PR, verify: VERIFY, routes: []})
      }
      if (url.toString() === VERIFY) {
        verifyCalls++
        return json({settled: verifyCalls > 1, preimage: null, pr: PR})
      }
      // the post-payment note scan - not what this test is about
      return route.fulfill({status: 404, body: ''})
    })

    await page.goto('/#/addons/pos')
    await page.getByLabel('Receive to').selectOption('shop@pos-mint.test')
    for (const key of ['2', '1', '0', '0']) {
      await page
        .locator('.addon-keypad')
        .getByRole('button', {name: key})
        .click()
    }
    await expect(page.locator('.addon-pos-amount')).toHaveText('2,100 sats')

    await page.getByRole('button', {name: 'Charge 2,100 sats'}).click()
    await expect(
      page.getByText('Waiting for payment to shop@pos-mint.test...')
    ).toBeVisible()
    await expect(page.getByRole('button', {name: 'Copy invoice'})).toBeVisible()
    expect(callbacks[0]?.searchParams.get('amount')).toBe('2100000')

    // first verify answers unpaid, the next poll settles
    await expect(page.locator('.addon-pos-paid')).toHaveText(
      'Paid: 2,100 sats',
      {timeout: 15_000}
    )
    await expect(page.locator('.addon-error')).toHaveCount(0)

    await page.getByRole('button', {name: 'New sale'}).click()
    await expect(page.locator('.addon-keypad')).toBeVisible()
  })
})
