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
platform `fetch`, admit requests, generate legacy outputs using Web Crypto and
do not generate Part 2 public-key outputs.

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

Version 0.14 adds the wallet's current Part 2 and LN address work, including
`fetchNoteInfoByPubkey`, cp1/ck1/cs1/cx1 codecs and derivation,
`registerUsername`, `scanForAddressNotes`, `configureTransport` and
bound-mint receipt validation.
