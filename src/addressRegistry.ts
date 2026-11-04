import {createSignal} from 'solid-js'
import {serviceOriginOf, isBolt11Invoice} from './lnurlcash'
import {isValidNpub} from './nostrAddress'
import {LEGACY_FIRST_ADDRESS_SLOT} from './cashSecrets'

// LUD-26 - usernames THIS wallet has registered for itself at a mint, each
// backed by its own share (see cashSecrets.ts's addressShareCx1). Distinct
// from trustedMints.ts's own `username` field, which caches the local-part
// a mint's own GENERIC identity was reached at ("mint" out of "mint@host")
// - unrelated to a holder's personally-claimed address, which has no home
// there. Not yet included in backup/restore (storage.ts) - a lost device
// loses track of what it registered, though the registration itself still
// stands at the mint and can be reclaimed by typing the name into
// AddressDialog's claim view (no re-POST needed); the share itself is
// always re-derivable from the seed regardless (see addressShareCx1).
// which key a registration's notes are credited to: a LUD-26 share, or a
// pre-LUD-26 branch (`slot` undefined: the old domain branch itself)
export type AddressKey =
  {kind: 'share'; share: number} | {kind: 'legacy'; slot?: number}

export const addressKeyOf = (a: {share?: number; slot?: number}): AddressKey =>
  a.share !== undefined
    ? {kind: 'share', share: a.share}
    : {kind: 'legacy', ...(a.slot !== undefined && {slot: a.slot})}

export const sameKey = (a: AddressKey, b: AddressKey): boolean =>
  a.kind === 'share'
    ? b.kind === 'share' && a.share === b.share
    : b.kind === 'legacy' && a.slot === b.slot

