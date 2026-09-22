import toast, {type ToastPosition} from 'solid-toast'

export enum NotifyKind {
  SUCCESS = 'success',
  ERROR = 'error',
  LOADING = 'loading'
}

// position is a per-call override of index.tsx's <Toaster position="top-right">
// default - solid-toast groups toasts by their own resolved position, so a
// single Toaster instance can show some at the default corner and others
// (e.g. AddressAutoScanner's background-found-funds toast, which wants to
// be noticed at the bottom of the screen rather than blend into the usual
// top-right stream of action confirmations) elsewhere at the same time.
export const notify = (
  message: string,
  _type: NotifyKind | null = null,
  position?: ToastPosition
): void => {
  const options = position ? {position} : undefined
  switch (_type) {
    case NotifyKind.SUCCESS:
      toast.success(message, options)
      break
    case NotifyKind.ERROR:
      toast.error(message, options)
      break
    case NotifyKind.LOADING:
      toast.loading(message, options)
      break
    default:
      toast(message, options)
  }
}

// awaited inside the try so a rejected writeText (permission denied,
// document not focused) actually lands in the catch - fire-and-forget made
// the failure toast unreachable and the rejection unhandled
export const copyToClipboard = async (text: string): Promise<void> => {
  try {
    await navigator.clipboard.writeText(text)
    notify('Copied to clipboard!', NotifyKind.SUCCESS)
  } catch (err) {
    notify('Failed to copy to clipboard.', NotifyKind.ERROR)
  }
}

// every caller of this pastes an lnurl/invoice/lightning-address value. A
// `lightning:` URI scheme prefix (how some wallets/QR readers hand these
// off) is always stripped. The rest is lowercased only when it's bech32
// (LNURL, bolt11) or a Lightning Address, both case-insensitive by spec -
// a raw lnurlw://, lnurlp://, lnurlc://, keyauth:// or http(s):// URL
// carries a query string (e.g. a note's own k1 secret) that isn't
// guaranteed to be, so those are left exactly as pasted
const CASE_SENSITIVE_SCHEME = /^(https?|lnurlw|lnurlp|lnurlc|keyauth):\/\//i

export const pasteFromClipboard = async (): Promise<string | null> => {
  try {
    const text = (await navigator.clipboard.readText())
      .trim()
      .replace(/^lightning:/i, '')
    return CASE_SENSITIVE_SCHEME.test(text) ? text : text.toLowerCase()
  } catch (err) {
    notify('Failed to paste from clipboard.', NotifyKind.ERROR)
    return null
  }
}

export const nfcSupported = (): boolean =>
  typeof window !== 'undefined' && 'NDEFReader' in window

// reads one NFC tag and normalizes its payload the same way
// pasteFromClipboard normalizes a pasted value, so the result can be handed
// to exactly the same onScan-style callbacks every paste-input-row already
// wires up. Web NFC models a read as a "reading" event on an open scan
// session rather than a one-shot call - this opens one, waits for exactly
// one reading (or a reading error), then lets the session lapse; there's no
// narrower "read once" primitive in the API itself. `url`/`text` cover
// every NDEF payload this wallet's own writer (or any standard phone
// "write NFC tag" tool) would produce for an lnurl/lightning: URI - a tag
// carrying anything else isn't something this wallet knows how to read as
// a note or a mint address, so it's treated the same as a failed read.
export const readNfcTag = async (): Promise<string | null> => {
  if (!nfcSupported()) {
    notify(
      "This browser can't read NFC tags - try Chrome on Android.",
      NotifyKind.ERROR
    )
    return null
  }
  try {
    const reader = new NDEFReader()
    const raw = await new Promise<string>((resolve, reject) => {
      reader.onreadingerror = () =>
        reject(new Error('Could not read that tag - try again.'))
      reader.onreading = event => {
        const record = event.message.records.find(
          r => (r.recordType === 'url' || r.recordType === 'text') && r.data
        )
        if (!record?.data) {
          reject(new Error('That tag has no readable URL or text on it.'))
          return
        }
        resolve(new TextDecoder(record.encoding || 'utf-8').decode(record.data))
      }
      reader.scan().catch(reject)
    })
    const text = raw.trim().replace(/^lightning:/i, '')
    return CASE_SENSITIVE_SCHEME.test(text) ? text : text.toLowerCase()
  } catch (err) {
    notify(
      (err as Error).message || 'Failed to read NFC tag.',
      NotifyKind.ERROR
    )
    return null
  }
}

// A Lightning node pubkey from nodeUri, not the SERVICE's mintPubkey.  A
// dedicated SERVICE signing key is deliberately not a routable node identity.
export const mempoolNodeUrl = (pubkey: string): string =>
  `https://mempool.space/lightning/node/${pubkey}`

export const msatToSats = (msat: number): string =>
  (msat / 1000).toLocaleString()

export const satsToMsat = (sats: string | number): number =>
  Math.round(Number(sats) * 1000)

// rounds up to the next whole sat - for an msat amount about to be
// requested as an invoice, where sub-sat precision (e.g. from a mint fee's
// percentage cut, see grossUpForMintFee) isn't reliably payable
export const ceilMsatToSat = (msat: number): number =>
  Math.ceil(msat / 1000) * 1000

// rounds down to the nearest whole sat - for a fee-adjusted amount shown
// as an upper bound: rounding up there would advertise a note value that
// isn't actually reachable
export const floorMsatToSat = (msat: number): number =>
  Math.floor(msat / 1000) * 1000

export const formatDate = (ts: number): string => new Date(ts).toLocaleString()

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, {
  numeric: 'auto'
})
const RELATIVE_TIME_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31536000],
  ['month', 2592000],
  ['week', 604800],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60]
]

// "5 minutes ago", "yesterday", etc, via the built-in locale-aware
// formatter - always a past timestamp here, so this doesn't handle future
// ones beyond what RelativeTimeFormat does on its own
export const formatRelativeTime = (ts: number): string => {
  const seconds = Math.round((Date.now() - ts) / 1000)
  if (seconds < 5) return 'just now'
  for (const [unit, secondsInUnit] of RELATIVE_TIME_UNITS) {
    if (seconds >= secondsInUnit) {
      return relativeTimeFormatter.format(
        -Math.round(seconds / secondsInUnit),
        unit
      )
    }
  }
  return relativeTimeFormatter.format(-seconds, 'second')
}
