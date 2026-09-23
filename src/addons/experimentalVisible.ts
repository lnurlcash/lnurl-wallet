import {createSignal} from 'solid-js'

// whether Settings' addon list shows addons flagged experimental?: true in
// their own manifest (types.ts) - off by default, same posture as
// enabled.ts itself: an experimental addon should take a deliberate step
// to even become visible, on top of the separate step to turn it on.
// Same module-level-signal + localStorage pattern as enabled.ts/
// offlineMode.ts.
const STORAGE_KEY = 'lnurlcash_show_experimental_addons'

const readStored = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

const [experimentalAddonsVisible, setExperimentalAddonsVisibleSignal] =
  createSignal<boolean>(readStored())
export {experimentalAddonsVisible}

export const setExperimentalAddonsVisible = (visible: boolean): void => {
  try {
    localStorage.setItem(STORAGE_KEY, String(visible))
  } catch {
    // no persistent storage available - the in-memory signal below still
    // works for the rest of this session
  }
  setExperimentalAddonsVisibleSignal(visible)
}