export type RegisteredAddress = {
  // full SERVICE origin, same convention as trustedMints.ts's own `server`
  server: string
  username: string
  registeredAt: number
  // the share S/0'/2/n' whose cx1 is on file (cashSecrets.ts's
  // addressShareCx1). Undefined for a registration made before LUD-26,
  // which the mint keeps paying the old way until AddressDialog moves it
  // to a share (updateUsername) - see `slot` for which old branch it is.
  share?: number
  // a pre-LUD-26 registration only: which hardened child of the old domain
  // branch it registered (cashSecrets.ts's LEGACY_FIRST_ADDRESS_SLOT), or
  // undefined for the domain branch itself
  slot?: number
  // keys this address was moved off (moveRegisteredAddress): LUD-26 leaves
  // notes credited there where they are, so a full rescan sweeps them too
  retired?: AddressKey[]
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
  // advances: past whatever this device has itself confirmed used - never
  // regresses
  nextScanIndex?: number
  // LUD-26 address fee: the invoice the registration was answered with,
  // kept until it is seen paid (addressRecovery.ts's checkAddressFee). The
  // mint holds the name only until this invoice expires - unpaid by then,
  // the claim lapses and the name is free for anyone again
  feeInvoice?: string
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

const readSlot = (value: unknown): number | undefined =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= LEGACY_FIRST_ADDRESS_SLOT
    ? value
    : undefined

const readShare = (value: unknown): number | undefined =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 0 &&
  value < 2 ** 31
    ? value
    : undefined

const readKey = (value: any): AddressKey | null => {
  if (value?.kind === 'share') {
    const share = readShare(value.share)
    return share === undefined ? null : {kind: 'share', share}
  }
  if (value?.kind === 'legacy') {
    const slot = readSlot(value.slot)
    return {kind: 'legacy', ...(slot !== undefined && {slot})}
  }
  return null
}

const readRetired = (value: unknown): AddressKey[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const keys = value.flatMap(k => readKey(k) ?? [])
  return keys.length > 0 ? keys : undefined
}

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
      const share = readShare(a?.share)
      const slot = share === undefined ? readSlot(a?.slot) : undefined
      const retired = readRetired(a?.retired)
      const feeInvoice =
        typeof a?.feeInvoice === 'string' && isBolt11Invoice(a.feeInvoice)
          ? a.feeInvoice
          : undefined
      return [
        {
          server,
          username,
          registeredAt: a.registeredAt,
          ...(share !== undefined && {share}),
          ...(slot !== undefined && {slot}),
          ...(retired && {retired}),
          ...(npub && {npub}),
          ...(autoScanMinutes && {autoScanMinutes}),
          ...(lastAutoScanAt && {lastAutoScanAt}),
          ...(nextScanIndex && {nextScanIndex}),
          ...(feeInvoice && {feeInvoice})
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

// Every write below starts from what is in storage NOW, never this
// signal's copy: another tab (or the installed app) on the same wallet
// writes here too, and writing back a stale in-memory list would undo its
// changes - e.g. revert a moved address to its old key and scan index.
// A `storage` event (fired in the OTHER tabs on every write) keeps each
// tab's signal current.
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
// `share` is the share now on file; a pre-LUD-26 registration (found by a
// reclaim) has none, only its old `slot`.
export const addRegisteredAddress = (
  server: string,
  username: string,
  npub?: string,
  share?: number,
  slot?: number
): void => {
  const origin = normalizeOrigin(server)
  if (!origin) throw new Error('Not a valid mint address.')
  const name = username.trim().toLowerCase()
  if (!USERNAME_PATTERN.test(name)) {
    throw new Error('Not a valid username.')
  }
  dropForgotten(origin, name)
  const current = readStored()
  const existing = current.find(a => a.server === origin && a.username === name)
  if (share !== undefined) markShareUsed(origin, share)
  const legacySlot = share === undefined ? slot : undefined
  if (existing) {
    if (
      existing.npub === npub &&
      existing.share === share &&
      existing.slot === legacySlot
    ) {
      return
    }
    persist(
      current.map(a =>
        a === existing ? {...a, npub, share, slot: legacySlot} : a
      )
    )
    return
  }
  persist([
    ...current,
    {
      server: origin,
      username: name,
      registeredAt: Date.now(),
      ...(share !== undefined && {share}),
      ...(legacySlot !== undefined && {slot: legacySlot}),
      npub
    }
  ])
}

// A SERVICE never accepts a share twice ("cx1 already used"), even after
// its name was unregistered, so the next share at a mint is one past every
// share this device ever used there - kept as a counter, since an
// unregistered address leaves no record behind. A share used from another
// device on the same seed isn't known here: AddressDialog moves on to the
// next one when the SERVICE says so.
const SHARE_COUNTER_KEY = 'lnurlcash_lud26_share_indices'

const readShareCounters = (): Record<string, number> => {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(SHARE_COUNTER_KEY) ?? '{}'
    )
    const counters: Record<string, number> = Object.create(null)
    if (typeof parsed !== 'object' || parsed === null) return counters
    for (const [origin, value] of Object.entries(parsed)) {
      if (readShare(value) !== undefined) counters[origin] = value as number
    }
    return counters
  } catch {
    return Object.create(null)
  }
}

const markShareUsed = (origin: string, share: number): void => {
  const counters = readShareCounters()
  if ((counters[origin] ?? 0) > share) return
  counters[origin] = share + 1
  localStorage.setItem(SHARE_COUNTER_KEY, JSON.stringify(counters))
}

export const nextAddressShare = (server: string): number => {
  const origin = normalizeOrigin(server)
  if (!origin) return 0
  const known = [...registeredAddresses(), ...forgottenAddresses()]
    .filter(a => a.server === origin && a.share !== undefined)
    .map(a => a.share! + 1)
  return Math.max(readShareCounters()[origin] ?? 0, ...known)
}

// records a share as spent at `server` without a registration to show for
// it - one the SERVICE refused as "cx1 already used", or one handed to a
// registration that failed after the request went out
export const skipAddressShare = (server: string, share: number): void => {
  const origin = normalizeOrigin(server)
  if (origin) markShareUsed(origin, share)
}

// moves this device's record of a registration to the share it was just
// moved to (lib/addresses.ts's updateUsername): the old slot is gone, and
// the scan floor starts over at the new share's index 0
// `alsoRetire`: keys the address was on before that this device never
// recorded moving off (see candidateAddressKeys) - still swept too
export const moveRegisteredAddress = (
  server: string,
  username: string,
  share: number,
  alsoRetire: AddressKey[] = []
): void => {
  const origin = normalizeOrigin(server)
  if (!origin) return
  markShareUsed(origin, share)
  const name = username.trim().toLowerCase()
  const record = readStored().find(
    a => a.server === origin && a.username === name
  )
  if (!record) return
  updateAddress(server, username, {
    share,
    slot: undefined,
    nextScanIndex: undefined,
    retired: [
      ...(record.retired ?? []),
      ...alsoRetire,
      addressKeyOf(record)
    ].filter(
      (k, i, all) =>
        all.findIndex(o => sameKey(o, k)) === i &&
        !(k.kind === 'share' && k.share === share)
    )
  })
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
    readStored().filter(a => !(a.server === origin && a.username === name))
  )
}

// Names this device forgot (AddressDialog's "Forget on this device") -
// remembered only so the claim view can offer them back as a one-click
// reclaim (see addressRecovery.ts's checkAddressOwnership for how a
// reclaim decides whether the mint still has it on this wallet's branch).
// Cleared again the moment the name is re-added by any route.
export type ForgottenAddress = {
  server: string
  username: string
  // kept so a reclaim knows which key the registration was made with, and
  // nextAddressShare never hands a forgotten name's share to a new one -
  // see RegisteredAddress
  share?: number
  slot?: number
}

const FORGOTTEN_KEY = 'lnurlcash_forgotten_addresses'

