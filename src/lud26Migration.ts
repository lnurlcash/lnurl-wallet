import {bytesToHex} from '@noble/hashes/utils.js'
import {ck1Pubkey, isCk1, noteK1, serverOf} from './lnurlcash'
import {seedNoteKeys} from './cashSecrets'
import {registeredAddresses, type RegisteredAddress} from './addressRegistry'
import type {Bearer} from './storage'

// What LUD-26 left for a holder to do by hand - surfaced by
// MigrationBanner.tsx (app-wide), the Wallet page (notes) and the Address
// page (addresses):
//
// - an address registered before LUD-26 is still paid the old way, onto
//   keys an ordinary rescan no longer walks, until it is moved to a share
//   (AddressDialog's "Move to a new key", a LUD-26 PUT)
// - a key-path note (ck1) held outside this seed's LUD-26 chains - made
//   before the upgrade, or received from someone else - is perfectly
//   spendable, but a restore from the seed finds it only through the legacy
//   sweep (or not at all, for a received one); a refresh rotates it onto
//   the wallet chain
//
// Plain bearer notes (a hash preimage) are never seed-derived, before or
// after, so they never count.

export const addressesToMigrate = (): RegisteredAddress[] =>
  registeredAddresses().filter(a => a.share === undefined)

// unspent, browser-held ck1 notes whose key this seed's LUD-26 chains don't
// cover. Empty while the wallet is locked (no cash root to derive from) -
// never a false alarm.
export const notesToMigrate = (bearers: Bearer[]): Bearer[] => {
  const byDomain = new Map<string, Set<string>>()
  const keysAt = (domain: string): Set<string> => {
    let keys = byDomain.get(domain)
    if (!keys) {
      const shares = registeredAddresses()
        .filter(a => a.share !== undefined && serverOf(a.server) === domain)
        .map(a => ({share: a.share!, upTo: a.nextScanIndex ?? 0}))
      keys = seedNoteKeys(domain, shares)
      byDomain.set(domain, keys)
    }
    return keys
  }
  return bearers.filter(b => {
    if (b.spent || b.deviceId) return false
    const k1 = noteK1(b.url)
    if (!k1 || !isCk1(k1)) return false
    const q = ck1Pubkey(k1)
    if (!q) return false
    const keys = keysAt(serverOf(b.url))
    return keys.size > 0 && !keys.has(bytesToHex(q))
  })
}
