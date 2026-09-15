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

Existing `lnurlcash-kit` installations are unaffected and do not select the
new scoped package.
