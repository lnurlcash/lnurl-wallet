// Point of Sale's own pure logic - the keypad's amount entry, and reading
// back what verbs.ts's lnaddress.invoice/lnaddress.checkPayment returned.
// No wallet access, no network: plain data in, plain data out.

// 99,999,999 sats - just under 1 BTC, far past anything a till rings up,
// and safely inside a msat Number.isSafeInteger
export const MAX_DIGITS = 8

export const KEYPAD_KEYS = [
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'C',
  '0',
  '⌫'
] as const

// `amount` is the typed digit string (never a number, so a leading "0"
// can't sneak in and a cleared display reads "0", not "")
export const pressKey = (amount: unknown, key: unknown): string => {
  const current = /^\d+$/.test(String(amount ?? '')) ? String(amount) : '0'
  const k = String(key ?? '')
  if (k === 'C') return '0'
  if (k === '⌫') return current.length > 1 ? current.slice(0, -1) : '0'
  if (!/^\d$/.test(k)) return current
  const next = current === '0' ? k : current + k
  return next.length > MAX_DIGITS ? current : next
}

export const amountSats = (amount: unknown): number => {
  const n = Number(amount)
  return Number.isSafeInteger(n) && n > 0 ? n : 0
}

export const formatAmount = (amount: unknown): string =>
  `${amountSats(amount).toLocaleString()} sats`

type Invoice = {
  address: string
  amountSat: number
  pr: string
  verify: string | null
} | null

type PaymentStatus = {
  pr: string
  settled: boolean
  mismatch?: boolean
  error?: string
  claimedSats?: number | null
  claimError?: string
} | null

const asInvoice = (value: unknown): Invoice =>
  value && typeof (value as {pr?: unknown}).pr === 'string'
    ? (value as Invoice)
    : null

// a status only counts for the invoice it was fetched for - after "New
// sale", the previous sale's own (settled) status is still in state until
// the first poll of the new invoice replaces it
const statusFor = (invoice: unknown, status: unknown): PaymentStatus => {
  const inv = asInvoice(invoice)
  const st = status as PaymentStatus
  return inv && st && st.pr === inv.pr ? st : null
}

export const hasInvoice = (invoice: unknown): boolean => !!asInvoice(invoice)

export const canCharge = (address: unknown, amount: unknown): boolean =>
  !!(address as {address?: string} | null)?.address && amountSats(amount) > 0

export const isPaid = (invoice: unknown, status: unknown): boolean =>
  statusFor(invoice, status)?.settled === true

// still waiting on an invoice the mint can report on, that hasn't settled
// and hasn't come back for a different invoice than the one shown
export const keepPolling = (invoice: unknown, status: unknown): boolean => {
  const inv = asInvoice(invoice)
  if (!inv?.verify) return false
  const st = statusFor(invoice, status)
  return !st?.settled && !st?.mismatch
}

export const awaitingPayment = (invoice: unknown, status: unknown): boolean =>
  hasInvoice(invoice) && !isPaid(invoice, status)

export const invoiceUri = (invoice: unknown): string => {
  const inv = asInvoice(invoice)
  return inv ? `lightning:${inv.pr}` : ''
}

export const invoiceAmount = (invoice: unknown): string =>
  formatAmount(asInvoice(invoice)?.amountSat)

export const statusText = (invoice: unknown, status: unknown): string => {
  const inv = asInvoice(invoice)
  if (!inv) return ''
  if (!inv.verify) {
    return "This mint doesn't report payment status - once the customer has paid, check your notes on the Mint page."
  }
  const st = statusFor(invoice, status)
  if (st?.mismatch) return st.error ?? ''
  if (st?.error)
    return `Waiting for payment... (last check failed: ${st.error})`
  return `Waiting for payment to ${inv.address}...`
}

export const claimText = (invoice: unknown, status: unknown): string => {
  const st = statusFor(invoice, status)
  if (!st?.settled) return ''
  if (st.claimError) {
    return `Couldn't add it to this wallet yet (${st.claimError}) - use "Check notes" on the Mint page.`
  }
  if (st.claimedSats === null || st.claimedSats === undefined) {
    return 'Check your notes on the Mint page to add it to this wallet.'
  }
  if (st.claimedSats === 0) {
    return 'Already picked up by an earlier check - see your Wallet.'
  }
  return `${st.claimedSats.toLocaleString()} sats added to your wallet.`
}
