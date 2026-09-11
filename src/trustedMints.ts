import {createSignal} from 'solid-js'
import {serviceOriginOf, type MintAddressInfo} from './lnurlcash'

// A mint's signing key (LUD-25 Offline verification's `mintPubkey`) - not a
// secret, just a public identity, so this is plain unencrypted localStorage,
// unlike bearer notes. A module-level signal (not wrapped behind
// WalletContext) so plain utility code - receive.ts in particular - can
// touch it too, not just UI components.
export type TrustedMint = {
  // Historical field name retained for backup compatibility.  The value is
  // the full SERVICE origin, including scheme and non-default port, never
  // merely a hostname.
  server: string
  mintPubkey: string
  addedAt: number
  // true once a bearer is held from this server - trust then follows
  // holding funds there, not a standalone opinion, so it can't be revoked
  // by deleting it here (see removeTrustedMint)
  locked: boolean
  // true when this pin came from a backup file or a stored bearer's cached
  // key rather than a live response from the server itself (see
  // mergeTrustedMints / grandfatherTrustedMint): excluded from offline
  // signature verification until a live response from this server
  // advertises the same key (any lockTrustedMint/addTrustedMint match
  // clears it) - a crafted backup could otherwise plant a pin for a mint it
  // controls and forge "signed" badges on worthless notes
  unconfirmed?: boolean
  // a DIFFERENT signing key this mint has since advertised (via a note
  // refresh, a lookup, etc) - staged for explicit holder review, never
  // auto-applied. The pinned mintPubkey above stays authoritative until
  // confirmTrustedMintRekey promotes this one; a key that silently rotated
  // would defeat the entire pinning model (a compromised mint could sign
  // unbacked notes that then show the "signed" badge).
  pendingMintPubkey?: string
  // best-effort node identity/capacity, cached from the mint-address
  // discovery endpoint (see lnurlcash.ts's fetchMintAddress) purely for
  // display (Mint.tsx) - absent for a mint that doesn't support it, or one
  // trusted before this wallet learned to ask. Never used for anything
  // security-relevant; mintPubkey above remains the only thing a note's
  // signature is ever checked against.
  nodeAlias?: string
  nodePubkey?: string
  nodeColor?: string
  nodeCapacityMsat?: number
  nodeNumChannels?: number
  nodeNumPeers?: number
  // advance warning of a planned shutdown (see lnurlcash.ts's
  // MintAddressInfo.sunsetDate), ISO-8601 - display-only, same caveats as
  // the node fields above: mint-supplied, never trusted for anything
  // security-relevant, just surfaced so a holder knows to move notes away
  // from this mint before that day
  sunsetDate?: string
  // this mint's total outstanding liability, msat (see lnurlcash.ts's
  // MintAddressInfo.outstandingNotesMsat) - cached the same best-effort way
  // as the node fields above, purely for display
  outstandingNotesMsat?: number
  // the local-part this mint was actually reached at ("mint" out of
  // "mint@host" - see lnurlcash.ts's lightningAddressUsername), cached so a
  // later quick-select (Mint.tsx) can reconstruct the exact address instead
  // of guessing "mint@<server>" for a mint that uses a different one.
  // Absent for a mint only ever looked up as a bech32 LNURL, which has no
  // such concept.
  username?: string
}

// the subset of TrustedMint that's cacheable display metadata, as opposed
// to the server/mintPubkey/addedAt/locked fields every entry has regardless
export type TrustedMintNodeInfo = {
  nodeAlias?: string
  nodePubkey?: string
  nodeColor?: string
  nodeCapacityMsat?: number
  nodeNumChannels?: number
  nodeNumPeers?: number
  sunsetDate?: string
  outstandingNotesMsat?: number
  username?: string
}

// distills a mint-address lookup (see lnurlcash.ts's fetchMintAddress) down
// to just the cacheable display fields above - shared by Mint.tsx's lookup
// flow and Mint.tsx's "add by address" widget, so both cache node info the
// same way rather than duplicating this shape-narrowing themselves.
// `username` is independent of whether the mint-address endpoint itself
// succeeded - it's cached even when info is null (no mint-address support,
// or the lookup hasn't run yet), since it comes straight from whichever
// payRequest URL was actually resolved, not from that endpoint's response.
export const mintAddressCacheInfo = (
  info: MintAddressInfo | null,
  username: string | null
): TrustedMintNodeInfo | undefined => {
  if (!info && !username) return undefined
  return {
    nodeAlias: info?.nodeAlias,
    nodePubkey: info?.nodePubkey,
    nodeColor: info?.nodeColor,
    nodeCapacityMsat: info?.nodeCapacityMsat,
    nodeNumChannels: info?.nodeNumChannels,
    nodeNumPeers: info?.nodeNumPeers,
    sunsetDate: info?.sunsetDate,
    outstandingNotesMsat: info?.outstandingNotesMsat,
    username: username ?? undefined
  }
}

