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
