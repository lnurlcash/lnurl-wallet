import {createSignal} from 'solid-js'
import {serviceOriginOf} from './lnurlcash'

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
      return [{server, username, registeredAt: a.registeredAt}]
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
// that). A no-op if this exact server+username pair is already recorded,
// so a caller can call this unconditionally right after a successful
// registerUsername without checking first.
export const addRegisteredAddress = (
  server: string,
  username: string
): void => {
  const origin = normalizeOrigin(server)
  if (!origin) throw new Error('Not a valid mint address.')
  const name = username.trim().toLowerCase()
  if (!USERNAME_PATTERN.test(name)) {
    throw new Error('Not a valid username.')
  }
  const current = registeredAddresses()
  if (current.some(a => a.server === origin && a.username === name)) return
  persist([
    ...current,
    {server: origin, username: name, registeredAt: Date.now()}
  ])
}

// Forgets this device's own record of the registration - never un-registers
// it at the mint (this mint's own /register has no such endpoint; the name
// simply stays claimed there). Only for "stop showing/scanning this here."
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