// A small curated list of known public mints, for a one-click quick start -
// unrelated to whether any given entry ends up in the trusted-mints
// registry above (appearing here says nothing about a mint's signing key or
// whether this wallet has ever used it). The bare "@domain" form (see
// lnurlcash.ts's isBareMintDomain) rather than spelling out "mint@domain" -
// still resolves to the exact same address, just how these mints tend to
// actually display their own.
export const PUBLIC_MINTS = [
  '@mint.lnurlcash.com',
  '@mint.600.wtf',
  '@lnurl.21mint.me',
  '@moneyer.dev',
  '@lnurl.21linz.at',
  '@minty.exe.xyz'
]

const STORAGE_KEY = 'lnurlcash_trusted_mints'

// 33-byte compressed secp256k1 pubkey, hex
const PUBKEY_PATTERN = /^0[23][0-9a-f]{64}$/

const normalizeOrigin = (value: string): string | null => {
  const origin = serviceOriginOf(value)
  try {
    const parsed = new URL(origin)
    return parsed.origin
  } catch {
    return null
  }
}

const readStored = (): TrustedMint[] => {
  // same tolerance every other wallet-state module's own readStored already
  // has (cashSecrets.ts, currency.ts, offlineMode.ts) - this module gets
  // pulled in by anything that reads a mint's trust state, including a
  // bundled addon's helper file that may end up imported by a plain Node
  // unit test with no localStorage global at all
  let raw: string | null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return []
  }
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // shape-check every entry - this is the wallet's own persisted state
    // (so locked/pendingMintPubkey/unconfirmed are all kept), but a
    // tampered or corrupt record must not plant junk entries
    return parsed.flatMap((m): TrustedMint[] => {
      const server =
        typeof m?.server === 'string' ? normalizeOrigin(m.server) : null
      const mintPubkey =
        typeof m?.mintPubkey === 'string' ? m.mintPubkey.toLowerCase() : ''
      if (
        !server ||
        !PUBKEY_PATTERN.test(mintPubkey) ||
        typeof m?.addedAt !== 'number' ||
        typeof m?.locked !== 'boolean'
      ) {
        return []
      }
      const pendingMintPubkey =
        typeof m.pendingMintPubkey === 'string' &&
        PUBKEY_PATTERN.test(m.pendingMintPubkey.toLowerCase()) &&
        m.pendingMintPubkey.toLowerCase() !== mintPubkey
          ? m.pendingMintPubkey.toLowerCase()
          : undefined
      return [{...m, server, mintPubkey, pendingMintPubkey} as TrustedMint]
    })
  } catch {
    return []
  }
}

const [trustedMints, setTrustedMintsSignal] =
  createSignal<TrustedMint[]>(readStored())
export {trustedMints}

const persist = (mints: TrustedMint[]): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(mints))
  setTrustedMintsSignal(mints)
}

export const isMintTrusted = (server: string): boolean =>
  trustedMints().some(m => m.server === normalizeOrigin(server))

export const getTrustedMintPubkey = (server: string): string | null =>
  trustedMints().find(
    m => m.server === normalizeOrigin(server) && !m.unconfirmed
  )?.mintPubkey ?? null

// true when a server has a pin that came from a file/storage rather than a
// live response (see TrustedMint.unconfirmed) - callers should treat a
// bearer's own cached mintPubkey for such a server as equally uncorroborated
export const isMintUnconfirmed = (server: string): boolean =>
  trustedMints().some(
    m => m.server === normalizeOrigin(server) && m.unconfirmed
  )

// this mint's self-reported node color, for tinting its notes' background
// (see BearerCard) - purely cosmetic, absent whenever no mint-address
// lookup has ever cached one for this server. Mint-supplied, so it's only
// ever handed out as a plain hex color - anything else (a style sink can
// take far more than colors) is treated as absent
export const getTrustedMintNodeColor = (server: string): string | null => {
  const color = trustedMints().find(
    m => m.server === normalizeOrigin(server)
  )?.nodeColor
  return color && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color) ? color : null
}

