import type {Component} from 'solid-js'
import {Show} from 'solid-js'
import {A, useParams} from '@solidjs/router'

import RequireWallet from '../components/RequireWallet'
import AddonRenderer from '../addons/Renderer'
import {findAddon} from '../addons/registry'
import {enabledAddonIds} from '../addons/enabled'
import {addonSettingsStore} from '../addons/settingsStore'
import type {Addon} from '../addons/types'

// runs one bundled or custom addon's own `ui` (see Settings.tsx's Addons
// column for the enable/disable/edit list) - gated on both "enabled" (a
// holder's own choice) and an unlocked wallet (addons touch real notes,
// same requirement Mint/Vault already have)
const AddonRun: Component = () => {
  const params = useParams<{addonId: string}>()
  const addon = () => findAddon(params.addonId)

  return (
    <div id="addon-run" class="page">
      <Show
        when={addon()}
        fallback={
          <div class="setup-card">
            <p>That addon doesn't exist.</p>
            <A href="/settings" class="hero-btn hero-btn-primary">
              Back to Settings
            </A>
          </div>
        }
      >
        {found => (
          <Show
            when={enabledAddonIds().has(found().manifest.id)}
            fallback={
              <div class="setup-card">
                <p>{found().manifest.name} is turned off.</p>
                <A href="/settings" class="hero-btn hero-btn-primary">
                  Turn it on
                </A>
              </div>
            }
          >
            <RequireWallet>
              <RunAddon addon={found()} />
            </RequireWallet>
          </Show>
        )}
      </Show>
    </div>
  )
}

const RunAddon: Component<{addon: Addon}> = props => {
  const [settings] = addonSettingsStore(
    props.addon.manifest.id,
    props.addon.manifest.settings?.state ?? {}
  )
  // a fresh run id and the holder's persisted settings are seeded once,
  // at mount, into the addon's own page-local state - not a live binding,
  // so a run can freely diverge from "my usual preference" afterward
  // without writing back to it (see manifest's own state.paper/showAmount
  // defaults, overridden here)
  const initialState = {
    ...props.addon.manifest.state,
    runId: crypto.randomUUID(),
    ...settings()
  }
  return (
    <>
      <p class="bearer-label">
        Alpha feature (since v0.11.0) - see{' '}
        <A href="/settings">Settings</A> for what this can and can't do.
      </p>
      <AddonRenderer addon={props.addon} mode="run" initialState={initialState} />
    </>
  )
}

export default AddonRun
