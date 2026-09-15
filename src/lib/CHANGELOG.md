# Changelog

## 0.14.0 - unreleased

- Publish the protocol library maintained and exercised by `lnurl-wallet`
  directly from the wallet repository.
- Include LN address registration and recovery scanning, Part 2 public-key
  notes, configurable transports, offline note verification, fee handling,
  and bound mint receipts.
- Replace the separate pre-0.14 package implementation. This is an intentional
  API boundary: callers must review the exported surface before upgrading from
  `0.13.x`.

Existing `^0.13.0` installations do not select `0.14.0` under npm's semver
rules.
