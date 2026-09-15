import {defineConfig, devices} from '@playwright/test'

// runs against the same dev server a holder actually hits (`npm run dev`)
// on a dedicated port, so an e2e run never fights a developer's own `npm
// run dev` left open on 5173 - `reuseExistingServer` still lets a local
// run reuse one already up on THIS port instead of double-starting it
const PORT = 5175

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // 'github' alone annotates the PR but writes no report to disk - add
  // 'html' so ci.yml's upload-artifact step has something to attach for a
  // failure that needs a trace/screenshot to debug after the fact
  reporter: process.env.CI ? [['github'], ['html', {open: 'never'}]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: {...devices['Desktop Chrome']}
    }
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  }
})
