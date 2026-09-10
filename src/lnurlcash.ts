import {bytesToHex} from '@noble/hashes/utils.js'
import {offlineMode} from './offlineMode'
import {nextCashSecret, requireRecoverableCashSecret} from './cashSecrets'
import {msatToSats} from './helpers'
import {configureNetworkGuard} from './lib/net'
import {configureSecretProvider} from './lib/secrets'
import type {MintFee} from './lib'

// LUD-25 LNURLcash - bearer assets. Draft spec:
// https://github.com/lnurl/luds/blob/lnurlcash/25.md
//
// A bearer note is an ordinary LUD-03 withdrawRequest link whose k1 *is*
// the asset. No new endpoint, no new encoding. A GET on the note's LNURL
// is purely informational (the authoritative value is always
// maxWithdrawable, never the URL's own `amount`); every mutating op goes
// to the `callback` from that response:
//
//   callback?k1=X&pr=<bolt11>              melt: X burned, pr (of exactly its value) paid
//   callback?k1=X&h=<sha256(X')>           rotate: X burned, a note keyed by h minted, same value
//   callback?k1=X..&amount=<msat>&h&h2     split: one or many k1s burned, notes keyed by h (amount) + h2 (change) minted
//   callback?k1=X&k1=Y..&h=<sha256(Z)>     merge: all burned, one note keyed by h minted, worth their sum
//
// `h`/`h2` are hashes of secrets this wallet generates itself, never
// SERVICE (see generateNoteSecret) - the response carries no new k1, just
// {"status":"OK"} (plus sig/sig2, see Offline verification below).
//
// Minting: a LUD-06 payRequest may advertise `withdrawLink` (raw LUD-17 URL
// of the withdraw endpoint). The current LUD-25 draft profile requires the
// payRequest to advertise `commentAllowed >= 64`; WALLET generates its own
// `secret`, sends only `comment=hashK1(secret)` on the invoice request
// (requestInvoice), and SERVICE credits the note as k1=secret once paid.
// The Lightning payment preimage is settlement proof, never the new note.
//
// A melt's {"status":"OK"} only means the payment is now in flight - the
// note isn't confirmed spent until it settles, and is restored to
// outstanding if it fails (see meltNote). Any other callback naming a k1
// that's mid-melt is rejected with {"status":"ERROR","reason":"pending"}
// until it resolves one way or the other. SERVICE MAY additionally prove a
// melt happened via a `pr`/`verify` melt proof (LUD-21-style), so its fate
// can be confirmed without re-probing the note with a rotate.
//
// The actual protocol implementation lives in src/lib/ (see its own
// README) - this file re-exports all of it unchanged, plus the pieces
// below that are this wallet's own policy rather than general LUD-25
// protocol: seed-derived recoverable secrets, an "offline mode" toggle,
// and display-string formatting for mint fees. Every existing import of
// this module keeps working exactly as before.
export * from './lib'

// wires this wallet's "offline mode" toggle into every network call
// src/lib's functions make - see offlineMode.ts's own comment on why this
// needs to be the one choke point every request goes through
configureNetworkGuard(() => {
  if (offlineMode()) {
    throw new Error(
      'Offline mode is on - turn it off in the nav to reach a service.'
    )
  }
})

// LUD-25: for a rotate/split/merge, WALLET - not SERVICE - generates the
// replacement note's secret and discloses only its hash (h/h2 on the
// callback) - a fresh 32-byte value, the same size an actual Lightning
// payment preimage already is, though nothing is ever paid for it. The
// same function also produces the `secret` behind a comment-protected mint
// (see MIN_COMMENT_LENGTH_FOR_SECRET) - both are the same kind of thing, an
// opaque 32-byte value only WALLET ever needs to produce.
//
// `domain` is the issuing SERVICE's own host (see serverOf) - every call
// site already has it in scope from the callback/payRequest URL it's about
// to use. Seed-recoverable note secrets (LUD-25): prefers a deterministic
// secret derived from this wallet's seed (see cashSecrets.ts) so a
// lost/reinstalled wallet can reconstruct it from nothing but the seed
// phrase plus a small per-domain index, falling back to plain randomness
// only when no seed-derived root is loaded (locked, or a wallet that
// hasn't re-entered its seed since this feature shipped). Wired into
// src/lib's rotateNote/splitNote/mergeNotes via configureSecretProvider,
// so this is the ONLY place in the app that needs to know about
// cashSecrets.ts's existence for that purpose.
export const generateNoteSecret = (domain: string): string =>
  nextCashSecret(domain) ??
  bytesToHex(crypto.getRandomValues(new Uint8Array(32)))

configureSecretProvider(generateNoteSecret)

// New mint invoices and cross-mint transfers must survive a reload after
// payment. Unlike an ordinary mutation output, they cannot safely use the
// in-memory random fallback: require a seed-derived secret whose counter was
// persisted before the quote leaves this wallet.
export const generateMintSecret = (domain: string): string =>
  requireRecoverableCashSecret(domain)

// fee_percent_ppm is parts-per-million - /10_000 for a percent, then trim
// the trailing zeros toFixed leaves behind (2000 ppm -> "0.2000" -> "0.2")
export const formatFeePercent = (ppm: number): string =>
  (ppm / 10_000).toFixed(4).replace(/\.?0+$/, '')

// parseMintFee (src/lib/fees.ts) already collapses a fully-zero fee down to
// null, so by the time one reaches here at least one of the two components
// is set - only mention the one(s) that actually are
export const describeMintFee = (fee: MintFee): string =>
  [
    fee.baseFeeMsat > 0 ? `${msatToSats(fee.baseFeeMsat)} sat flat` : null,
    fee.feePpm > 0
      ? `${formatFeePercent(fee.feePpm)}% of the amount paid`
      : null
  ]
    .filter(Boolean)
    .join(' + ')
