import {test, expect} from '@playwright/test'

import {setUpWallet} from './helpers'

// LUD-26: an address registered before the upgrade (no share on file) is
// flagged app-wide, and on the Addresses page with the way to move it
test.describe('LUD-26 migration warnings', () => {
  test('flags a pre-LUD-26 address and points to moving it', async ({page}) => {
    await setUpWallet(page)
    await page.evaluate(() => {
      localStorage.setItem(
        'lnurlcash_trusted_mints',
        JSON.stringify([
          {
            server: 'https://old-mint.test',
            addedAt: 0,
            locked: false,
            mintPubkey: `02${'11'.repeat(32)}`
          }
        ])
      )
      localStorage.setItem(
        'lnurlcash_registered_addresses',
        JSON.stringify([
          {server: 'https://old-mint.test', username: 'bob', registeredAt: 0}
        ])
      )
    })
    // the registries read storage once, at load
    await page.reload()

    await page.goto('/#/settings')
    const banner = page.locator('.migration-banner')
    await expect(banner).toContainText(
      '1 Lightning Address is still on the old keys'
    )

    await banner.getByRole('link', {name: 'Addresses'}).click()
    // the page carries its own version instead
    await expect(page.locator('.migration-banner')).toHaveCount(0)
    await expect(page.locator('#address')).toContainText(
      'registered before the LUD-26 upgrade'
    )
    await expect(
      page.getByRole('button', {name: 'Move to a new key'})
    ).toBeVisible()
  })

  test('can be dismissed for the session', async ({page}) => {
    await setUpWallet(page)
    await page.evaluate(() =>
      localStorage.setItem(
        'lnurlcash_registered_addresses',
        JSON.stringify([
          {server: 'https://old-mint.test', username: 'bob', registeredAt: 0}
        ])
      )
    )
    await page.reload()
    await page.goto('/#/settings')
    await page.locator('.migration-banner-close').click()
    await expect(page.locator('.migration-banner')).toHaveCount(0)
    await page.goto('/#/mint')
    await expect(page.locator('.migration-banner')).toHaveCount(0)
  })

  // the mint already holds share 0 (a move it accepted that this device
  // never saved); only a proof by share 0's key is accepted
  test('a move finds the key actually on file', async ({page}) => {
    const puts: string[] = []
    let accepted = false
    await page.route('https://old-mint.test/**', async route => {
      const req = route.request()
      if (req.method() === 'PUT') {
        const n = puts.push(req.postData() ?? '')
        // the recorded legacy key, its 10 slots, then shares 0, 1, ...: 1 legacy(recorded) ... the 13th candidate (share 1) passes
        const ok = n === 13
        if (ok) accepted = true
        return route.fulfill({
          status: ok ? 200 : 400,
          contentType: 'application/json',
          headers: {'access-control-allow-origin': '*'},
          body: JSON.stringify(
            ok
              ? {status: 'OK'}
              : {status: 'ERROR', reason: 'Invalid ownership signature.'}
          )
        })
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {'access-control-allow-origin': '*'},
        body: '{"status":"OK"}'
      })
    })
    await setUpWallet(page)
    await page.evaluate(() => {
      localStorage.setItem(
        'lnurlcash_trusted_mints',
        JSON.stringify([
          {
            server: 'https://old-mint.test',
            addedAt: 0,
            locked: false,
            mintPubkey: `02${'11'.repeat(32)}`
          }
        ])
      )
      localStorage.setItem(
        'lnurlcash_registered_addresses',
        JSON.stringify([
          {
            server: 'https://old-mint.test',
            username: 'bob',
            registeredAt: 0,
            nextScanIndex: 5
          }
        ])
      )
    })
    await page.reload()
    await page.goto('/#/address')
    await page.getByRole('button', {name: 'Move to a new key'}).first().click()
    await page
      .locator('.dialog, dialog')
      .getByRole('button', {name: 'Move to a new key'})
      .click()
    await expect.poll(() => accepted, {timeout: 15000}).toBe(true)
    await page.waitForTimeout(500)
    const stored = JSON.parse(
      (await page.evaluate(() =>
        localStorage.getItem('lnurlcash_registered_addresses')
      ))!
    )

    expect(stored[0].share).toBeDefined()
    expect(stored[0].retired).toEqual([
      {kind: 'legacy'},
      {kind: 'share', share: 1}
    ])
    await expect(page.getByText('Still on the pre-LUD-26 keys')).toHaveCount(0)
  })
})
