import {test, expect} from '@playwright/test'

test('seed, Lightning address change, offline settings and original backups work in the shell', async ({
  page
}, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/wallet')
  const wallet = page.frameLocator('#wallet')
  const seed = await wallet.getByLabel('BIP39 recovery phrase').inputValue()
  expect(seed.split(' ')).toHaveLength(12)
  await wallet
    .getByLabel('Wallet password', {exact: true})
    .fill('test wallet password')
  await wallet.getByLabel('Repeat password').fill('test wallet password')
  await wallet.getByLabel('I have saved my recovery phrase').check()
  await wallet.getByRole('button', {name: 'Create wallet'}).click()
  await expect(
    wallet.getByRole('button', {name: 'Receive', exact: true})
  ).toBeEnabled()
  await page.getByRole('button', {name: 'Receive demo note'}).click()
  await wallet.getByRole('button', {name: 'Review details'}).click()
  await wallet.getByRole('button', {name: 'Confirm receive'}).click()
  await expect(wallet.locator('.status.ready')).toHaveCount(1)
  await wallet
    .getByRole('checkbox', {name: 'Select 21 sats ready', exact: true})
    .check()
  await wallet.getByLabel('Note label').fill('Weekend sats')
  await wallet.getByRole('button', {name: 'Save label'}).click()
  await expect(wallet.locator('.note-label')).toHaveText('Weekend sats')

  await wallet.getByRole('button', {name: 'Pay', exact: true}).click()
  await wallet.getByText('Pay a Lightning address', {exact: true}).click()
  await wallet
    .getByLabel('Lightning address or LNURL-pay')
    .fill('https://demo.mint.test/pay')
  await wallet.getByLabel('Payment amount (sats)', {exact: true}).fill('7')
  await wallet.getByRole('button', {name: 'Get invoice for review'}).click()
  await expect(wallet.getByLabel('BOLT11 invoice', {exact: true})).toHaveValue(
    'lnbc70n1qqqq'
  )
  await wallet.getByRole('button', {name: 'Prepare exact payment note'}).click()
  await expect(wallet.getByRole('status')).toContainText(
    'Exact payment note prepared'
  )
  await wallet
    .getByRole('button', {name: 'Confirm payment', exact: true})
    .click()
  await expect(wallet.locator('.status.ready')).toHaveCount(1)
  await expect(
    wallet.getByRole('checkbox', {name: 'Select 14 sats ready', exact: true})
  ).toBeVisible()

  await wallet.getByLabel('More wallet tools').selectOption('settings')
  await wallet.getByLabel('Offline mode', {exact: true}).check()
  await wallet.getByLabel('Auto-lock', {exact: true}).selectOption('1')
  await wallet.getByLabel('Sort notes', {exact: true}).selectOption('amount')
  await wallet.getByLabel('Group by mint', {exact: true}).uncheck()
  const calls = () =>
    page.evaluate(
      () =>
        (window as any).hostCalls.filter(
          (entry: any) => entry.type === 'resource.bytes'
        ).length
    )
  const before = await calls()
  await wallet.getByRole('button', {name: 'Mint', exact: true}).click()
  await wallet
    .getByLabel('Mint URL or Lightning address', {exact: true})
    .fill('https://demo.mint.test/pay')
  await wallet.getByLabel('Amount (sats)', {exact: true}).fill('9')
  await wallet
    .getByRole('button', {name: 'Create funding invoice', exact: true})
    .click()
  await expect(wallet.getByRole('status')).toContainText('Offline mode')
  expect(await calls()).toBe(before)
  await wallet.getByLabel('More wallet tools').selectOption('settings')
  await wallet.getByLabel('Offline mode', {exact: true}).uncheck()
  await expect(wallet.getByLabel('More wallet tools')).toBeEnabled()
  await page.screenshot({
    path: `test-results/wallet-tools-${testInfo.project.name}.png`,
    fullPage: true
  })
  const frame = page.frames().find(frame => frame.url() === 'about:srcdoc')!
  expect(
    await frame.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1
    )
  ).toBe(true)

  await wallet.getByLabel('More wallet tools').selectOption('recovery')
  await wallet.getByLabel('Recovery mint').fill('https://demo.mint.test/pay')
  await wallet.getByRole('button', {name: 'Scan mint for notes'}).click()
  await expect(wallet.getByRole('status')).toContainText('Recovered 0 notes')
  await wallet.getByRole('button', {name: 'Backup', exact: true}).click()
  await wallet
    .getByLabel('Webwallet backup password', {exact: true})
    .fill('test wallet password')
  await wallet
    .getByRole('button', {name: 'Export for webwallet', exact: true})
    .click()
  const backup = await wallet
    .getByLabel('Compatible encrypted backup')
    .inputValue()
  expect(JSON.parse(backup).type).toBe('lnurlwallet-backup')
  expect(backup).not.toContain(seed)
  await wallet.getByLabel('Original webwallet backup JSON').fill(backup)
  await wallet
    .getByLabel('Webwallet backup password', {exact: true})
    .fill('test wallet password')
  await wallet.getByLabel('I trust the source of this backup').check()
  await wallet
    .getByRole('button', {name: 'Import webwallet backup', exact: true})
    .click()
  await expect(wallet.getByRole('status')).toContainText('Imported 0 notes')
  await wallet.getByLabel('More wallet tools').selectOption('device')
  await expect(
    wallet.getByText('This shell does not expose USB or Bluetooth.', {
      exact: false
    })
  ).toBeVisible()
  await wallet.getByRole('button', {name: 'Lock wallet'}).click()
  await wallet.getByLabel('Reset password with my seed').check()
  await wallet.getByLabel('Recovery phrase', {exact: true}).fill(seed)
  await wallet
    .getByLabel('Wallet password', {exact: true})
    .fill('new test wallet password')
  await wallet
    .getByLabel('Repeat new password')
    .fill('new test wallet password')
  await wallet.getByRole('button', {name: 'Reset password and unlock'}).click()
  await expect(wallet.getByRole('button', {name: 'Lock wallet'})).toBeVisible()
  await wallet.getByLabel('More wallet tools').selectOption('settings')
  await expect(wallet.getByLabel('Auto-lock', {exact: true})).toHaveValue('1')
  expect(errors).toEqual([])
})
