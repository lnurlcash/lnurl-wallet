import {test, expect} from '@playwright/test'
import {artwork} from './artwork'

test('pushes a design to a locked wallet without switching apps or importing silently', async ({
  context,
  page
}) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const receiver = await context.newPage()
  receiver.on('pageerror', error => errors.push(error.message))
  await receiver.goto('/wallet')
  const wallet = receiver.frameLocator('#wallet')
  await wallet
    .getByLabel('Wallet password', {exact: true})
    .fill('test wallet password')
  await wallet.getByLabel('Repeat password').fill('test wallet password')
  await wallet.getByLabel('I have saved my recovery phrase').check()
  await wallet.getByRole('button', {name: 'Create wallet'}).click()
  await expect(
    wallet.getByRole('button', {name: 'Receive', exact: true})
  ).toBeEnabled()
  await receiver.getByRole('button', {name: 'Receive demo note'}).click()
  await wallet.getByRole('button', {name: 'Review details'}).click()
  await wallet.getByRole('button', {name: 'Confirm receive & rotate'}).click()
  await expect(wallet.locator('.status.ready')).toHaveCount(1)
  await wallet.getByRole('button', {name: 'Lock wallet'}).click()
  const before = await receiver.evaluate(() =>
    JSON.stringify([...(window as any).hostStores.wallet])
  )
  await page.goto('/notes')
  await page.bringToFront()
  const notes = page.frameLocator('#notes')
  await notes.getByLabel('Note heading').fill('PUSHED FROM NOTES')
  await notes.getByLabel('Upload artwork').setInputFiles({
    name: 'portrait.png',
    mimeType: 'image/png',
    buffer: Buffer.from((await artwork(page)).split(',')[1], 'base64')
  })
  await expect(notes.locator('.banknote-art')).toBeVisible()
  await notes.getByRole('button', {name: 'Send to Wallet'}).click()
  await expect(notes.getByRole('status')).toContainText('sent for review')
  expect(await page.evaluate(() => document.hasFocus())).toBe(true)
  await expect(page).toHaveURL(/\/notes$/)
  await expect(receiver).toHaveURL(/\/wallet$/)
  expect(context.pages()).toHaveLength(2)
  await expect(page.locator('iframe')).toHaveCount(1)
  await expect(receiver.locator('iframe')).toHaveCount(1)
  await expect(wallet.getByRole('dialog')).toHaveCount(0)
  expect(
    await receiver.evaluate(() =>
      JSON.stringify([...(window as any).hostStores.wallet])
    )
  ).toBe(before)
  const sent = await page.evaluate(
    () =>
      (window as any).hostCalls.find(
        (call: any) => call.type === 'intent.invoke'
      ).request
  )
  expect(sent.behavior).toMatchObject({focus: false, reuse: true})
  expect(sent.payload.kind).toBe('lnurlcash/note-design')
  expect(sent.payload.version).toBe(1)
  expect(Object.keys(sent.payload.design).sort()).toEqual([
    'image',
    'ink',
    'paper',
    'subtitle',
    'title'
  ])
  await wallet
    .getByLabel('Wallet password', {exact: true})
    .fill('test wallet password')
  await wallet.getByRole('button', {name: 'Unlock wallet'}).click()
  await expect(
    wallet.getByRole('heading', {name: 'A new note design'})
  ).toBeVisible()
  expect(
    await receiver.evaluate(() =>
      JSON.stringify([...(window as any).hostStores.wallet])
    )
  ).toBe(before)
  await wallet.getByRole('button', {name: 'Apply received design'}).click()
  await expect(wallet.getByRole('dialog')).toHaveCount(0)
  await expect(wallet.locator('.banknote-heading')).toHaveText(
    'PUSHED FROM NOTES'
  )
  await expect(wallet.locator('.banknote-art')).toHaveCount(1)
  await expect(wallet.locator('.status.ready')).toHaveCount(1)
  expect(
    await receiver.evaluate(() =>
      [...(window as any).hostStores.wallet.values()].join('')
    )
  ).not.toContain('PUSHED FROM NOTES')
  await receiver.close()
  await notes.getByRole('button', {name: 'Send to Wallet'}).click()
  await expect(notes.getByRole('status')).toContainText('No wallet')
  await expect(notes.getByLabel('Note heading')).toHaveValue(
    'PUSHED FROM NOTES'
  )
  expect(errors).toEqual([])
})
