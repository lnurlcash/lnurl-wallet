import {test, expect} from '@playwright/test'
import {artwork} from './artwork'

test('wallet runs alone: encrypted notes, design import and payments', async ({
  page
}, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/wallet')
  await expect(page).toHaveTitle('LNURLcash Wallet · local preview')
  await expect(page.locator('iframe')).toHaveCount(1)
  await expect(page.locator('#notes, #wallet-tab, #designer-tab')).toHaveCount(
    0
  )
  const wallet = page.frameLocator('#wallet')
  await expect(
    wallet.getByRole('heading', {name: 'A home for your sats.'})
  ).toBeVisible()
  await wallet
    .getByLabel('Wallet password', {exact: true})
    .fill('test wallet password')
  await wallet.getByLabel('Repeat password').fill('test wallet password')
  await wallet.getByLabel('I have saved my recovery phrase').check()
  await wallet.getByRole('button', {name: 'Create wallet'}).click()
  await expect(wallet.getByRole('heading', {name: 'Your notes'})).toBeVisible()
  const frame = page
    .frames()
    .find(frame => frame.name() === 'wallet' || frame.url() === 'about:srcdoc')!
  expect(
    await frame.evaluate(() => {
      try {
        window.localStorage.getItem('test')
        return false
      } catch {
        return true
      }
    })
  ).toBe(true)
  await page.getByRole('button', {name: 'Receive demo note'}).click()
  await expect(wallet.getByRole('dialog')).toBeVisible()
  expect(
    await page.evaluate(
      () =>
        (window as any).hostCalls.filter(
          (c: any) => c.type === 'resource.bytes'
        ).length
    )
  ).toBe(0)
  await wallet.getByRole('button', {name: 'Review details'}).click()
  await expect(wallet.getByLabel('LNURLcash note')).toHaveValue(
    /https:\/\/demo\.mint\.test/
  )
  await wallet.getByRole('button', {name: 'Confirm receive & rotate'}).click()
  await expect(wallet.locator('.status.ready')).toHaveCount(1)
  await expect(wallet.locator('.banknote')).toHaveCount(1)
  const raw = await page.evaluate(() =>
    [...(window as any).hostStores.wallet.values()].join('')
  )
  expect(raw).not.toContain('abababababababab')
  expect(raw).not.toContain('demo.mint.test')
  await expect(
    wallet.getByRole('button', {name: /Open Paper Studio|Design notes/})
  ).toHaveCount(0)
  await wallet.getByRole('button', {name: 'Import design'}).click()
  await wallet.getByLabel('Design JSON', {exact: true}).fill(
    JSON.stringify({
      title: 'TWENTY ONE CLUB',
      subtitle: 'Whoever holds the note holds the sats.',
      ink: '#743e29',
      paper: '#f4dfc4',
      image: await artwork(page)
    })
  )
  await wallet.getByRole('button', {name: 'Apply design'}).click()
  await expect(wallet.locator('.banknote-heading').first()).toHaveText(
    'TWENTY ONE CLUB'
  )
  await expect(wallet.locator('.banknote-art')).toHaveCount(1)
  expect(
    await frame.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true)
  await page.screenshot({
    path: `test-results/wallet-${testInfo.project.name}.png`,
    fullPage: true
  })
  await wallet.getByRole('button', {name: 'Lock wallet'}).click()
  await expect(
    wallet.getByRole('heading', {name: 'Welcome back.'})
  ).toBeVisible()
  await page.evaluate(() => (window as any).reloadNapplet())
  await wallet
    .getByLabel('Wallet password', {exact: true})
    .fill('test wallet password')
  await wallet.getByRole('button', {name: 'Unlock wallet'}).click()
  await expect(wallet.locator('.banknote-heading').first()).toHaveText(
    'TWENTY ONE CLUB'
  )
  await wallet
    .getByRole('checkbox', {name: 'Select 21 sats ready', exact: true})
    .check()
  await wallet.getByLabel('Split amount (sats)', {exact: true}).fill('7')
  await wallet
    .getByRole('button', {name: 'Split selected', exact: true})
    .click()
  await expect(wallet.locator('.status.ready')).toHaveCount(2)
  await wallet
    .getByRole('checkbox', {name: 'Select 7 sats ready', exact: true})
    .check()
  await wallet
    .getByRole('checkbox', {name: 'Select 14 sats ready', exact: true})
    .check()
  await wallet.getByRole('button', {name: 'Combine', exact: true}).click()
  await expect(wallet.locator('.status.ready')).toHaveCount(1)
  await wallet.getByRole('button', {name: 'Pay', exact: true}).click()
  await wallet.getByLabel('BOLT11 invoice', {exact: true}).fill('lnbc210n1qqqq')
  await wallet
    .getByLabel('Note to spend', {exact: true})
    .selectOption({label: '21 sats · demo.mint.test'})
  await wallet
    .getByRole('button', {name: 'Confirm payment', exact: true})
    .click()
  await expect(wallet.locator('.status.pending')).toHaveCount(1)
  await expect(wallet.getByRole('status')).toContainText(
    'Settlement is not yet confirmed'
  )
  await wallet.getByRole('button', {name: 'Mint', exact: true}).click()
  await wallet
    .getByLabel('Mint URL or Lightning address', {exact: true})
    .fill('https://demo.mint.test/pay')
  await wallet.getByLabel('Amount (sats)', {exact: true}).fill('31')
  await wallet
    .getByRole('button', {name: 'Create funding invoice', exact: true})
    .click()
  await expect(wallet.getByLabel('Funding invoice', {exact: true})).toHaveValue(
    'lnbc310n1qqqq'
  )
  await wallet.getByRole('button', {name: 'Wallet', exact: true}).click()
  await wallet
    .getByRole('checkbox', {name: 'Select 31 sats pending', exact: true})
    .check()
  await wallet
    .getByRole('button', {name: 'Check selected', exact: true})
    .click()
  await expect(wallet.locator('.status.ready')).toHaveCount(1)
  await wallet
    .getByRole('checkbox', {name: 'Select 31 sats ready', exact: true})
    .check()
  await wallet.getByRole('button', {name: 'Hand over', exact: true}).click()
  await expect(
    wallet.getByLabel('Bearer note for handover', {exact: true})
  ).toHaveValue(/https:\/\/demo\.mint\.test/)
  await expect(wallet.locator('.status.ready')).toHaveCount(0)
  expect(
    await page.evaluate(() =>
      (window as any).hostCalls.some((call: any) =>
        call.type.startsWith('intent.')
      )
    )
  ).toBe(false)
  expect(errors).toEqual([])
})

test('refuses an ephemeral standalone wallet', async ({page}) => {
  await page.goto('/raw-wallet')
  await expect(page.getByRole('alert')).toContainText(
    'Open this wallet in a napplet shell'
  )
  await expect(page.getByRole('button', {name: 'Create wallet'})).toHaveCount(0)
})
