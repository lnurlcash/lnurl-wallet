// Public surface of this kit - LNURLcash (LUD-25) bearer-note protocol
// logic, extracted out of the lnurl-wallet app so it can eventually stand
// on its own (see src/lib/README.md). Everything a host app needs to touch
// notes/services is re-exported from here; nothing wallet-specific (bearer-
// secret storage/recovery, an "offline mode" toggle, display-string
// formatting) lives in this directory - see src/lnurlcash.ts for that layer
// in this repo. branchDerivation.ts is the one exception to "no BIP32
// here": turning a mnemonic into an `m/139'` root stays wallet policy
// (keys.ts), but the deterministic walk from that root down to a domain's
// watch-only branch is spec-defined and must match byte-for-byte across
// implementations, so it's exported protocol code like everything else
// here - see that file's own header comment.
export * from './errors'
export * from './urls'
export * from './bolt11'
export * from './signature'
export * from './fees'
export * from './net'
export * from './request'
export * from './mintRequest'
export * from './addresses'
export * from './internalTransfer'
export * from './recoverableNotes'
export * from './spend'
export * from './branchDerivation'
export {
  configureSecretProvider,
  type SecretProvider,
  configurePubkeySecretProvider,
  type PubkeySecretProvider
} from './secrets'
