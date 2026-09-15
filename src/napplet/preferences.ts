export type Preferences = {
  offline: boolean
  autoLock: 0 | 1 | 5 | 15 | 30
  currency: 'none' | 'eur' | 'gbp' | 'usd'
  sort: 'amount' | 'updated'
  descending: boolean
  groupByMint: boolean
}
export const DEFAULT_PREFERENCES: Preferences = {
  offline: false,
  autoLock: 5,
  currency: 'none',
  sort: 'updated',
  descending: true,
  groupByMint: true
}
let offline = false
/** Enforce the user's offline setting at the shared protocol transport boundary. */
export const setNappletOffline = (value: boolean): void => {
  offline = value
}
export const nappletIsOffline = (): boolean => offline

/** Accept only supported preference values when opening or restoring a wallet. */
export const parsePreferences = (value: unknown): Preferences => {
  const result = {...DEFAULT_PREFERENCES, ...(value as Partial<Preferences>)}
  if (
    ![0, 1, 5, 15, 30].includes(result.autoLock) ||
    !['none', 'eur', 'gbp', 'usd'].includes(result.currency) ||
    !['amount', 'updated'].includes(result.sort) ||
    ['offline', 'descending', 'groupByMint'].some(
      key => typeof result[key as keyof Preferences] !== 'boolean'
    )
  )
    throw new Error('Invalid wallet preferences.')
  return result
}
