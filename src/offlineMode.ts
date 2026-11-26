import {createFreshSignal} from './freshSignal'

// A user-set policy, not detected connectivity: while on, lnurlFetch (the
// one choke point every LNURLcash request goes through - lookups, melt,
// split, merge, rotate, verify) refuses outright instead of attempting the
// network. A module-level signal, same reasoning as trustedMints.ts - plain
// utility code needs to read it too, not just nav/UI components.
const STORAGE_KEY = 'lnurlcash_offline_mode'

// this module is pulled in by lnurlcash.ts (the lnurlFetch guard below), and
// lnurlcash.ts is unit-tested directly under plain Node - no localStorage
// global there, so reading/writing it needs to tolerate not existing at all
const readStored = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

const [offlineMode, setOfflineModeSignal] =
  createFreshSignal<boolean>(readStored())
export {offlineMode}

export const setOfflineMode = (value: boolean): void => {
  try {
    localStorage.setItem(STORAGE_KEY, value ? '1' : '0')
  } catch {
    // no persistent storage available - the in-memory signal below still
    // works for the rest of this session
  }
  setOfflineModeSignal(value)
}
