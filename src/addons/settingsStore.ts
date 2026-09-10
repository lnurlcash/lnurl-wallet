import {createSignal} from 'solid-js'

// one persisted settings store per addon - same module-level-signal +
// localStorage pattern as offlineMode.ts, just keyed per addon id instead
// of a single fixed key, and created lazily/cached so the Settings page's
// own section and the addon's "run" page (which seeds its state from this)
// always read the exact same signal rather than two independent copies
// that could drift
const keyFor = (addonId: string) => `lnurlcash_addon_settings_${addonId}`

const readStored = (
  addonId: string,
  defaults: Record<string, unknown>
): Record<string, unknown> => {
  try {
    const raw = localStorage.getItem(keyFor(addonId))
    return raw ? {...defaults, ...JSON.parse(raw)} : {...defaults}
  } catch {
    return {...defaults}
  }
}

type SettingsStore = [
  () => Record<string, unknown>,
  (value: Record<string, unknown>) => void
]

const stores = new Map<string, SettingsStore>()

export const addonSettingsStore = (
  addonId: string,
  defaults: Record<string, unknown>
): SettingsStore => {
  const existing = stores.get(addonId)
  if (existing) return existing

  const [settings, setSettingsSignal] = createSignal<Record<string, unknown>>(
    readStored(addonId, defaults)
  )
  const setSettings = (value: Record<string, unknown>): void => {
    try {
      localStorage.setItem(keyFor(addonId), JSON.stringify(value))
    } catch {
      // no persistent storage available - the in-memory signal below still
      // works for the rest of this session
    }
    setSettingsSignal(value)
  }

  const store: SettingsStore = [settings, setSettings]
  stores.set(addonId, store)
  return store
}
