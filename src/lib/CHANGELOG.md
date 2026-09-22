# Changelog

## 0.14.0 - unreleased

- Add `resolveScanStartIndex` to `addresses.ts`: the LUD-25 Part 2 rule for
  combining a caller's own already-confirmed scan floor with a
  SERVICE-advertised `text/xpub` index hint, factored out of
  `lnurl-wallet`'s own `addressRecovery.ts` after a real bug there let the
  hint skip a fresh scan (and an explicit full rescan) straight past a
  genuinely unrecovered note - `next_index` advances the moment SERVICE
  hands out an invoice, not once it settles, so it is never safe to trust
  as "already recovered" ground below any floor a caller hasn't confirmed
  itself. See the function's own doc comment.
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
- **Breaking:** `signNoteOwnership` (`ck1`) and `signAddressProof`
  (register/unregister) now sign `sha256(message)` - a 32-byte digest -
  instead of the raw, variable-length message bytes. Most conforming
  Schnorr signers (`libsecp256k1`'s `schnorrsig` module included) only
  accept a 32-byte message; signing the raw string only ever worked here
  because `@noble/curves`' own `schnorr.sign` is more permissive than that,
  and would not have interoperated with an off-the-shelf signer. Neither
  function ever produces a signature under the old raw-message scheme
  anymore. `recoverNoteOwnershipPubkey` (`ck1` only, reading an
  already-minted note back) TODO(deprecated) still falls back to verifying
  against the old raw message when the current digest doesn't match, so a
  note minted before this change stays readable/redeemable until it's
  rotated - remove that fallback once no such notes are expected to remain
  in the wild. `signAddressProof`'s registration proof has no equivalent
  fallback: registering/unregistering is a fresh action a `WALLET`
  initiates itself, never a stored bearer secret read back later, so there
  is no old value that would ever need re-verifying.
- **Breaking:** `signAddressProof` now takes a `domain` argument
  (`signAddressProof(secretKey, action, domain, username)`) and folds it
  into the signed digest. A bare `cx1` (branch pubkey + chain code) carries
  no proof of which domain's hash a `WALLET` derived it under - that
  derivation is entirely `WALLET`-side and invisible to a verifying
  `SERVICE` - so without `domain` bound into the message, a register/
  unregister proof captured by one `SERVICE` could be replayed by it
  verbatim against any other `SERVICE`'s own `/p/{username}`, claiming or
  freeing the same username there under the same branch without the
  `WALLET`'s consent. `addresses.ts`'s `registerUsername`/
  `unregisterUsername` are unaffected (still just `server`) - they derive
  `domain` internally as `server`'s bare, lowercase hostname (no scheme,
  no port), matching exactly what `lnurl-mint`'s `router.py` resolves
  server-side from its own configured `base_url`/`onion_url`.

Existing `lnurlcash-kit` installations are unaffected and do not select the
new scoped package.
