import {createSignal} from 'solid-js'

// LUD-11: a payRequest's second (invoice) callback response MAY set
// `disposable: false` to say the LNURL/Lightning Address that led here -
// not the invoice itself, which is always one-shot regardless - is meant
// to be kept around and reused. Per spec, absent/null/true means
// disposable (don't keep it); see lnurlcash.ts's requestInvoice for where
// that's parsed. Not a secret, just a convenience shortcut, so plain
// unencrypted localStorage, same as trustedMints.ts.
//
// Two separate registries, never merged: one for payRequests seen on the
// Mint page (places to mint FROM), one for MeltDialog's "pay to a
// Lightning Address" flow (places to melt/pay TO). A mint saying its own
// payRequest is storeable says nothing about whether it's also a sane
// melt destination, and vice versa - conflating them would surface a
// mint's minting address as a melt suggestion or the reverse.
export type StoreableLink = {
  address: string
  addedAt: number
  // LUD-25 Part 2's Internal transfer (25.md): whether this address's own
  // payRequest was last seen advertising a text/xpub metadata entry (see
  // mintRequest.ts's parseInternalTransferHint) - a CONFIRMED fact from an
  // actual lookup, never guessed (e.g. never inferred just because this
  // wallet happens to hold notes at the same mint - that alone says
  // nothing about whether the recipient registered a cx1 there). Only the
  // melt registry ever sets this (MeltDialog.tsx's own lookup is the one
  // place that actually fetches a melt address's payRequest); undefined
  // means "never confirmed either way," not "confirmed unsupported."
  internalTransfer?: boolean
}

const readStored = (key: string): StoreableLink[] => {
  const raw = localStorage.getItem(key)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // shape-check every entry - a tampered/corrupt record must not plant
    // junk entries into the registry
    return parsed.flatMap((l): StoreableLink[] => {
      if (typeof l?.address !== 'string' || typeof l?.addedAt !== 'number') {
        return []
      }
      return [
        {
          address: l.address,
          addedAt: l.addedAt,
          ...(typeof l.internalTransfer === 'boolean'
            ? {internalTransfer: l.internalTransfer}
            : {})
        }
      ]
    })
  } catch {
    return []
  }
}

const makeRegistry = (storageKey: string) => {
  const [links, setLinksSignal] = createSignal<StoreableLink[]>(
    readStored(storageKey)
  )

  const persist = (next: StoreableLink[]): void => {
    localStorage.setItem(storageKey, JSON.stringify(next))
    setLinksSignal(next)
  }

  // `internalTransfer` is only ever meaningful from the melt registry's own
  // caller (see addStoreableMeltAddress below) - the mint registry's own
  // add() calls simply never pass it, leaving every mint entry's own field
  // undefined. Re-adding an address already on file refreshes what's known
  // about it (e.g. a later lookup that now sees text/xpub where an earlier
  // one didn't) rather than silently no-op'ing past newer information.
  const add = (address: string, internalTransfer?: boolean): void => {
    const trimmed = address.trim()
    if (!trimmed) return
    const current = links()
    const existing = current.find(l => l.address === trimmed)
    if (existing) {
      if (
        internalTransfer !== undefined &&
        existing.internalTransfer !== internalTransfer
      ) {
        persist(
          current.map(l => (l === existing ? {...l, internalTransfer} : l))
        )
      }
      return
    }
    persist([
      ...current,
      {
        address: trimmed,
        addedAt: Date.now(),
        ...(internalTransfer !== undefined ? {internalTransfer} : {})
      }
    ])
  }

  const remove = (address: string): void => {
    persist(links().filter(l => l.address !== address))
  }

  const clear = (): void => {
    localStorage.removeItem(storageKey)
    setLinksSignal([])
  }

  return {links, add, remove, clear}
}

const mintRegistry = makeRegistry('lnurlcash_storeable_mints')
const meltRegistry = makeRegistry('lnurlcash_storeable_melt_addresses')

export const storeableMints = mintRegistry.links
export const addStoreableMint = mintRegistry.add
export const removeStoreableMint = mintRegistry.remove

export const storeableMeltAddresses = meltRegistry.links
export const addStoreableMeltAddress = meltRegistry.add
export const removeStoreableMeltAddress = meltRegistry.remove

// wipes both registries - part of forgetting a wallet (WalletContext's
// forgetWallet): nothing about a wallet's mints should linger after it
export const clearStoreableLinks = (): void => {
  mintRegistry.clear()
  meltRegistry.clear()
}
