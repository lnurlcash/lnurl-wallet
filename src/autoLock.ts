import {createFreshSignal} from './freshSignal'

// idle-timeout minutes before an unlocked, password-encrypted wallet
// auto-locks itself (see WalletContext.tsx's own idle-timeout bookkeeping) -
// 0 means never. A module-level signal, same reasoning as offlineMode.ts/
// currency.ts: WalletContext.tsx needs to read it too, not just Settings.tsx
export type AutoLockMinutes = 1 | 5 | 15 | 30 | 0

const STORAGE_KEY = 'lnurlcash_auto_lock_minutes'
const DEFAULT_MINUTES: AutoLockMinutes = 5
const VALID_MINUTES: readonly AutoLockMinutes[] = [1, 5, 15, 30, 0]

// this module is pulled into WalletContext.tsx, which plain utility tests
// elsewhere already assume can run without localStorage - same tolerance
// offlineMode.ts's own readStored uses
const readStored = (): AutoLockMinutes => {
  try {
    const raw = Number(localStorage.getItem(STORAGE_KEY))
    return (VALID_MINUTES as readonly number[]).includes(raw)
      ? (raw as AutoLockMinutes)
      : DEFAULT_MINUTES
  } catch {
    return DEFAULT_MINUTES
  }
}

const [autoLockMinutes, setAutoLockMinutesSignal] =
  createFreshSignal<AutoLockMinutes>(readStored())
export {autoLockMinutes}

export const setAutoLockMinutes = (value: AutoLockMinutes): void => {
  try {
    localStorage.setItem(STORAGE_KEY, String(value))
  } catch {
    // no persistent storage available - the in-memory signal below still
    // works for the rest of this session
  }
  setAutoLockMinutesSignal(value)
}

export const AUTO_LOCK_OPTIONS: AutoLockMinutes[] = [1, 5, 15, 30, 0]

export const AUTO_LOCK_LABEL: Record<AutoLockMinutes, string> = {
  1: '1 minute',
  5: '5 minutes',
  15: '15 minutes',
  30: '30 minutes',
  0: 'Never'
}