// this mint's self-reported sunset date, for warning a holder to move
// notes away before it arrives - absent whenever no lookup has ever cached
// one for this server, or the mint has none planned. Mint-supplied and
// display-only (see TrustedMint.sunsetDate), so a value that doesn't even
// parse as a date is treated as absent rather than shown as-is
export const getTrustedMintSunsetDate = (server: string): string | null => {
  const date = trustedMints().find(
    m => m.server === normalizeOrigin(server)
  )?.sunsetDate
  return date && !Number.isNaN(Date.parse(date)) ? date : null
}

// the exact Lightning Address this mint was last reached at (see
// TrustedMint.username), for a quick-select that reconstructs it instead of
// guessing "mint@<server>" - null for a mint with no cached username
// (looked up as a bech32 LNURL, or trusted before this wallet learned to
// remember one)
export const getTrustedMintAddress = (server: string): string | null => {
  const username = trustedMints().find(
    m => m.server === normalizeOrigin(server)
  )?.username
  return username
    ? `${username}@${new URL(serviceOriginOf(server)).host}`
    : null
}

// what a lock/add attempt did with the advertised key - 'rekey-pending' is
// the security-relevant one: the mint advertised a DIFFERENT key than the
// pinned one, which was staged for review (pendingMintPubkey) instead of
// silently replacing it. Callers should surface that loudly (see
// WalletContext and Mint.tsx).
export type TrustKeyResult = 'added' | 'unchanged' | 'rekey-pending'

// Called whenever this wallet ends up holding (or already holds) a bearer
// from `server` - minting, receiving, splitting, merging, refreshing all
// route through WalletContext's addBearer/updateBearer, which is where
// this gets called from. Per "a mint you have a bearer from is trusted by
// default", this never asks and can't be refused - it silently trusts (or
// upgrades an already-trusted-but-unlocked entry) and locks it against
// removal. The one thing it never does silently is CHANGE the pinned key:
// a differing advertised key is staged as pendingMintPubkey for the holder
// to confirm or dismiss on the Mints page (see confirmTrustedMintRekey).
export const lockTrustedMint = (
  server: string,
  mintPubkey: string
): TrustKeyResult => {
  const origin = normalizeOrigin(server)
  const key = mintPubkey.trim().toLowerCase()
  if (!origin || !PUBKEY_PATTERN.test(key)) return 'unchanged'
  const current = trustedMints()
  const existing = current.find(m => m.server === origin)
  if (existing) {
    if (existing.mintPubkey === key) {
      if (existing.locked && !existing.unconfirmed) return 'unchanged'
      // a match here is a live response from the server advertising this
      // exact key - it corroborates an unconfirmed (file-sourced) pin
      persist(
        current.map(m =>
          m.server === origin ? {...m, locked: true, unconfirmed: undefined} : m
        )
      )
      return 'unchanged'
    }
    if (existing.pendingMintPubkey === key) return 'rekey-pending'
    persist(
      current.map(m =>
        m.server === origin ? {...m, pendingMintPubkey: key} : m
      )
    )
    return 'rekey-pending'
  }
  persist([
    ...current,
    {server: origin, mintPubkey: key, addedAt: Date.now(), locked: true}
  ])
  return 'added'
}

// unlock-time grandfathering of the mints behind already-stored bearers
// (WalletContext's activate) - the key claims come from local storage, not
// a live response, so an unknown server is added unlocked AND unconfirmed
// (excluded from signature verification until corroborated live, see
// TrustedMint.unconfirmed), and an existing entry is never locked or
// confirmed here. A differing claim still stages a rekey review. Live
// bearer operations (addBearer/updateBearer) go through lockTrustedMint
// instead, which is what corroborates and re-locks.
export const grandfatherTrustedMint = (
  server: string,
  mintPubkey: string
): TrustKeyResult => {
  const origin = normalizeOrigin(server)
  const key = mintPubkey.trim().toLowerCase()
  if (!origin || !PUBKEY_PATTERN.test(key)) return 'unchanged'
  const current = trustedMints()
  const existing = current.find(m => m.server === origin)
  if (existing) {
    if (existing.mintPubkey === key) return 'unchanged'
    if (existing.pendingMintPubkey === key) return 'rekey-pending'
    persist(
      current.map(m =>
        m.server === origin ? {...m, pendingMintPubkey: key} : m
      )
    )
    return 'rekey-pending'
  }
  persist([
    ...current,
    {
      server: origin,
      mintPubkey: key,
      addedAt: Date.now(),
      locked: false,
      unconfirmed: true
    }
  ])
  return 'added'
}

