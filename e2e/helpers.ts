import type {Page} from '@playwright/test'

// drives the real Setup flow rather than seeding localStorage directly -
// the linking key's on-disk shape is the wallet's own internal format, not
// a contract this test suite should hardcode. Unencrypted, so every later
// page.goto() in the same test auto-unlocks via WalletContext's own
// onMount effect (see WalletContext.tsx: a plaintext root key unlocks
// itself on mount) instead of needing a password typed in on every page
export const setUpWallet = async (page: Page): Promise<void> => {
  await page.goto('/#/setup')
  await page.getByRole('button', {name: 'Generate seed phrase'}).click()
  await page.getByLabel('I have saved my seed phrase somewhere safe').check()
  const encryptCheckbox = page.getByLabel(
    'Store my linking key encrypted, with a password (recommended)'
  )
  if (await encryptCheckbox.isChecked()) await encryptCheckbox.uncheck()
  await page.getByRole('button', {name: 'Continue'}).click()
  await page.waitForURL('**/#/wallet')
}

// Settings' addon list toggle - a no-op if already on, so callers don't
// need to track state across tests that share a browser context
export const enableAddon = async (page: Page, name: string): Promise<void> => {
  await page.goto('/#/settings')
  const row = page.locator('.mint-picker-entry', {hasText: name})
  const turnOn = row.getByRole('button', {name: 'Turn on'})
  if (await turnOn.isVisible().catch(() => false)) await turnOn.click()
}
