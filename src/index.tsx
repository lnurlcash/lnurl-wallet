/* @refresh reload */
import {ErrorBoundary} from 'solid-js'
import {render} from 'solid-js/web'
import {Route, HashRouter, Navigate} from '@solidjs/router'
import toast, {Toaster} from 'solid-toast'
import {registerSW} from 'virtual:pwa-register'

import {WalletProvider} from './WalletContext'
import {DeviceProvider} from './DeviceContext'
import {notify, NotifyKind} from './helpers'
import '@fontsource/noto-sans/400.css'
import '@fontsource/noto-sans/700.css'
import './styles/style.scss'
import './styles/background.scss'

import Nav from './components/Nav'
import Footer from './components/Footer'
import Hero from './pages/Hero'
import Wallet from './pages/Wallet'
import Setup from './pages/Setup'
import Mint from './pages/Mint'
import Activity from './pages/Activity'
import Docs from './pages/Docs'
import Vault from './pages/Vault'
import Claim from './pages/Claim'
import Settings from './pages/Settings'
import AddonRun from './pages/AddonRun'

const root = document.getElementById('root')

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(
    'Root element not found. Did you forget to add it to your index.html? Or maybe the id attribute got misspelled?'
  )
}

const App = (props: any) => {
  return (
    <WalletProvider>
      <DeviceProvider>
        {/* solid-toast's default top offset sits right under the viewport
        edge, which the fixed nav (taller still on mobile, see .nav-toggle in
        style.scss) then overlaps - pushed down past it instead */}
        <Toaster
          position="top-right"
          toastOptions={{duration: 5000}}
          containerStyle={{top: '64px'}}
        />
        <Nav />
        {/* a render-time throw (e.g. one malformed stored record) must
        never take down the whole app shell - show a recoverable error
        instead of a permanently blank page */}
        <ErrorBoundary
          fallback={(err: Error) => (
            <div class="page">
              <h2>Something went wrong</h2>
              <p>
                The last view failed to render ({err.message}). Your notes are
                still safe in storage - reload the page, and if this keeps
                happening, use Settings to export a backup.
              </p>
            </div>
          )}
        >
          {props.children}
        </ErrorBoundary>
        <Footer />
      </DeviceProvider>
    </WalletProvider>
  )
}

const cleanup = render(
  () => (
    <HashRouter root={App}>
      <Route path="/" component={Hero} />
      <Route path="/wallet" component={Wallet} />
      <Route path="/setup" component={Setup} />
      <Route path="/mint" component={Mint} />
      {/* /mints merged into /mint (trusted-mint management now lives at
      the bottom of that page) - kept as a redirect so old links/bookmarks
      still land somewhere useful instead of 404ing */}
      <Route path="/mints" component={() => <Navigate href="/mint" />} />
      {/* /melt merged into /wallet (MeltDialog, opened from the "Melt" hero
      button or automatically via a pasted invoice in Receive - see
      meltHandoff.ts) - kept as a redirect so old links/bookmarks still land
      somewhere useful instead of 404ing */}
      <Route path="/melt" component={() => <Navigate href="/wallet" />} />
      <Route path="/activity" component={Activity} />
      {/* /backup merged into /settings (backup/restore/forget now live
      alongside the other wallet-wide settings there) - kept as a redirect
      so old links/bookmarks still land somewhere useful instead of 404ing */}
      <Route path="/backup" component={() => <Navigate href="/settings" />} />
      <Route path="/docs" component={Docs} />
      <Route path="/settings" component={Settings} />
      <Route path="/addons/:addonId" component={AddonRun} />
      <Route path="/vault" component={Vault} />
      <Route path="/claim" component={Claim} />
      <Route path="*" component={() => <h1>Page not found</h1>} />
    </HashRouter>
  ),
  root!
)

if (import.meta.hot) {
  import.meta.hot.dispose(cleanup)
}

// 'prompt' registerType (see vite.config.ts) means a waiting update never
// takes over on its own - the reload is only ever whatever this toast's
// button triggers, so a build never swaps out from under an in-progress
// signing/melt action
const updateSW = registerSW({
  onNeedRefresh: () => {
    const id = toast.custom(
      <span>
        A new version is ready.&nbsp;
        <button
          onClick={() => {
            toast.dismiss(id)
            updateSW(true)
          }}
        >
          Reload
        </button>
      </span>,
      {duration: Infinity}
    )
  },
  onOfflineReady: () => {
    notify('Ready to work offline.', NotifyKind.SUCCESS)
  }
})
