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
})
