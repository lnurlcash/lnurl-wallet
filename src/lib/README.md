# LNURLcash (LUD-25) protocol kit

Staged extraction of this wallet's own LNURLcash implementation out of the
monolithic `src/lnurlcash.ts` it used to live in, organized as a
publishable-on-its-own package. Every function here has been through this
repo's own independent security-review history (see the commit log for
"security review"/"harden" fixes) - it did not previously depend on the
already-published `lnurlcash-kit` package (a separate implementation, by a
different author, that the sibling `raffle` project uses instead).

**Intent**: this becomes (or replaces the content of) a real
`github.com/lnurlcash/lnurlcash-kit` package. Nothing here has been
published yet - see "Publishing" below for what's still needed.

## Why this is decoupled the way it is

This directory has **zero dependency on anything wallet-specific** -
no `localStorage`, no Solid, no import from anywhere outside `src/lib/`.
Two things the original monolith got from the wallet directly are now
injectable, configured once at startup by whatever host embeds this:

- **`net.ts`'s `configureNetworkGuard(guard)`** - called before every
  network request; throwing from `guard` refuses the request before it's
  attempted. The wallet uses this for its "offline mode" toggle
  (`offlineMode.ts`) - see `src/lnurlcash.ts`.
- **`secrets.ts`'s `configureSecretProvider(provider)`** - decides how
  `rotateNote`/`splitNote`/`mergeNotes` (`request.ts`) generate a fresh
  output secret. Defaults to plain `crypto.getRandomValues` randomness; the
  wallet configures it to prefer a seed-derived, recoverable secret instead
  (`cashSecrets.ts`) - see `src/lnurlcash.ts`.

Neither default requires any configuration to use correctly - a bare
`import` of this package with no setup behaves like a stateless, pure-random
LUD-25 client.

## What deliberately stayed out of this directory

`src/lnurlcash.ts` (one level up) is what actually gets imported everywhere
else in this app - it re-exports everything from here unchanged, plus:

- `generateNoteSecret`/`generateMintSecret` - the wallet's own
  `cashSecrets.ts`-backed implementations, wired in via
  `configureSecretProvider` above. A generic kit shouldn't assume a specific
  seed-derivation scheme.
- `formatFeePercent`/`describeMintFee` - English display strings ("2 sat
  flat", "0.5% of the amount paid"). A protocol kit shouldn't dictate UI
  copy or language; `fees.ts` here only has the pure numeric fee math
  (`parseMintFee`/`applyMintFee`/`withinMintFeeBand`/`grossUpForMintFee`).
- the `offlineMode()` check itself (a wallet-wide UI toggle, not a protocol
  concept) - wired in via `configureNetworkGuard` above.

If you're editing something in `src/lib/` and find yourself reaching for
`localStorage`, a Solid signal, or any other wallet module, that's a sign
the logic belongs in `src/lnurlcash.ts` instead, calling into an
injectable hook here if it needs one.

## File map

| File             | Contents                                                             |
| ---------------- | -------------------------------------------------------------------- |
| `errors.ts`      | The error taxonomy (`AmbiguousMutationError`, `NoteSpentError`, ...) |
| `urls.ts`        | LUD-01/16/17 encoding, note-URL construction/parsing, origin checks  |
| `bolt11.ts`      | BOLT-11 decode (amount, payment_hash), preimage/invoice shape checks |
| `signature.ts`   | LUD-13-style offline note-signature sign/verify, dual byte-order     |
| `fees.ts`        | LUD-25 mint fee math (parse/apply/band-check/gross-up)               |
| `secrets.ts`     | Injectable secret generation for rotate/split/merge                  |
| `net.ts`         | The one network choke point + injectable pre-flight guard            |
| `request.ts`     | fetchNoteInfo, probeBurnedNote, rotate/split/merge/melt, settleNote  |
| `mintRequest.ts` | LUD-06 payRequest, invoice request/verify, bound-mint-receipt        |
| `index.ts`       | Public barrel - `export *` from everything above                     |

## Testing

This directory has its own scoped test suite (`src/lib/*.test.ts` +
`src/lib/vitest.config.ts`), run independently of the wallet app's own tests
via `npm run test:lib` from the repo root (`npm test` runs the wallet suite
only - the two are mutually exclusive so nothing runs twice; `npm run
test:all` runs both). Every test file here imports only from its sibling
`.ts` module (never from `../lnurlcash`), so this suite alone proves the
kit's public surface works with zero wallet code loaded. The one exception is
`generateNoteSecret`, which is wallet-specific policy (see above) and stays
tested in `../lnurlcash.test.ts` instead.

## Publishing

Not done yet. Before this becomes a real npm release:

1. Decide the actual relationship to the existing `lnurlcash-kit` package
   (currently published by a different author/org) - replace it, fork it,
   or merge histories. Not a decision this directory makes on its own.
2. Give this its own `package.json`/build step (the existing
   `lnurlcash-kit` repo already has a working `tsup`/`vitest` setup worth
   copying rather than reinventing) - the scoped `vitest.config.ts` here can
   move over largely as-is.
3. Write this package's own README/SECURITY.md/THREAT-MODEL.md - the
   existing `lnurlcash-kit` repo's versions of these are a reasonable
   starting template for shape, even where the content differs.
