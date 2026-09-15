# @lnurlcash/kit

The LNURLcash protocol client used by
[`lnurl-wallet`](https://github.com/lnurlcash/lnurl-wallet). It is published
from the wallet repository so the reference wallet and the npm package share
the same implementation and test suite.

LUD-25 is still a draft. Pin an exact version and review the changelog before
upgrading software that can spend bearer notes.

Version 0.14 replaces the separate `lnurlcash-kit` 0.13 implementation under a
new scoped package name. Existing consumers should read
[MIGRATION-0.14.md](./MIGRATION-0.14.md) before upgrading.

## Install

```sh
npm install --save-exact @lnurlcash/kit
```

Node 22 or newer is required. The package is ESM-only and also targets modern
browsers with Web Crypto and `AbortSignal.timeout`.

## Use

```ts
import {fetchNoteInfo, rotateNote} from '@lnurlcash/kit'

const info = await fetchNoteInfo(noteUrl)
const replacement = await rotateNote(info.callback, info.k1)
```

`fetchNoteInfo` first uses a secret-free hash or public-key lookup. It sends a
raw legacy `k1` only when an older service explicitly says that `k1` is
required. Mutations generate and name replacement outputs locally.

Configuration is process-wide. Call `configureNetworkGuard`,
`configureTransport`, `configureSecretProvider` and
`configurePubkeySecretProvider` once during application startup, before any
requests are made. The defaults use the platform `fetch` and secure random
bytes; the wallet overrides them for offline mode, recoverable outputs and
host-provided transports. A custom transport must return redirect responses
without following them so the kit can admit each destination before sending a
bearer secret.

## Public modules

The root export includes:

- LNURL and note parsing in `urls.ts`
- BOLT-11 amount, hash and preimage checks in `bolt11.ts`
- offline note signatures and Part 2 ownership proofs in `signature.ts`
- fee parsing and arithmetic in `fees.ts`
- guarded network access in `net.ts`
- note lookup, melt, rotate, split, merge and settlement in `request.ts`
- mint invoice and bound-receipt checks in `mintRequest.ts`
- LN address registration and gap-limit recovery scans in `addresses.ts`
- cp1, ck1, cs1 and cx1 codecs and derivation in `recoverableNotes.ts`
- injectable output-secret providers in `secrets.ts`

The implementation has no dependency on Solid, browser storage or any other
wallet module. Wallet policy stays in the parent `src/lnurlcash.ts` adapter.

## Errors and ambiguous mutations

LNURLcash mutations move bearer value. A timeout or unreadable response does
not prove that a callback failed. Preserve every replacement secret carried by
an `AmbiguousMutationError` and reconcile the input and outputs before retrying.
Do not turn transport uncertainty into an automatic retry.

See [THREAT-MODEL.md](./THREAT-MODEL.md) before integrating the package and
[SECURITY.md](./SECURITY.md) before reporting a vulnerability.

## Development

From `src/lib` in the wallet checkout:

```sh
npm ci
npm run check
npm pack --dry-run
```

The package and wallet share a version. A wallet tag named `vX.Y.Z` publishes
`@lnurlcash/kit@X.Y.Z` from the same commit through
`.github/workflows/release-kit.yml` and npm trusted publishing; releases must
not be published from a maintainer workstation. The release process and
trusted-publisher configuration are documented in
[RELEASING.md](./RELEASING.md).

## Licence

MIT
