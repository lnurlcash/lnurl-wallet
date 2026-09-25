# Changelog

## 0.14.0 - unreleased

- **Breaking:** the old `h`/`h2` field names are gone, and a bearer note's
  hex `h` goes on the wire as its hashlock note's `cp1<Q>` by default - as
  `comment` (`requestInvoice`), `p` (`fetchNoteInfoByHash`) and `p1`/`p2`
  (`rotateNoteWithHash`/`splitNoteWithHash`/`mergeNotesWithHash`). Each has a
  `…Short` variant sending LUD-25's 64-hex short form instead
  (`requestInvoiceShort`, `fetchNoteInfoByHashShort`,
  `rotateNoteWithHashShort`, `splitNoteWithHashShort`,
  `mergeNotesWithHashShort`). New `noteRef`/`shortNoteRef` convert a
  reference to either form.
- **Breaking:** LUD-25's unified note model - every note is a taproot
  output key `Q` (`cp1`), spent by a `ck1` (key path) or a `cw1` (script
  path), each checked as input 0 of the canonical spend transaction (see
  25.md). New `spend.ts`: `keyPathSighash`, `scriptPathSighash`,
  `spendSigMsg`, `spendPrevout`, `spendDomainOf`/`noteMintOf`, and the plain
  bearer note (`bearerNote`, `bearerNoteIdOfHash`,
  `bearerNoteIdOfPreimage` - NUMS internal key, one `OP_SHA256 <h>
OP_EQUAL` leaf, whose 64-hex short forms are the preimage as `k1` and `h`
  wherever a `cp1` goes).
- **Breaking:** `signNoteOwnership(secretKey, domain)` now signs the
  key-path sighash for the note's mint (its URL or host) instead of
  `sha256("LNURLcash")`, so a `ck1` is bound to one mint.
  `recoverNoteOwnershipPubkey(ck1, domain)` verifies against that sighash.
  New `ck1Pubkey(ck1)` decodes a `ck1`'s `Q` without verifying, for lookups
  and output disclosure (`cp1FromCk1` uses it).
- **Breaking:** removed `encodeCt1`/`decodeCt1`/`isCt1` - a note committing
  to script leaves is an ordinary `cp1`; `isPubkeyCommitment` is `isCp1`.
- `verifyNoteSignature`/`verifyNoteSignatureHash` check a bearer note's
  `cs1` against its `Q`. New `verifyNoteSignatureForKey` for a note known by
  its `Q`.
- **Breaking:** removed every deprecated compatibility path:
  - the pre-schnorr 65-byte `ck1` and a `ck1` signed over the old fixed
    `"LNURLcash"` message - `isLegacyCk1`, `CK1_LEGACY_LENGTH` and
    `NoteOwnershipPubkey.legacy` are gone; `decodeCk1` accepts 96 bytes only;
  - the fixed-HRP `cs1` without an amount (`encodeCs1`/`decodeCs1`/`isCs1`,
    `decodeAnyCs1`/`isAnyCs1`) and plain-hex signatures
    (`NOTE_SIGNATURE_PATTERN`) - a certificate is a `cs1<amount>` only, with
    its recovery id last;
  - certificates over a bearer note's `h` instead of its `Q`;
  - `fetchNoteInfo`'s retry with the raw `k1` for a mint that rejects `?p=`:
    every note is looked up by its `cp1<Q>`, derived from its spend.
  - The bound-mint receipt's `h` is normalized to the note's `Q` and its
    `sig` kept as a `cs1`.
- Add `minIndex` to `scanForAddressNotes`'s options: forces the forward
  walk to keep going through indices up to and including this one, even
  past what `gapLimit` consecutive unknowns would otherwise have stopped
  it at - the complementary guarantee to `checkBehind` at the other end.
  `lnurl-wallet`'s own `addressRecovery.ts` sets this to
  `serviceHint + gapLimit` on every scan, so a from-scratch walk is
  guaranteed to reach at least as far as SERVICE says it has handed out
  invoices, rather than stopping early on some unrelated dead stretch well
  short of it.
- Add `checkBehind` to `scanForAddressNotes`'s options: also re-checks up to
  `gapLimit` indices immediately below `startIndex` (down to 0) as a
  fixed-size safety net, before the ordinary forward walk - re-verifying
  the exact range `startIndex` claims is already covered, rather than only
  ever trusting it. Unlike the forward walk this never stops early on a
  run of unknowns (it's a bounded window, not an open-ended search).
  `lnurl-wallet`'s own `addressRecovery.ts`/`recovery.ts` now pass this on
  every scan.
- Add `resolveScanStartIndex` to `addresses.ts`: the LUD-25 rule for
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
- Include LN address registration and recovery scanning, key-path
  notes, configurable transports, offline note verification, fee handling,
  and bound mint receipts.
- Add `branchDerivation.ts`: the LUD-25 `m/139'`-rooted domain-branch walk
  (`deriveDomainBranchNode`, `CASH_ROOT_PURPOSE`, `lud05PathSuffix`),
  exported so another LUD-25 implementation can reproduce a wallet's
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
