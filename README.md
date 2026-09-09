# LNURLwallet

A wallet for **LNURLcash** bearer notes
([LUD-25 draft](https://github.com/lnurl/luds/blob/lnurlcash/25.md)). It is a
single static page - no backend, no database, no accounts - deployed
straight to GitHub Pages. Everything it holds lives **encrypted** in your
browser's local storage, and every network request goes directly from your
browser to the LNURLcash service that issued a note.

Built with the same stack as
[lnurl_server](https://github.com/lnurlcash/lnurl_server)'s frontend: Vite,
SolidJS, TypeScript, sass, `@scure`/`@noble` crypto, `solid-qr-code`,
`solid-toast`, `solid-icons`. Works against any spec-compliant service,
e.g. [lnurl-mint](https://github.com/lnurlcash/lnurl-mint).

## LNURLcash (LUD-25)

A bearer note is an ordinary LUD-03 withdrawRequest link whose `k1` **is**
the asset - whoever knows it controls the sats behind it, like a banknote.
See the [LUD-25 draft](https://github.com/lnurl/luds/blob/lnurlcash/25.md)
for the full protocol: melt/rotate/split/merge, minting, offline
verification signatures.

What this wallet does beyond what the spec mandates:

- **Generates every rotate/split/merge secret itself**, never the service -
  disclosed to the service only as its hash, so the service is never a
  prior holder of a note it registers this way.
- **Rotates a received (scanned/pasted) note immediately** after the
  informational GET that verifies it - the previous holder already knows
  the old secret.
- **Pins each service's offline-verification key to its full origin**
  (scheme + port) on the Trusted mints page, stages any key change for
  manual review instead of trusting it silently, and tries both the spec's
  signature byte order and the recovery-id-leading order at least one real
  implementation has sent.
- With a connected **LNURLvault**, mints through a receipt extension where
  the vault generates and holds the secret before the invoice exists; this
  wallet only confirms the note once the settled receipt's signature
  checks out against the pinned mint key. Without a receipt-capable mint,
  it falls back to a secret from its own seed-derived cash ladder instead.
- Requires `commentAllowed: 64` on new mints and commits the note's hash as
  the callback `comment`, refusing mints that don't support it.

## Security model: encrypted with a key derived from your seed, in your local storage

- At setup a 12-word BIP39 **seed phrase** is generated in your browser. It
  is **never stored** - write it down; it is the only way to recover the
  wallet on another device.
- Every **bearer note is AES-256-GCM encrypted** with a key derived
  directly from the seed (sha256 over the BIP39 seed bytes plus a fixed
  context string) before it is written to local storage. Plaintext secrets
  never touch disk.
- That **derived encryption key is itself stored encrypted as well**
  (there is no separate identity keypair in between): during setup you are
  asked for a password (8 characters minimum) and the key is saved as
  AES-GCM ciphertext under a PBKDF2 (210k iterations, SHA-256) stretch of
  that password. Unlocking decrypts it into memory only. Opting out is
  possible but leaves the key readable to anyone using the browser profile.
- The wallet sends nothing anywhere except the note operations you
  trigger, straight to the issuing service.

A wallet created before this scheme shipped instead derives its encryption
key through a LUD-05 linking keypair. Those wallets keep working exactly as
before, and the Settings page offers a one-time **"Upgrade encryption"**
action: re-enter your seed phrase, and it re-encrypts every stored note and
activity entry under the simpler seed-direct key.

## Backup & restore

**Backup** downloads a single JSON file with all your bearer notes exactly
as stored - **still encrypted**. If your encryption key is password-
encrypted, its ciphertext is included too (backup + password restores
everything on a new device); a plaintext-stored key is never exported, the
seed phrase is its recovery path.

**Restore** merges a backup file's notes into local storage, skipping ones
already present. Ciphertexts become readable once the same seed (hence the
same derived key) is active - restore the seed first or the file first,
either order works. A restored key is never activated automatically (an
explicit source-trust warning gates that first), and trusted mints from a
file arrive unconfirmed until a live response corroborates the pin.

A backup protects against a lost device, not against theft of the note
itself: the service settles for whoever presents a `k1` first. Rotation is
the tool against stale copies - after restoring an old backup, refresh what
you hold.

## Development

```sh
npm install
npm run dev     # dev server on :3000
npm test        # vitest (codec + crypto round-trips)
npm run tsc     # typecheck
npm run build   # static build in dist/
```

For an end-to-end local loop, run [lnurl-mint](https://github.com/lnurlcash/lnurl-mint)
(`uv run fastapi dev lnurl_mint/server.py`) and point the Mint page at
`localhost:8000` - insecure hosts (localhost, 127.0.0.1, .onion) are
resolved as http automatically.

## Deployment

Pushing a version tag (e.g. `git tag v0.1.0 && git push origin v0.1.0`) runs
tests and deploys `dist/` to **GitHub Pages** via
`.github/workflows/deploy.yml` (enable Pages -> "GitHub Actions" as the
source in the repo settings). A plain push to `main` no longer deploys -
`ci.yml` still runs tests/build on every push and PR, it just doesn't
publish. The build uses relative asset paths and a hash router, so it works
from any subpath - no server configuration needed. The displayed version
(footer) is read straight from the nearest git tag at build time (see
`scripts/git-version.mjs`), not a hand-bumped `package.json` field.

Once that deploy succeeds, the same workflow's `release` job creates a
**GitHub Release** for the tag (`gh release create --generate-notes`), with
its changelog auto-generated from the commits/PRs merged since the previous
tag - nothing to write by hand. The release also carries the exact `dist/`
that got published, packaged as `lnurl-wallet-vX.Y.Z.tar.gz`, alongside a
`.sha256` file for verifying it - a static-hosting-independent way to fetch
and confirm a given version's build artifact.

## License

MIT
