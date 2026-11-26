import {createFreshSignal} from './freshSignal'

// optional fiat estimate shown alongside sats everywhere in the app (see
// FiatValue.tsx) - purely a display convenience, never part of any actual
// mint/melt/split amount. 'none' (the default) shows no estimate and does
// no network fetching at all.
export type Currency = 'none' | 'usd' | 'eur' | 'gbp'

const STORAGE_KEY = 'lnurlcash_currency'

// same price aggregator LNbits itself runs (polls several exchanges -
// Coinbase, Kraken, Bitfinex, ... - and serves the cached median BTC price
// per currency), just under this project's own domain. Covers USD/EUR/GBP
// directly (see its own /rates response), so no separate fx conversion API
// is needed on top - each is a real exchange-derived price, not a synthetic
// USD->EUR/GBP conversion
const RATES_URL = 'https://price.lnurlcash.com/rates'

// matches the aggregator's own default background-refresh cadence - polling
// faster than that would just re-fetch its same cached snapshot
const REFRESH_MS = 60_000

// this module is imported from plain display components that may end up
// pulled into a Node unit test with no localStorage/fetch globals - same
// tolerance offlineMode.ts's own readStored uses
const readStored = (): Currency => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === 'usd' || raw === 'eur' || raw === 'gbp' ? raw : 'none'
  } catch {
    return 'none'
  }
}

const [currency, setCurrencySignal] = createFreshSignal<Currency>(readStored())
export {currency}

type Rates = {usd: number; eur: number; gbp: number}

const [rates, setRates] = createFreshSignal<Rates | null>(null)
// surfaced by CurrencyMenu so a failed fetch (offline, service down) is
// visible instead of a silently-missing fiat estimate
const [ratesError, setRatesError] = createFreshSignal<string | null>(null)
export {rates, ratesError}

type RatesResponse = {
  base: string
  rates: Record<string, {median: number} | null>
}

let pollTimer: ReturnType<typeof setInterval> | null = null

const fetchRates = async (): Promise<void> => {
  try {
    const res = await fetch(RATES_URL)
    if (!res.ok) throw new Error(`price.lnbits.com returned ${res.status}`)
    const data = (await res.json()) as RatesResponse
    const usd = data.rates.USD?.median
    const eur = data.rates.EUR?.median
    const gbp = data.rates.GBP?.median
    if (!usd || !eur || !gbp) {
      throw new Error('price.lnbits.com response is missing a rate')
    }
    setRates({usd, eur, gbp})
    setRatesError(null)
  } catch (err) {
    setRatesError((err as Error).message)
  }
}

const startPolling = (): void => {
  if (pollTimer) return
  fetchRates()
  pollTimer = setInterval(fetchRates, REFRESH_MS)
}

const stopPolling = (): void => {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

export const setCurrency = (value: Currency): void => {
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch {
    // no persistent storage available - the in-memory signal below still
    // works for the rest of this session
  }
  setCurrencySignal(value)
  if (value === 'none') stopPolling()
  else startPolling()
}

// picks polling back up on load if a currency was already selected in an
// earlier session
if (currency() !== 'none') startPolling()

export const CURRENCY_LABEL: Record<Exclude<Currency, 'none'>, string> = {
  usd: 'USD',
  eur: 'EUR',
  gbp: 'GBP'
}

const CURRENCY_SYMBOL: Record<Exclude<Currency, 'none'>, string> = {
  usd: '$',
  eur: '€',
  gbp: '£'
}

// sats (not msat) -> fiat, in whichever currency is currently selected -
// null whenever there's nothing to show yet (disabled, or no rate fetched
// since the currency was picked/the app loaded)
export const satsToFiat = (sats: number): number | null => {
  const c = currency()
  if (c === 'none') return null
  const r = rates()
  if (!r) return null
  return (sats / 100_000_000) * r[c]
}

// formatted like "$12.34" - null under the same conditions as satsToFiat,
// so callers can gate a <Show> on it directly
export const formatFiat = (sats: number): string | null => {
  const value = satsToFiat(sats)
  const c = currency()
  if (value === null || c === 'none') return null
  return `${CURRENCY_SYMBOL[c]}${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`
}
