# Releasing @lnurlcash/kit

The final package is published from `lnurlcash/lnurl-wallet`, not from a
workstation and not from the old standalone kit repository.

## One-time scoped-package bootstrap

npm cannot configure a trusted publisher until the package exists. After this
package source has been reviewed and merged, an `lnurlcash` npm organisation
owner must make the one exceptional manual publish:

1. Build, test and pack the merged source from a disposable clean checkout,
   changing only its package version to `0.14.0-rc.0`.
2. Publish that tarball as a public prerelease with
   `npm publish --access public --tag next <tarball>`.
3. Verify that npm shows `@lnurlcash/kit@0.14.0-rc.0` under the `next` tag and
   that no `latest` tag has been created.

Do not manually publish `0.14.0`: that version is reserved for the reviewed
OIDC release. The prerelease only creates the scoped package so its trusted
publisher can be configured; do not recommend it to production consumers.

## One-time trusted-publisher setup

An npm package owner must configure the trusted publisher for
`@lnurlcash/kit` as:

- provider: GitHub Actions
- organisation or user: `lnurlcash`
- repository: `lnurl-wallet`
- workflow: `release-kit.yml`
- environment: `npm-publish`
- allowed actions: enable direct `npm publish`

A GitHub repository or organisation administrator should create the
`npm-publish` environment, restrict it to `v*` tags and require a maintainer
review. No npm token or GPG key belongs in GitHub secrets; npm uses the
workflow's short-lived OIDC identity and records provenance.

Do not create a final release until both sides are configured. A missing or
mismatched trusted publisher should fail closed, but it is not a useful release
rehearsal.

## Each release

1. Choose the next version for both the wallet and kit, then update the kit's
   `package.json` and `CHANGELOG.md` in a reviewed pull request.
2. Require the wallet CI and the independent `src/lib` package gate to pass.
3. Merge, then create the shared `vX.Y.Z` tag at that exact merge commit. The
   tag must exactly equal `v` plus the version in `src/lib/package.json`.
4. Pushing the tag starts both release workflows. The wallet is tested and
   deployed at `X.Y.Z`; `release-kit.yml` independently rebuilds and tests the
   package, packs one tarball, performs a dry-run publish and uploads that same
   tarball through npm OIDC as `@lnurlcash/kit@X.Y.Z`.
5. Verify the workflow, npm version, repository metadata and provenance before
   announcing the release.

There is no separate package release train: the wallet tag is the compatibility
signal for both artefacts. A manual workflow dispatch validates only by default;
its separate `publish` input must be deliberately enabled to reach npm.

Version 0.14 is a package-name and API boundary from the old standalone
implementation. Check `MIGRATION-0.14.md` and test each consumer before
replacing its pinned dependency.
