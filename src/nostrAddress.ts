import {bech32} from '@scure/base'

// NIP-19's npub: classic bech32 (BIP-173, not bech32m - Nostr predates
// BIP-350's checksum), hrp "npub", wrapping a 32-byte x-only pubkey.
// Optionally given alongside a username claim (AddressDialog.tsx) so
// SERVICE can also serve it as a NIP-05 identity - sent exactly as typed
// (see lib/addresses.ts's registerUsername), never decoded to raw bytes
// here: SERVICE decodes it itself (lnurl-mint's own bech32m.decode_npub,
// despite the module name, implements classic bech32 for this one value -
// see its own docstring), so this is purely a client-side sanity check
// before submitting, not something this wallet needs the pubkey bytes for.
export const isValidNpub = (value: string): boolean => {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed.startsWith('npub1')) return false
  try {
    const decoded = bech32.decode(trimmed as `${string}1${string}`, false)
    return (
      decoded.prefix === 'npub' && bech32.fromWords(decoded.words).length === 32
    )
  } catch {
    return false
  }
}