// Manual add from the Mints page, or a user-confirmed first encounter (see
// Mint.tsx's lookup) - unlocked, since no bearer necessarily backs it yet.
// Validates and throws instead of silently no-op'ing, since a human is
// waiting on the result either way. `nodeInfo` is whatever the mint-address
// lookup (if any) turned up alongside this pubkey - optional, since a
// manual add (Mint.tsx) or a mint without that endpoint has none to give.
// Same rule as lockTrustedMint for a server already pinned with a DIFFERENT
// key: staged for review (nodeInfo still refreshes - it's display-only),
// never overwritten in place.
export const addTrustedMint = (
  server: string,
  mintPubkey: string,
  nodeInfo?: TrustedMintNodeInfo
): TrustKeyResult => {
  const origin = normalizeOrigin(server)
  const key = mintPubkey.trim().toLowerCase()
  if (!origin) {
    throw new Error('Enter a valid SERVICE origin.')
  }
  if (!PUBKEY_PATTERN.test(key)) {
    throw new Error(
      'Signing key must be a 33-byte compressed pubkey (66 hex characters).'
    )
  }
  const current = trustedMints()
  const existing = current.find(m => m.server === origin)
  if (existing) {
    if (existing.mintPubkey === key) {
      // a match here is a live lookup corroborating the pin - it clears an
      // unconfirmed (file-sourced) flag
      persist(
        current.map(m =>
          m.server === origin ? {...m, ...nodeInfo, unconfirmed: undefined} : m
        )
      )
      return 'unchanged'
    }
    persist(
      current.map(m =>
        m.server === origin ? {...m, pendingMintPubkey: key, ...nodeInfo} : m
      )
    )
    return 'rekey-pending'
  }
  persist([
    ...current,
    {
      server: origin,
      mintPubkey: key,
      addedAt: Date.now(),
      locked: false,
      ...nodeInfo
    }
  ])
  return 'added'
}

// the holder confirms a mint's advertised new signing key (Mints page) -
// the staged candidate replaces the pin. Legitimate rotations, whether
// caused by a node move or a dedicated-key change, go through here; nothing
// else ever replaces a pin. Notes signed under the old key stop verifying
// offline, which LUD-25 expects: rotating such a note once re-signs it
// under the current key.
export const confirmTrustedMintRekey = (server: string): void => {
  const origin = normalizeOrigin(server)
  if (!origin) return
  const current = trustedMints()
  const existing = current.find(m => m.server === origin)
  if (!existing?.pendingMintPubkey) return
  persist(
    current.map(m =>
      m.server === origin
        ? {
            ...m,
            mintPubkey: existing.pendingMintPubkey!,
            pendingMintPubkey: undefined,
            unconfirmed: undefined
          }
        : m
    )
  )
}

// the holder rejects the advertised new key - the staged candidate is
// dropped, the original pin stays. Worth doing only when the change is
// unexpected; the old key stays authoritative either way until confirmed.
export const dismissTrustedMintRekey = (server: string): void => {
  const origin = normalizeOrigin(server)
  if (!origin) return
  const current = trustedMints()
  if (!current.some(m => m.server === origin)) return
  persist(
    current.map(m =>
      m.server === origin ? {...m, pendingMintPubkey: undefined} : m
    )
  )
}

// refreshes just the cached display info (Mint.tsx) for a server already
// in the list - never touches mintPubkey/addedAt/locked, and no-ops for a
// server that isn't trusted yet (that's addTrustedMint's job, which takes
// the same info directly alongside the pubkey it's trusting for the first
// time). Called opportunistically whenever a lookup re-discovers a mint
// address for a mint this wallet already trusts, so the cache doesn't just
// freeze at whatever was known the moment trust was first established.
export const cacheTrustedMintNodeInfo = (
  server: string,
  nodeInfo: TrustedMintNodeInfo
): void => {
  const origin = normalizeOrigin(server)
  if (!origin) return
  const current = trustedMints()
  if (!current.some(m => m.server === origin)) return
  persist(current.map(m => (m.server === origin ? {...m, ...nodeInfo} : m)))
}

