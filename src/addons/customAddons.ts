import {createSignal} from 'solid-js'
import type {AddonManifest} from './types'

// holder-authored/edited addons (see the builder on Addons.tsx) - JSON
// manifests only, no helpers (a helper is a TS function; a custom addon
// only ever gets the built-in expression operators and the fixed verb
// allowlist, same as any manifest). Same module-level-signal +
// localStorage pattern as offlineMode.ts/notePrefs.ts.
const STORAGE_KEY = 'lnurlcash_custom_addons'

const readStored = (): AddonManifest[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

const [customAddonManifests, setCustomAddonManifestsSignal] =
  createSignal<AddonManifest[]>(readStored())
export {customAddonManifests}

const persist = (manifests: AddonManifest[]): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(manifests))
  } catch {
    // no persistent storage available - the in-memory signal below still
    // works for the rest of this session
  }
  setCustomAddonManifestsSignal(manifests)
}

// upserts by id - saving over an existing custom addon's id edits it in
// place rather than creating a duplicate
export const saveCustomAddon = (manifest: AddonManifest): void => {
  const existing = customAddonManifests()
  const index = existing.findIndex(m => m.id === manifest.id)
  const next =
    index >= 0
      ? existing.map((m, i) => (i === index ? manifest : m))
      : [...existing, manifest]
  persist(next)
}

export const deleteCustomAddon = (id: string): void => {
  persist(customAddonManifests().filter(m => m.id !== id))
}

export const isCustomAddon = (id: string): boolean =>
  customAddonManifests().some(m => m.id === id)
