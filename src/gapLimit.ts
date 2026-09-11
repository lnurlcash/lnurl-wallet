import {createSignal} from 'solid-js'

// LUD-25's own recovery-scan convention - "WALLET stops scanning a given
// SERVICE after some gap limit of consecutive unknown indices, the same
// convention HD wallets already use for address recovery" - shared by
// recovery.ts (legacy hash-based mint rescan) and addressRecovery.ts
// (LUD-25 Part 2 registered-address scan), so a holder picks one number
// that applies to both. A module-level signal, same reasoning as
// autoLock.ts/currency.ts: plain utility code (recovery.ts,
// addressRecovery.ts), not just Settings.tsx, needs to read it.
export type GapLimit = 5 | 10 | 20 | 50 | 100

const STORAGE_KEY = 'lnurlcash_gap_limit'
const DEFAULT_GAP_LIMIT: GapLimit = 20
const VALID_GAP_LIMITS: readonly GapLimit[] = [5, 10, 20, 50, 100]

// this module is pulled into recovery.ts/addressRecovery.ts, which plain
// utility tests elsewhere already assume can run without localStorage -
// same tolerance offlineMode.ts's own readStored uses
const readStored = (): GapLimit => {
  try {
    const raw = Number(localStorage.getItem(STORAGE_KEY))
    return (VALID_GAP_LIMITS as readonly number[]).includes(raw)
      ? (raw as GapLimit)
      : DEFAULT_GAP_LIMIT
  } catch {
    return DEFAULT_GAP_LIMIT
  }
}

const [gapLimit, setGapLimitSignal] = createSignal<GapLimit>(readStored())
export {gapLimit}

export const setGapLimit = (value: GapLimit): void => {
  try {
    localStorage.setItem(STORAGE_KEY, String(value))
  } catch {
    // no persistent storage available - the in-memory signal below still
    // works for the rest of this session
  }
  setGapLimitSignal(value)
}

export const GAP_LIMIT_OPTIONS: GapLimit[] = [5, 10, 20, 50, 100]

export const GAP_LIMIT_LABEL: Record<GapLimit, string> = {
  5: '5',
  10: '10',
  20: '20 (default)',
  50: '50',
  100: '100'
}
