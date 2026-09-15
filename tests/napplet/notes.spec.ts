import {test, expect} from '@playwright/test'
import {artwork} from './artwork'

test('notes runs alone: upload, export, draft recovery and reviewed intent', async ({
  page
}, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/notes')
  await expect(page).toHaveTitle('LNURLcash Notes · local preview')
  await expect(page.locator('iframe')).toHaveCount(1)
  await expect(
    page.locator('#wallet, #wallet-tab, #designer-tab, #sample')
  ).toHaveCount(0)
  const notes = page.frameLocator('#notes')
  await expect(
    notes.getByRole('heading', {name: 'Make something worth holding.'})
  ).toBeVisible()
  await expect(
    notes.getByRole('button', {name: /open wallet|use in wallet/i})
  ).toHaveCount(0)
  await notes.getByLabel('Note heading').fill('TWENTY ONE CLUB')
  await notes.getByRole('button', {name: 'Copper palette'}).click()
  await notes.getByLabel('Upload artwork').setInputFiles({
    name: 'portrait.png',
    mimeType: 'image/png',
    buffer: Buffer.from((await artwork(page)).split(',')[1], 'base64')
  })
  await expect(notes.locator('.banknote-art')).toBeVisible()
  const frame = page.frames().find(frame => frame.url() === 'about:srcdoc')!
  expect(
    await frame.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true)
  await page.screenshot({
    path: `test-results/notes-${testInfo.project.name}.png`,
    fullPage: true
  })
  await notes.getByRole('button', {name: 'Export design'}).click()
  const exported = JSON.parse(
    await notes.getByLabel('Design JSON').inputValue()
  )
  expect(exported.title).toBe('TWENTY ONE CLUB')
  expect(exported.image).toMatch(/^data:image\/jpeg;base64,/)
  expect(Object.keys(exported).sort()).toEqual([
    'image',
    'ink',
    'paper',
    'subtitle',
    'title'
  ])
  await page.evaluate(() => (window as any).reloadNapplet())
  await expect(notes.getByLabel('Note heading')).toHaveValue('TWENTY ONE CLUB')
  await expect(notes.locator('.banknote-art')).toBeVisible()
  await page.evaluate(() =>
    (window as any).deliverNapplet('napplet:bearer-designer/open', {
      design: {title: 'invalid'}
    })
  )
  await expect(notes.getByRole('status')).toContainText('could not be opened')
  await expect(notes.getByLabel('Note heading')).toHaveValue('TWENTY ONE CLUB')
  await page.evaluate(
    design =>
      (window as any).deliverNapplet('napplet:bearer-designer/open', {
        design: {...design, title: 'RECEIVED DESIGN'}
      }),
    exported
  )
  await expect(notes.getByRole('dialog')).toBeVisible()
  await expect(notes.getByLabel('Note heading')).toHaveValue('TWENTY ONE CLUB')
  await notes.getByRole('button', {name: 'Open received design'}).click()
  await expect(notes.getByLabel('Note heading')).toHaveValue('RECEIVED DESIGN')
  expect(
    await page.evaluate(() =>
      (window as any).hostCalls.some(
        (call: any) =>
          call.type.startsWith('resource.') ||
          call.type.startsWith('intent.') ||
          call.type === 'inc.emit'
      )
    )
  ).toBe(false)
  expect(
    await page.evaluate(() => Object.keys((window as any).hostStores))
  ).toEqual(['notes'])
  expect(errors).toEqual([])
})
