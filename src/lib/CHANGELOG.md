# Changelog

## 0.14.0 - unreleased

- Publish the protocol library maintained and exercised by `lnurl-wallet`
  directly from the wallet repository.
- Include LN address registration and recovery scanning, Part 2 public-key
  notes, configurable transports, offline note verification, fee handling,
  and bound mint receipts.
- Add `branchDerivation.ts`: the LUD-25 `m/139'`-rooted domain-branch walk
  (`deriveDomainBranchNode`, `CASH_ROOT_PURPOSE`, `lud05PathSuffix`),
  exported so another LUD-25 Part 2 implementation can reproduce a wallet's
  watch-only branch for a given seed and domain byte-for-byte rather than
  reverse-engineering it - see `branchDerivation.test.ts`'s vector, pinning
  the literal `25.md` "Seed & derivation" path (`m/139'/d1/d2/d3/d4`, no
  extra purpose hop). Adds `@scure/bip32` as a real dependency of this
  package (this is the one piece of the kit that touches BIP32 nodes -
  "seed phrase -> `m/139'` root" stays wallet policy, outside the kit).
- Add `onProgress` and `onSpent` to `scanForAddressNotes`'s options:
  `onProgress` fires before every index probed (hit or not), so a caller can
  show live scan progress without a custom gap-limit loop of its own;
  `onSpent` fires for an index confirmed used but already spent (distinct
  from `onFound`, which only ever fires for a still-live note), so a caller
  can track the true highest-used index for its own "next index"
  bookkeeping past one it can no longer recover.
- Replace the separate pre-0.14 `lnurlcash-kit` implementation with the scoped
  `@lnurlcash/kit` package. This is an intentional package-name and API
  boundary: callers must change their dependency and imports, then review the
  exported surface before upgrading from `lnurlcash-kit@0.13.x`.
- **Breaking:** `ck1` (a note's own wallet-side ownership signature) is a
  32-byte BIP-340 x-only pubkey concatenated with a 64-byte Schnorr
  signature over `sha256("LNURLcash")` (`encodeCk1`/`signNoteOwnership`
  signatures changed accordingly; `recoverNoteOwnershipPubkey` now takes the
  `ck1` string directly and returns `{pubkeyXOnly}` rather than raw recovered
  bytes). No other `ck1` shape is recognized - a note minted under any
  earlier scheme (a bare recoverable-ECDSA signature, or the current
  `pk||sig` shape signed over the raw un-hashed message) is not decodable or
  verifiable by this package; a `SERVICE`/mint MAY keep its own transitional
  fallback for redeeming such a note (never a `WALLET` concern - a `WALLET`
  only ever needs to recognize `ck1` values it itself produced), but this
  package deliberately does not.
- **Breaking:** `signAddressProof` (LN address un-/registration) is now a
  plain 64-byte BIP-340 Schnorr signature over `sha256(message)`, instead of
  a 65-byte recoverable ECDSA one over the raw message. Most conforming
  Schnorr signers (`libsecp256k1`'s `schnorrsig` module included) only
  accept a 32-byte message; signing the raw string only ever worked in this
  package because `@noble/curves`' own `schnorr.sign` is more permissive
  than that, and would not have interoperated with an off-the-shelf signer.

Existing `lnurlcash-kit` installations are unaffected and do not select the
new scoped package.
