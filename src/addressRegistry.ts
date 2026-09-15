import {createSignal} from 'solid-js'
import {serviceOriginOf} from './lnurlcash'
import {isValidNpub} from './nostrAddress'

// LUD-25 Part 2 (see 25.md's "Seed & derivation") - usernames THIS wallet
// has registered for itself at a mint (GET /register), each backed by its
// own watch-only branch (see cashSecrets.ts's cashAddressBranch). Distinct
// from trustedMints.ts's own `username` field, which caches the local-part
// a mint's own GENERIC identity was reached at ("mint" out of "mint@host")
// - unrelated to a holder's personally-claimed address, which has no home
// there. Not yet included in backup/restore (storage.ts) - a lost device
// loses track of what it registered, though the registration itself still
// stands at the mint and can be re-added by hand; the branch itself is
// always re-derivable from the seed regardless (see cashAddressBranch).
export type RegisteredAddress = {
  // full SERVICE origin, same convention as trustedMints.ts's own `server`
  server: string
  username: string
  registeredAt: number
  // whatever npub AddressDialog sent alongside this claim (see
  // lib/addresses.ts's registerUsername), purely for this device's own
  // display - SERVICE is the one that actually serves it as a NIP-05
  // identity, this is never re-sent anywhere, just shown back on the card
  // so a holder can confirm what they registered
  npub?: string
  // minutes between automatic "check notes" passes - undefined/0 means
  // off (see AddressAutoScanner.tsx). Per-address, not a single wallet-
  // wide setting, since different addresses see very different traffic
  autoScanMinutes?: number
  lastAutoScanAt?: number
  // resume floor for the next incremental "check notes" pass (as opposed
  // to a full "rescan all" from 0) - see addressRecovery.ts's
  // scanRegisteredAddress's own `nextScanIndex` return field for how this
  // advances: past whatever this device has itself confirmed used, and
  // past whatever index SERVICE's own payRequest metadata hints at
  // (LUD-25 Part 2's text/xpub, internalTransfer.ts's
  // parseInternalTransferHint) - never regresses
  nextScanIndex?: number
}

// mirrors AUTO_LOCK_OPTIONS/AUTO_LOCK_LABEL's own shape (autoLock.ts) -
// 0 is "off", not a real interval
export const ADDRESS_SCAN_OPTIONS = [0, 15, 30, 60, 360] as const
export type AddressScanMinutes = (typeof ADDRESS_SCAN_OPTIONS)[number]

export const ADDRESS_SCAN_LABEL: Record<AddressScanMinutes, string> = {
  0: 'Off',
  15: '15 minutes',
  30: '30 minutes',
  60: '1 hour',
  360: '6 hours'
}

const STORAGE_KEY = 'lnurlcash_registered_addresses'

// mirrors the mint's own _USERNAME_PATTERN (router.py) - this is a display/
// shape guard on OUR OWN stored records, not a substitute for the mint's
// own validation of what it actually accepted
const USERNAME_PATTERN = /^[a-z0-9_.-]{1,32}$/

const normalizeOrigin = (value: string): string | null => {
  const origin = serviceOriginOf(value)
  try {
    return new URL(origin).origin
  } catch {
    return null
  }
}

const readStored = (): RegisteredAddress[] => {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((a): RegisteredAddress[] => {
      const server =
        typeof a?.server === 'string' ? normalizeOrigin(a.server) : null
      const username =
        typeof a?.username === 'string' ? a.username.toLowerCase() : ''
      if (
        !server ||
        !USERNAME_PATTERN.test(username) ||
        typeof a?.registeredAt !== 'number'
      ) {
        return []
      }
      const npub =
        typeof a?.npub === 'string' && isValidNpub(a.npub) ? a.npub : undefined
      const autoScanMinutes = (
        ADDRESS_SCAN_OPTIONS as readonly number[]
      ).includes(a?.autoScanMinutes)
        ? (a.autoScanMinutes as AddressScanMinutes)
        : undefined
      const lastAutoScanAt =
        typeof a?.lastAutoScanAt === 'number' ? a.lastAutoScanAt : undefined
      const nextScanIndex =
        typeof a?.nextScanIndex === 'number' && a.nextScanIndex >= 0
          ? a.nextScanIndex
          : undefined
      return [
        {
          server,
          username,
          registeredAt: a.registeredAt,
          ...(npub && {npub}),
          ...(autoScanMinutes && {autoScanMinutes}),
          ...(lastAutoScanAt && {lastAutoScanAt}),
          ...(nextScanIndex && {nextScanIndex})
        }
      ]
    })
  } catch {
    return []
  }
}

