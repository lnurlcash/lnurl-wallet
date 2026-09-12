import {defineConfig} from '@playwright/test'

export default defineConfig({
  testDir: './tests/napplet',
  use: {baseURL: 'http://127.0.0.1:4186', headless: true},
  webServer: {
    command: 'node scripts/napplet-host.mjs',
    url: 'http://127.0.0.1:4186',
    reuseExistingServer: true
  },
  projects: [
    {name: 'desktop', use: {viewport: {width: 1440, height: 1000}}},
    {name: 'mobile', use: {viewport: {width: 390, height: 844}}}
  ]
})
