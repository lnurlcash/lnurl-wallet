import {createSignal} from 'solid-js'

// TODO.md: Vault (pairing + read-only visibility for LNURLvault hardware,
// see pages/Vault.tsx) is still alpha - it doesn't fit the addon DSL at
// all (a fixed, declarative UiNode/verb vocabulary has no business
// speaking to a USB/Bluetooth hardware device's own pairing/identity
// protocol), so instead of shipping it as a permanent nav-bar feature, a
// holder opts in via Settings. Off by default. Same module-level-signal +
// localStorage pattern as offlineMode.ts.
const STORAGE_KEY = 'lnurlcash_vault_enabled'

const readStored = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

const [vaultEnabled, setVaultEnabledSignal] =
  createSignal<boolean>(readStored())
export {vaultEnabled}

export const setVaultEnabled = (value: boolean): void => {
  try {
    localStorage.setItem(STORAGE_KEY, value ? '1' : '0')
  } catch {
    // no persistent storage available - the in-memory signal below still
    // works for the rest of this session
  }
  setVaultEnabledSignal(value)
}
