import {test, expect} from '@playwright/test'

import {setUpWallet, enableAddon} from './helpers'

// the exact payRequest a holder reported earlier: two duplicate text/plain
// metadata entries, this wallet's own text/xpub (LUD-25 internal transfer)
// extension, and NIP-57 zap fields - the response formatLnurlResponse /
// metadataEntries (src/addons/lnurlTools/manifest.ts) need to handle
const PAY_REQUEST_BODY = {
  tag: 'payRequest',
  callback: 'https://mint.lnurlcash.com/p/dni2',
  minSendable: 14000,
  maxSendable: 200000000,
  metadata:
    '[["text/plain", "Mint an lnurlcash bearer note on mint.lnurlcash.com"], ["text/identifier", "dni2@mint.lnurlcash.com"], ["text/xpub", "cx15qwmqamrkyd0tkr8aawvkgdhpl0cw44sc5uealh9lpddqvtj22fy50dxfr082vy9h3wwq0f22gefdaprkuq9ap9qekfcn454dwg5nwc5rf47n:6"], ["text/plain", "Mint fees: 3000,2000"]]',
  withdrawLink: 'https://mint.lnurlcash.com/w',
  commentAllowed: 64,
  allowsNostr: true,
  nostrPubkey:
    '81559e260ef446c3adb3824f3f15f895979c28d9c1448d284348f7df4bc8fd93'
}

test.describe('LNURL Tools addon', () => {
  test('renders fetched metadata as an ordered list and pretty JSON, without crashing', async ({
    page
  }) => {
    await setUpWallet(page)
    await enableAddon(page, 'LNURL Tools')

    // the addon's own SSRF check (isAllowedServiceUrl) only requires
    // https:// - it never resolves DNS, so a fake .test domain reaches
    // this route mock without ever leaving the browser
    await page.route('https://mint.example.test/**', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(PAY_REQUEST_BODY)
      })
    )

    await page.goto('/#/addons/lnurl-tools')
    await page
      .getByLabel('LNURL, Lightning Address, or URL')
      .fill('https://mint.example.test/.well-known/lnurlp/dni2')
    await page.getByRole('button', {name: 'Fetch'}).click()

    // this exact failure mode (a bad JSX dynamic-tag reference in the List
    // node) crashed the whole render tree with a generic "Something went
    // wrong" - assert it's gone, not just that the good content showed up
    // elsewhere on the page
    await expect(page.getByText('Something went wrong')).toHaveCount(0)
    await expect(page.locator('.addon-error')).toHaveCount(0)

    await expect(page.getByText('Nostr zaps (NIP-57): allowed')).toBeVisible()

    // duplicate text/plain entries disambiguated, LUD-25 xpub entry
    // labelled, in source order, as a real <ol>
    const items = page.locator('.addon-list-block li')
    await expect(items).toHaveCount(4)
    await expect(items.nth(0)).toContainText('Description 1:')
    await expect(items.nth(1)).toContainText('Identifier:')
    await expect(items.nth(2)).toContainText('Internal transfer xpub (LUD-25):')
    await expect(items.nth(3)).toContainText('Description 2:')

    // JsonDisplay's syntax-coloured raw dump
    await expect(
      page.locator('.addon-json .addon-json-key').first()
    ).toBeVisible()
    await expect(page.locator('.addon-json')).toContainText('"payRequest"')
  })
})

test.describe('Addon error isolation', () => {
  test('a crashing custom addon shows its own scoped error, not a blank app', async ({
    page
  }) => {
    await setUpWallet(page)

    // deliberately references a helper that doesn't exist - evaluate()
    // (src/addons/expr.ts) throws on this at render time, the same class
    // of render-time-only failure as the List/JsonDisplay bug this suite
    // guards against. validateManifest doesn't check helper names against
    // a known set (only verb names), so this legitimately saves.
    const brokenManifest = {
      id: 'broken-test-addon',
      name: 'Broken Test Addon',
      version: '1',
      icon: 'globe',
      permissions: [],
      state: {},
      ui: {
        type: 'Text',
        value: {helper: 'thisHelperDoesNotExist', args: []}
      }
    }

    await page.goto('/#/settings')
    await page.getByRole('button', {name: '+ New custom addon'}).click()
    await page
      .locator('.addon-builder-textarea')
      .fill(JSON.stringify(brokenManifest, null, 2))
    await page.getByRole('button', {name: 'Save'}).click()
    await enableAddon(page, 'Broken Test Addon')

    await page.goto('/#/addons/broken-test-addon')

    // the scoped fallback: named after the addon, shows the real error
    // for debugging, offers a way back - not the app-wide index.tsx
    // ErrorBoundary's generic "reload the page" message
    await expect(page.getByText('Broken Test Addon hit an error')).toBeVisible()
    // technical details (the full error, for debugging) sit behind a
    // <details> disclosure, separate from the friendly message above it -
    // both happen to mention the helper name, so scope to the details pre
    await page.locator('.addon-error-details summary').click()
    await expect(page.locator('.addon-error-details pre')).toContainText(
      'thisHelperDoesNotExist'
    )

    // proof the rest of the app shell survived: nav is still there and
    // still navigable, not just an isolated fallback on an otherwise-blank
    // page
    // scoped to <nav> - the addon's own "Back to Settings" link (also
    // rendered on this page, by AddonRenderError) matches "Settings" too
    await page.locator('nav').getByRole('link', {name: 'Settings'}).click()
    await expect(page).toHaveURL(/#\/settings/)
  })
})