// only succeeds for entries not backed by a held bearer - see
// TrustedMint.locked
export const removeTrustedMint = (server: string): void => {
  const origin = normalizeOrigin(server)
  const entry = trustedMints().find(m => m.server === origin)
  if (!entry) return
  if (entry.locked) {
    throw new Error("Can't remove - you hold a bearer note from this mint.")
  }
  persist(trustedMints().filter(m => m.server !== origin))
}

// releases the lock once this wallet no longer holds any unspent bearer
// from `server` - lockTrustedMint only ever sets locked to true, so without
// this a mint stayed irrevocably locked forever, even after every note from
// it was spent and cleared (see WalletContext's reconciliation effect,
// which calls this whenever the held bearers change). The entry and its
// pinned key are left alone - only the removeTrustedMint guard comes off;
// holding another bearer from this mint later re-locks it the same way the
// first one did.
export const unlockTrustedMint = (server: string): void => {
  const origin = normalizeOrigin(server)
  const current = trustedMints()
  const existing = current.find(m => m.server === origin)
  if (!existing?.locked) return
  persist(current.map(m => (m.server === origin ? {...m, locked: false} : m)))
}

// wipes the whole registry - part of forgetting a wallet (WalletContext's
// forgetWallet): nothing about a wallet's mints (including otherwise
// irremovable locked pins) should linger on the device after it
export const clearTrustedMints = (): void => {
  localStorage.removeItem(STORAGE_KEY)
  setTrustedMintsSignal([])
}

// merges a backup's trusted mints in by server - a server already known on
// this device keeps its own current entry rather than being overwritten by
// the backup's (possibly stale) copy. Three fields never come across from a
// file: `locked` (a crafted backup could otherwise plant irremovable junk
// entries - real locks re-establish themselves from held bearers on live
// operations anyway) and `pendingMintPubkey` (a key change must be
// re-detected from the mint's own live responses, never staged by a file).
// Every merged entry is marked `unconfirmed`, keeping it out of offline
// signature verification until a live response from that server advertises
// the same key (a crafted backup could otherwise forge "signed" badges)
export const mergeTrustedMints = (incoming: TrustedMint[]): number => {
  const current = trustedMints()
  const knownServers = new Set(current.map(m => m.server))
  const merged = [...current]
  let added = 0
  for (const mint of incoming) {
    const origin =
      typeof mint?.server === 'string' ? normalizeOrigin(mint.server) : null
    if (
      !origin ||
      typeof mint?.mintPubkey !== 'string' ||
      typeof mint?.addedAt !== 'number' ||
      !PUBKEY_PATTERN.test(mint.mintPubkey.toLowerCase())
    ) {
      continue
    }
    if (knownServers.has(origin)) continue
    merged.push({
      server: origin,
      mintPubkey: mint.mintPubkey.toLowerCase(),
      addedAt: mint.addedAt,
      locked: false,
      unconfirmed: true,
      nodeAlias:
        typeof mint.nodeAlias === 'string' ? mint.nodeAlias : undefined,
      nodePubkey:
        typeof mint.nodePubkey === 'string' &&
        PUBKEY_PATTERN.test(mint.nodePubkey.toLowerCase())
          ? mint.nodePubkey.toLowerCase()
          : undefined,
      nodeColor:
        typeof mint.nodeColor === 'string' ? mint.nodeColor : undefined,
      nodeCapacityMsat:
        typeof mint.nodeCapacityMsat === 'number'
          ? mint.nodeCapacityMsat
          : undefined,
      nodeNumChannels:
        typeof mint.nodeNumChannels === 'number'
          ? mint.nodeNumChannels
          : undefined,
      nodeNumPeers:
        typeof mint.nodeNumPeers === 'number' ? mint.nodeNumPeers : undefined,
      sunsetDate:
        typeof mint.sunsetDate === 'string' ? mint.sunsetDate : undefined,
      outstandingNotesMsat:
        typeof mint.outstandingNotesMsat === 'number'
          ? mint.outstandingNotesMsat
          : undefined,
      username: typeof mint.username === 'string' ? mint.username : undefined
    })
    knownServers.add(origin)
    added++
  }
  if (added > 0) persist(merged)
  return added
}