const [registeredAddresses, setRegisteredAddressesSignal] =
  createSignal<RegisteredAddress[]>(readStored())
export {registeredAddresses}

const persist = (addresses: RegisteredAddress[]): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(addresses))
  setRegisteredAddressesSignal(addresses)
}

// Records a registration THIS device just made (or already knows about) -
// never calls the mint itself (see addresses.ts's registerUsername for
// that). Idempotent for a bare re-claim (same server+username+npub), so a
// caller can call this unconditionally right after a successful
// registerUsername without checking first - but a CHANGED npub (adding,
// clearing, or swapping one on a re-claim) updates this device's own
// record too, mirroring SERVICE's own "always replaces wholesale, never
// merges" npub semantics (see lib/addresses.ts's registerUsername)
export const addRegisteredAddress = (
  server: string,
  username: string,
  npub?: string
): void => {
  const origin = normalizeOrigin(server)
  if (!origin) throw new Error('Not a valid mint address.')
  const name = username.trim().toLowerCase()
  if (!USERNAME_PATTERN.test(name)) {
    throw new Error('Not a valid username.')
  }
  const current = registeredAddresses()
  const existing = current.find(a => a.server === origin && a.username === name)
  if (existing) {
    if (existing.npub === npub) return
    persist(current.map(a => (a === existing ? {...a, npub} : a)))
    return
  }
  persist([
    ...current,
    {server: origin, username: name, registeredAt: Date.now(), npub}
  ])
}

// Forgets this device's own record of a registration - purely local
// bookkeeping, never itself calls the mint (see addresses.ts's
// unregisterUsername for the network call that actually frees a username
// there; AddressDialog.tsx's own unclaim calls both together). Also
// useful standalone, to stop showing/scanning an address this device no
// longer controls.
export const removeRegisteredAddress = (
  server: string,
  username: string
): void => {
  const origin = normalizeOrigin(server)
  const name = username.trim().toLowerCase()
  persist(
    registeredAddresses().filter(
      a => !(a.server === origin && a.username === name)
    )
  )
}

const updateAddress = (
  server: string,
  username: string,
  patch: Partial<RegisteredAddress>
): void => {
  const origin = normalizeOrigin(server)
  const name = username.trim().toLowerCase()
  const current = registeredAddresses()
  if (!current.some(a => a.server === origin && a.username === name)) return
  persist(
    current.map(a =>
      a.server === origin && a.username === name ? {...a, ...patch} : a
    )
  )
}

// Settings.tsx-facing toggle (also surfaced on the address's own trusted-
// mint card, per Mint.tsx) - see AddressAutoScanner.tsx for what actually
// reads this
export const setAddressAutoScan = (
  server: string,
  username: string,
  minutes: AddressScanMinutes
): void => {
  updateAddress(server, username, {
    autoScanMinutes: minutes || undefined
  })
}

// Records where a "check notes" pass (manual or automatic) actually left
// off, so the NEXT one can resume past it instead of re-walking the same
// gap-limit stretch - see addressRecovery.ts's scanRegisteredAddress,
// whose own `nextScanIndex` return value is what every caller feeds
// straight back in here
export const markAddressScanned = (
  server: string,
  username: string,
  nextScanIndex: number,
  at: number = Date.now()
): void => {
  updateAddress(server, username, {nextScanIndex, lastAutoScanAt: at})
}
