import type {Vault, Note} from './vault'
import {
  fetchMintAddress,
  mintAddressUrl,
  serviceOriginOf,
  noteK1,
  noteSignature,
  verifyNoteSignature
} from '../lnurlcash'

export type MintPin = {
  origin: string
  key: string
  pending?: string
  confirmed: boolean
  alias?: string
  sunset?: string
}
/** Store first-seen issuer keys; changed keys remain pending until explicitly accepted. */
export const observeMint = async (
  vault: Vault,
  url: string,
  key: string
): Promise<void> => {
  if (!/^(02|03)[0-9a-f]{64}$/i.test(key))
    throw new Error('Invalid mint signing key.')
  key = key.toLowerCase()
  const origin = serviceOriginOf(url)
  const pins = (await vault.meta<MintPin[]>('mints')) ?? []
  const current = pins.find(pin => pin.origin === origin)
  if (!current) pins.push({origin, key, confirmed: true})
  else if (current.key === key) {
    current.confirmed = true
    delete current.pending
  } else current.pending = key
  await vault.setMeta('mints', pins)
}
/** Validate note artwork's signed badge against the pinned, live-confirmed issuer only. */
export const signedNote = (note: Note, pins: MintPin[]): boolean => {
  const pin = pins.find(
    pin => pin.origin === serviceOriginOf(note.url) && pin.confirmed
  )
  const k1 = noteK1(note.url),
    sig = noteSignature(note.url)
  return !!(
    pin &&
    k1 &&
    sig &&
    verifyNoteSignature(k1, note.amount, sig, pin.key)
  )
}
/** Accept or dismiss a staged signing-key rotation without silently changing trust. */
export const reviewMintKey = async (
  vault: Vault,
  origin: string,
  accept: boolean
): Promise<void> => {
  const pins = (await vault.meta<MintPin[]>('mints')) ?? []
  const pin = pins.find(pin => pin.origin === origin)
  if (!pin?.pending) throw new Error('No key change to review.')
  if (accept) {
    pin.key = pin.pending
    pin.confirmed = true
  }
  delete pin.pending
  await vault.setMeta('mints', pins)
}
/** Discover a mint's public identity through the existing protocol implementation. */
export const discoverMint = async (
  vault: Vault,
  address: string
): Promise<void> => {
  const info = await fetchMintAddress(mintAddressUrl(address))
  await observeMint(vault, address, info.mintPubkey)
  const pins = (await vault.meta<MintPin[]>('mints')) ?? []
  const pin = pins.find(value => value.origin === serviceOriginOf(address))!
  pin.alias = info.nodeAlias
  pin.sunset = info.sunsetDate
  await vault.setMeta('mints', pins)
}

/** Validate imported pins without trusting their claimed verification state. */
export const validatePins = (value: unknown): MintPin[] => {
  if (!Array.isArray(value) || value.length > 1000)
    throw new Error('Invalid mint pins.')
  return value.map(pin => {
    if (
      !pin ||
      typeof pin.origin !== 'string' ||
      typeof pin.key !== 'string' ||
      !/^(02|03)[0-9a-f]{64}$/i.test(pin.key) ||
      new URL(pin.origin).protocol !== 'https:' ||
      new URL(pin.origin).origin !== pin.origin
    )
      throw new Error('Invalid mint pin.')
    return {origin: pin.origin, key: pin.key.toLowerCase(), confirmed: false}
  })
}

/** Merge backup pins without replacing an already pinned issuer. */
export const importPins = async (
  vault: Vault,
  incoming: MintPin[]
): Promise<void> => {
  const pins = (await vault.meta<MintPin[]>('mints')) ?? []
  for (const pin of validatePins(incoming)) {
    if (!pins.some(existing => existing.origin === pin.origin)) pins.push(pin)
  }
  await vault.setMeta('mints', pins)
}
