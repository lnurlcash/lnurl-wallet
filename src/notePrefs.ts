import {createFreshSignal} from './freshSignal'

// how the note list on Wallet.tsx is sorted/grouped, remembered across
// reloads instead of always resetting to the same default - same
// module-level-signal-plus-localStorage pattern as offlineMode.ts/
// currency.ts/autoLock.ts, just for view state that only Wallet.tsx reads
export type NoteSortKey = 'amount' | 'updated'

const SORT_KEY_STORAGE_KEY = 'lnurlcash_note_sort_key'
const SORT_DESC_STORAGE_KEY = 'lnurlcash_note_sort_desc'
const GROUP_STORAGE_KEY = 'lnurlcash_note_group_by_mint'

const readSortKey = (): NoteSortKey => {
  try {
    return localStorage.getItem(SORT_KEY_STORAGE_KEY) === 'amount'
      ? 'amount'
      : 'updated'
  } catch {
    return 'updated'
  }
}

// absent (a first run, or storage unavailable) defaults to descending, same
// as the signal's own original hardcoded initial value
const readSortDesc = (): boolean => {
  try {
    const raw = localStorage.getItem(SORT_DESC_STORAGE_KEY)
    return raw === null ? true : raw === '1'
  } catch {
    return true
  }
}

const readGroupByMint = (): boolean => {
  try {
    return localStorage.getItem(GROUP_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

const [noteSortKey, setNoteSortKeySignal] =
  createFreshSignal<NoteSortKey>(readSortKey())
export {noteSortKey}
export const setNoteSortKey = (value: NoteSortKey): void => {
  try {
    localStorage.setItem(SORT_KEY_STORAGE_KEY, value)
  } catch {
    // no persistent storage available - the in-memory signal below still
    // works for the rest of this session
  }
  setNoteSortKeySignal(value)
}

const [noteSortDesc, setNoteSortDescSignal] =
  createFreshSignal<boolean>(readSortDesc())
export {noteSortDesc}
export const setNoteSortDesc = (value: boolean): void => {
  try {
    localStorage.setItem(SORT_DESC_STORAGE_KEY, value ? '1' : '0')
  } catch {
    // no persistent storage available - the in-memory signal below still
    // works for the rest of this session
  }
  setNoteSortDescSignal(value)
}

const [noteGroupByMint, setNoteGroupByMintSignal] =
  createFreshSignal<boolean>(readGroupByMint())
export {noteGroupByMint}
export const setNoteGroupByMint = (value: boolean): void => {
  try {
    localStorage.setItem(GROUP_STORAGE_KEY, value ? '1' : '0')
  } catch {
    // no persistent storage available - the in-memory signal below still
    // works for the rest of this session
  }
  setNoteGroupByMintSignal(value)
}
