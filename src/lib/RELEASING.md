# Releasing lnurlcash-kit

The package is published from `lnurlcash/lnurl-wallet`, not from a workstation
and not from the old standalone kit repository.

## One-time owner setup

An npm package owner must change the trusted publisher for `lnurlcash-kit` to:

- provider: GitHub Actions
- organisation or user: `lnurlcash`
- repository: `lnurl-wallet`
- workflow: `release-kit.yml`
- environment: `npm-publish`

A GitHub repository or organisation administrator should create the
`npm-publish` environment, restrict it to `lnurlcash-kit-v*` tags and require a
maintainer review. No npm token or GPG key belongs in GitHub secrets; npm uses
the workflow's short-lived OIDC identity and records provenance.

Do not create a release until both sides are configured. A missing or mismatched
trusted publisher should fail closed, but it is not a useful release rehearsal.

## Each release

1. Update `package.json` and `CHANGELOG.md` in a reviewed pull request.
2. Require the wallet CI and the independent `src/lib` package gate to pass.
3. Merge, then create `lnurlcash-kit-vX.Y.Z` at that exact merge commit.
4. Publish a GitHub Release for the tag. The `release: published` event runs
   `release-kit.yml`, rebuilds and tests the package, packs one tarball, performs
   a dry-run publish and uploads that same tarball through npm OIDC.
5. Verify the workflow, npm version, repository metadata and provenance before
   announcing the release.

Ordinary `vX.Y.Z` tags belong to the wallet application and are ignored by the
package workflow. A manual workflow dispatch validates only by default; its
separate `publish` input must be deliberately enabled to reach npm.

Version 0.14 is an API boundary from the old standalone implementation. Check
`MIGRATION-0.14.md` and test each consumer before changing its pinned range.
