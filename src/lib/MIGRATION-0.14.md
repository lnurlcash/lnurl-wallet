# Migrating from 0.13

Version 0.14 makes the protocol layer maintained by `lnurl-wallet` the npm
package implementation. It is published as `@lnurlcash/kit`; npm treats that
as a different package from `lnurlcash-kit`. Upgrade only after changing the
dependency and imports, adapting the API and testing the caller.

```sh
npm uninstall lnurlcash-kit
npm install --save-exact @lnurlcash/kit@0.14.0
```

## Configuration

The old package accepted `LnurlcashOptions` on each request and offered
`createClient(options)`. Version 0.14 configures its process-wide hooks once:

```ts
import {
  configureNetworkGuard,
  configureTransport,
  configureSecretProvider,
  configurePubkeySecretProvider
} from '@lnurlcash/kit'
```

Do this during application startup, before any request. The defaults use
platform `fetch`, admit requests, generate bearer outputs using Web Crypto and
do not generate key-path outputs.

## Removed high-level helpers

The following 0.13 APIs are not part of the wallet protocol layer and are not
exported by 0.14:

- `createClient` and `LnurlcashOptions`
- `settleNoteForValue`
- `restoreNotes` and `restoreFromSeed`
- seed/root derivation helpers from `cash.ts`
- payment-request encoding and decoding from the old `request.ts`
- UI fee strings `formatFeePercent` and `describeMintFee`

Keep `lnurlcash-kit@0.13.x` pinned if a caller still depends on them. Seed
persistence, restoration and UI wording remain wallet policy rather than
protocol-package policy.

## Errors and mutations

The wallet implementation exports `ServiceError`, `AmbiguousMintError` and
`AmbiguousMutationError` alongside typed spent, unknown and pending errors.
Review existing error handling instead of matching messages or assuming the
old class hierarchy.

Mutation functions use the configured secret providers and return the wallet's
current result shapes. Re-test every path that persists replacement outputs,
especially ambiguous results, before moving value with 0.14.

## New surface

Version 0.14 adds the wallet's current key-path note and LN address work, including
`fetchNoteInfoByPubkey`, cp1/ck1/cs1/cx1 codecs and derivation,
`registerUsername`, `scanForAddressNotes`, `configureTransport` and
bound-mint receipt validation.

## LUD-26 derivation: what breaks for people's wallets

LUD-26 replaced how seed-derived notes, Lightning Address shares and mint
certificates are made. Nothing a user holds is lost, but none of it is found
the new way, so a wallet built on 0.14 has to carry its users across:

- **Seed-derived notes.** Notes made with the old tweak
  (`LNURLcash/derive`) are not at the new BIP-32 paths, so a recovery that
  only walks `S/a'/0/i` and `S/a'/1/i` misses them. Sweep them once: derive
  the old branch node (`deriveDomainBranchNode` over the host as stored,
  port included), walk `legacyDeriveNotePubkey` for purposes 0, 1 and 2 and
  the pre-purpose variant (`null`), and rotate what is found into a new
  note. `legacyDeriveNoteSecretKey` signs the spends.
- **Mints on a non-default port.** `S` now hashes the domain without its
  port, so the old branch node differs from `S` there; for any other mint
  the two are the same node, only the paths below differ.
- **Registered Lightning Addresses.** A registration made before LUD-26
  holds a 64-byte `cx1`. Mints keep paying it out the old way until it is
  moved: `updateUsername` with the old branch key as `currentKey` and a
  fresh share as the new one. Notes already paid to the old registration
  are swept like any other legacy note (purpose 2).
- **Stored certificates.** A `cs1` signed before LUD-26 does not bind the
  domain. It still verifies (`noteCertificateKind` gives `'legacy'`); a
  rotate gets a current one.
- **Exported `cx1`s.** A 64-byte `cx1` handed out earlier no longer decodes
  with `decodeCx1` (`decodeLegacyCx1` reads it). Hand out a share's new
  `cx1` instead.
- **Internal transfer.** Wallets that paid a Lightning Address through its
  `text/cpub` entry must send the note to the callback instead; no SERVICE
  advertises `text/cpub` any more.
