import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import type {Plugin} from 'vite'
import {defineConfig} from 'vite'
import solidPlugin from '@solidjs/vite-plugin'
import {VitePWA} from 'vite-plugin-pwa'
import {gitVersion} from './scripts/git-version.mjs'

const pkg = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./package.json', import.meta.url)),
    'utf-8'
  )
)

// Content-Security-Policy, injected as a <meta> into production builds only.
// GitHub Pages can't set response headers, so this meta is the only place a
// policy can live - defense in depth: the app ships no inline scripts, no
// third-party scripts and no DOM sinks, and this keeps it that way. Notes on
// the shape:
// - script-src 'self' works because the PWA registers from inside the
//   bundled JS (virtual:pwa-register), never an inline <script>
// - style-src keeps 'unsafe-inline' for SolidJS style={{}} attributes
// - connect-src must stay open to arbitrary https origins - LNURL calls go
//   to whatever mint a note or scan names; the http exceptions are the
//   deliberate insecure-host support (lnurlcash.ts's INSECURE_HOSTS)
// - no upgrade-insecure-requests: it would force those same intentional
//   http://localhost mint calls onto https and break local regtest loops
// - frame-ancestors is ignored inside a meta tag, so clickjacking defense
//   is simply unavailable on this host - the app's own confirm steps are
//   the mitigation
// Dev is excluded entirely: the HMR websocket (ws://) and vite's dev client
// would need exceptions that don't belong in the shipped policy.
const CSP_CONTENT =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src https: wss: http://localhost:* http://127.0.0.1:* http://0.0.0.0:* http://*.onion http://*.onion:*; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"

const cspMetaPlugin = (): Plugin => ({
  name: 'csp-meta',
  apply: 'build',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      attrs: {
        'http-equiv': 'Content-Security-Policy',
        content: CSP_CONTENT
      },
      injectTo: 'head-prepend'
    }
  ]
})

export default defineConfig({
  plugins: [
    cspMetaPlugin(),
    solidPlugin(),
    VitePWA({
      // 'prompt', not 'autoUpdate': this is a wallet, so a new build must
      // never silently swap the running JS out from under a signing/melt
      // action in progress - src/index.tsx wires the prompt to a toast
      registerType: 'prompt',
      // precache only the built app shell (JS/CSS/fonts/icons). No
      // runtimeCaching entries are added on purpose - every fetch() this
      // app makes is a live LNURL/mint protocol call, and those must always
      // hit the network, never be served from a cache as if still current
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff,woff2,svg,png}'],
        // cleanupOutdatedCaches (on by default) drops the old precache
        // entries - old bundle files - once a new SW activates. clientsClaim
        // is what makes that activation actually reach an already-open tab:
        // without it, skipWaiting() alone still leaves the page controlled
        // by the previous SW until some unrelated navigation happens, so the
        // reload the update toast triggers (src/index.tsx) would silently
        // do nothing
        clientsClaim: true
      },
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'LNURLwallet',
        short_name: 'LNURLwallet',
        description: pkg.description,
        // relative to the manifest's own URL, so this resolves correctly
        // whether served from a domain root or a GitHub Pages subpath
        start_url: '.',
        scope: '.',
        display: 'standalone',
        background_color: '#0a0c10',
        theme_color: '#0a0c10',
        icons: [
          {src: 'icon-192.png', sizes: '192x192', type: 'image/png'},
          {src: 'icon-512.png', sizes: '512x512', type: 'image/png'},
          {
            src: 'maskable-icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      }
    })
  ],
  // relative asset paths so the same build works on GitHub Pages
  // (https://user.github.io/lnurl-wallet/) and any other static host -
  // routing is hash-based, so no server-side path handling is needed either
  base: './',
  server: {
    port: 3000
  },
  build: {
    target: 'esnext'
  },
  // Footer shows this - a compile-time constant sourced from the nearest
  // git tag (see scripts/git-version.mjs), so cutting a release is just
  // pushing a tag. 'dev' only surfaces outside a git checkout entirely
  // (e.g. a downloaded source archive with no .git directory)
  define: {
    __APP_VERSION__: JSON.stringify(gitVersion('dev'))
  }
})
