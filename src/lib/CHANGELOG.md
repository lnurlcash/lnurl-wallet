# Changelog

## 0.14.0 - unreleased

- Publish the protocol library maintained and exercised by `lnurl-wallet`
  directly from the wallet repository.
- Include LN address registration and recovery scanning, Part 2 public-key
  notes, configurable transports, offline note verification, fee handling,
  and bound mint receipts.
- Replace the separate pre-0.14 `lnurlcash-kit` implementation with the scoped
  `@lnurlcash/kit` package. This is an intentional package-name and API
  boundary: callers must change their dependency and imports, then review the
  exported surface before upgrading from `lnurlcash-kit@0.13.x`.
- **Breaking:** `ck1` (a note's own wallet-side ownership signature) is now a
  32-byte BIP-340 x-only pubkey concatenated with a 64-byte Schnorr
  signature (`encodeCk1`/`signNoteOwnership` signatures changed accordingly;
  `recoverNoteOwnershipPubkey` now takes the `ck1` string directly and
  returns `{pubkeyXOnly, legacy}` rather than raw recovered bytes), replacing
  the previous 65-byte recoverable-ECDSA signature. `decodeCk1`/`isCk1` still
  read the OLD shape for interop with a note minted before this change - see
  `isLegacyCk1` - but this is TODO(deprecated) and will be removed once no
  such notes are expected to remain in the wild; callers should warn holders
  and prompt a rotate for any note where `isLegacyCk1` is true.
- **Breaking:** `signAddressProof` (LN address un-/registration) is now a
  plain 64-byte BIP-340 Schnorr signature instead of a 65-byte recoverable
  ECDSA one, matching the same scheme change.

Existing `lnurlcash-kit` installations are unaffected and do not select the
new scoped package.