const readForgotten = (): ForgottenAddress[] => {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(FORGOTTEN_KEY) ?? '[]'
    )
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((a): ForgottenAddress[] => {
      const server =
        typeof a?.server === 'string' ? normalizeOrigin(a.server) : null
      const username =
        typeof a?.username === 'string' ? a.username.toLowerCase() : ''
      const share = readShare(a?.share)
      const slot = share === undefined ? readSlot(a?.slot) : undefined
      return server && USERNAME_PATTERN.test(username)
        ? [
            {
              server,
              username,
              ...(share !== undefined && {share}),
              ...(slot !== undefined && {slot})
            }
          ]
        : []
    })
  } catch {
    return []
  }
}

const [forgottenAddresses, setForgottenSignal] =
  createSignal<ForgottenAddress[]>(readForgotten())
export {forgottenAddresses}

const persistForgotten = (list: ForgottenAddress[]): void => {
  localStorage.setItem(FORGOTTEN_KEY, JSON.stringify(list))
  setForgottenSignal(list)
}

const dropForgotten = (origin: string, name: string): void => {
  const current = readForgotten()
  if (current.some(a => a.server === origin && a.username === name)) {
    persistForgotten(
      current.filter(a => !(a.server === origin && a.username === name))
    )
  }
}

// removeRegisteredAddress, plus remembering the name for a later reclaim
export const forgetRegisteredAddress = (
  server: string,
  username: string
): void => {
  const origin = normalizeOrigin(server)
  const name = username.trim().toLowerCase()
  const record = readStored().find(
    a => a.server === origin && a.username === name
  )
  removeRegisteredAddress(server, username)
  if (!origin) return
  dropForgotten(origin, name)
  persistForgotten([
    ...readForgotten(),
    {
      server: origin,
      username: name,
      ...(record?.share !== undefined && {share: record.share}),
      ...(record?.slot !== undefined && {slot: record.slot})
    }
  ])
}

// drops a forgotten name for good (it was taken by someone else, or the
// holder just doesn't want the reclaim offer any more)
export const dismissForgottenAddress = (
  server: string,
  username: string
): void => {
  const origin = normalizeOrigin(server)
  if (origin) dropForgotten(origin, username.trim().toLowerCase())
}

const updateAddress = (
  server: string,
  username: string,
  patch: Partial<RegisteredAddress>
): void => {
  const origin = normalizeOrigin(server)
  const name = username.trim().toLowerCase()
  const current = readStored()
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
// `key`: the key that pass walked - when the address was moved to another
// one meanwhile (moveRegisteredAddress), the old key's index means nothing
// for the new one, and is dropped
export const markAddressScanned = (
  server: string,
  username: string,
  nextScanIndex: number,
  at: number = Date.now(),
  key?: AddressKey
): void => {
  if (key) {
    const origin = normalizeOrigin(server)
    const name = username.trim().toLowerCase()
    const record = readStored().find(
      a => a.server === origin && a.username === name
    )
    if (!record || !sameKey(addressKeyOf(record), key)) return
  }
  updateAddress(server, username, {nextScanIndex, lastAutoScanAt: at})
}

// remembers (or, `pr` undefined, clears) the address fee invoice a
// registration is waiting on - see RegisteredAddress's `feeInvoice`
export const setAddressFeeInvoice = (
  server: string,
  username: string,
  pr: string | undefined
): void => {
  updateAddress(server, username, {feeInvoice: pr})
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', e => {
    if (e.key === STORAGE_KEY || e.key === null) {
      setRegisteredAddressesSignal(readStored())
    }
    if (e.key === FORGOTTEN_KEY || e.key === null) {
      setForgottenSignal(readForgotten())
    }
  })
}

// how far past what this device knows a move probes for the key on file
const PROBE_LEGACY_SLOTS = 10
const PROBE_SHARES = 10

// Every key of this seed a registration of `username` at `server` could be
// on file under, the recorded one (`current`) first. The record can be
// wrong: a move the mint accepted but this device never saved (the app
// closed, or an outdated build), or an old registration on a slot the
// record never knew. A move tries these in turn - the mint checks the
// proof before anything else, so a wrong one costs nothing.
export const candidateAddressKeys = (
  server: string,
  current: AddressKey
): AddressKey[] => {
  const keys: AddressKey[] = [current, {kind: 'legacy'}]
  for (let i = 0; i < PROBE_LEGACY_SLOTS; i++) {
    keys.push({kind: 'legacy', slot: LEGACY_FIRST_ADDRESS_SLOT + i})
  }
  const shares = nextAddressShare(server) + PROBE_SHARES
  for (let share = 0; share < shares; share++) {
    keys.push({kind: 'share', share})
  }
  return keys.filter((k, i) => keys.findIndex(o => sameKey(o, k)) === i)
}
