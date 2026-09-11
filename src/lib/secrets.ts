// LUD-25: for a rotate/split/merge, the WALLET - not SERVICE - generates the
// replacement note's secret and discloses only its hash (h/h2 on the
// callback) - a fresh 32-byte value, the same size an actual Lightning
// payment preimage already is, though nothing is ever paid for it.
//
// How that secret is actually produced is host policy, not protocol: some
// consumers may want a seed-derived, recoverable secret (so a lost/
// reinstalled wallet can reconstruct it from nothing but a seed phrase);
// others are fine with plain randomness. This module defaults to plain
// randomness and lets a host override it via configureSecretProvider - see
// lnurlcash.ts, which wires this up to the wallet's own seed-derived cash
// root (cashSecrets.ts).
import {bytesToHex} from '@noble/hashes/utils.js'

export type SecretProvider = (domain: string) => string

// 32 cryptographically random bytes as hex - matches a real Lightning
// payment preimage's own size exactly, though nothing is ever paid for it.
// Do not "simplify" this to crypto.randomUUID(): a UUIDv4 fixes several bits
// to its version/variant per RFC 4122, so it carries strictly less entropy
// than 128 uniformly random bits, let alone 256.
const defaultSecretProvider: SecretProvider = () =>
  bytesToHex(crypto.getRandomValues(new Uint8Array(32)))

let secretProvider: SecretProvider = defaultSecretProvider

export const configureSecretProvider = (provider: SecretProvider): void => {
  secretProvider = provider
}

// used internally by request.ts's rotateNote/splitNote/mergeNotes - not
// meant to be called directly by an application (call configureSecretProvider
// instead, once, at startup)
export const generateSecret = (domain: string): string => secretProvider(domain)

// LUD-25 Part 2 counterpart to SecretProvider above - a ck1 ownership
// signature rather than a preimage, for a host that wants rotate/split/
// merge to be able to REISSUE a pubkey-bound output too (see
// request.ts's own use of this: it never downgrades an already pub/sig
// note back to a legacy one just because it got rotated). Returns null
// (never throws) whenever a pubkey-bound secret can't be produced right
// now - unconfigured (a host that hasn't wired up Part 2 at all, the
// default), or the underlying seed-derived key isn't currently available -
// callers fall back to the legacy provider in either case.
export type PubkeySecretProvider = (domain: string) => string | null

let pubkeySecretProvider: PubkeySecretProvider = () => null

export const configurePubkeySecretProvider = (
  provider: PubkeySecretProvider
): void => {
  pubkeySecretProvider = provider
}

export const generatePubkeySecret = (domain: string): string | null =>
  pubkeySecretProvider(domain)
