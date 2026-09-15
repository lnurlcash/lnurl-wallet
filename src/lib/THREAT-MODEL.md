# Threat model

`@lnurlcash/kit` handles LNURLcash protocol data. It does not provide custody,
secret storage, routing, channel management or a guarantee that a mint will
honour its liabilities.

## Assets and trust boundaries

- A note secret is a bearer instrument. Anyone who obtains it can spend it.
- A replacement secret may be the only authority over an output after an
  ambiguous mutation. Callers must persist it before treating a request as
  safely retryable.
- A mint public key is not secret, but accepting the wrong key defeats offline
  verification. Applications must pin and review service identity changes.
- The mint is trusted with custody. Its signed statements prove what it said;
  they do not prove reserves, settlement or future redemption.

## Defences in this package

- Mutations name replacement outputs by hash or derived public key rather than
  disclosing the replacement secret.
- Network admission rejects unsafe service URLs and applies the configured
  guard before requests are made.
- Informational responses are checked against the requested note identity.
- Mint signatures bind note identity and value for offline verification.
- Amounts, invoices, preimages, fees and bound-mint receipts are validated
  before their results are accepted.
- Ambiguous request outcomes remain distinct from requests known not to have
  left the process.

## Caller responsibilities

- Encrypt note secrets and backups at rest, exclude them from logs, analytics
  and crash reports, and use a cryptographically secure secret provider.
- Treat callback requests as mutations. Do not retry after a timeout or an
  unreadable response until the newly named outputs have been reconciled.
- Pin trusted service origins and signing keys outside this stateless package.
- Route traffic appropriately if service-side timing and address correlation
  are a concern.
- Rotate newly minted bearer notes promptly: invoice preimages may have been
  visible to the service or to anyone able to observe invoice verification.

The complete wallet adds storage, recovery and user-confirmation policy around
these primitives. Those controls are not part of the npm package.
