import {bytesToHex} from '@noble/hashes/utils.js'
import {offlineMode} from './offlineMode'
import {
  recordPendingMintSecret,
  requireRecoverableCashAddressSecret,
  nextChangeSecret
} from './cashSecrets'
import {msatToSats} from './helpers'
import {configureNetworkGuard} from './lib/net'
import {configureSecretProvider} from './lib/secrets'
import {
  requestInvoice,
  hashK1,
  cp1FromCk1,
  configurePubkeySecretProvider,
  configureChangePubkeySecretProvider
} from './lib/index'
import type {MintFee, InvoiceResult} from './lib/index'

// LUD-25 LNURLcash - bearer assets. Draft spec:
// https://github.com/lnurl/luds/blob/lnurlcash/25.md
//
// A note is an ordinary LUD-03 withdrawRequest link whose k1 *is* the
// asset: a spend of the note's taproot output key Q (a ck1, a cw1, or a
// bearer note's hex preimage, the k1 short form). No new endpoint. A GET on
// the note's LNURL is purely informational (the authoritative value is
// always maxWithdrawable, never the URL's own `amount`); every mutating op
// goes to the `callback` from that response:
//
//   callback?k1=X&pr=<bolt11>                   melt: X burned, pr (of exactly its value) paid
//   callback?k1=X&p1=<cp1>                      rotate: X burned, a note of the same value minted at p1
//   callback?k1=X..&amount=<msat>&p1=<cp1>&p2=<cp1>
//                                               split: one or many k1s burned, p1 (amount) + p2 (change) minted
//   callback?k1=X&k1=Y..&p1=<cp1>               merge: all burned, one note worth their sum minted at p1
//
// `p1`/`p2` are the cp1<Q> of outputs this wallet generates itself, never
// SERVICE (see generateNoteSecret) - the response carries no new k1, just
// {"status":"OK"} (plus sig/sig2, see Offline verification below). For a
// bearer output the lib builds that cp1 from the hashlock note (see
// noteRef); LUD-25's hex short form, which lets SERVICE build it instead,
// is only sent through the explicit `…Short` functions.
//
// Minting: a LUD-06 payRequest may advertise `withdrawLink` (raw LUD-17 URL
// of the withdraw endpoint) and must advertise `commentAllowed >= 64`;
// WALLET generates the note itself and sends only its `comment=cp1<Q>` on
// the invoice request (requestInvoice), and SERVICE credits Q once paid.
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
export * from './lib/index'

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
// to use. LUD-25 defines no derivation for bearer notes (unlike key-path
// notes' cx1 branch below): plain randomness is fully spec-compliant. Wired into
// src/lib's rotateNote/splitNote/mergeNotes via configureSecretProvider, so
// this is the ONLY place in the app that needs to know about cashSecrets.ts.
export const generateNoteSecret = (domain: string): string =>
  bytesToHex(crypto.getRandomValues(new Uint8Array(32)))

configureSecretProvider(generateNoteSecret)

// New mint invoices and cross-mint transfers must survive a reload after
// payment. Unlike an ordinary mutation output, they cannot safely use
// generateNoteSecret's bare in-memory randomness with nothing recorded: the
// bearer note SERVICE will credit would become permanently unclaimable if a
// reload wipes this page's component state first. A bearer note has no
// seed-derivation to fall back on (see generateNoteSecret above), so
// this persists the plain random secret directly instead - a same-device,
// same-localStorage guarantee, not a from-seed one (see
// cashSecrets.ts's recordPendingMintSecret for what that trade buys back).
export const generateMintSecret = (domain: string): string => {
  const secret = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
  recordPendingMintSecret(domain, secret)
  return secret
}

// Key-path counterpart to generateMintSecret above - a wallet-
// initiated mint/transfer's own pubkey-bound secret (a ck1 ownership
// signature, not a preimage), seed-recoverable the same way and for the
// same reload-survival reason (see requireRecoverableCashAddressSecret).
export const generateMintPubkeySecret = (domain: string): string =>
  requireRecoverableCashAddressSecret(domain)

// Wires generateMintPubkeySecret into src/lib's rotateNote/splitNote/
// mergeNotes (see configurePubkeySecretProvider) so a note that already
// is pub/sig-bound stays that way across a rotate/refresh/split/merge,
// instead of always coming back as a fresh bearer preimage - never throws
// (the seed-derived key can be unavailable, same as generateNoteSecret's
// own fallback story), which is exactly what tells src/lib to fall back to
// its ordinary legacy provider instead.
configurePubkeySecretProvider(domain => {
  try {
    return generateMintPubkeySecret(domain)
  } catch {
    return null
  }
})

// NOTE_PURPOSE_CHANGE counterpart to the wiring above - a split's own
// change note, drawn from its own independent counter (cashSecrets.ts's
// nextChangeSecret) so it never shares an index with an ordinary
// mint/rotate/merge output. Already `(domain) => string | null`, so it
// wires straight into configureChangePubkeySecretProvider with no wrapper.
configureChangePubkeySecretProvider(nextChangeSecret)

// Requests a mint invoice, preferring a seed-recoverable key-path note
// (comment=cp1<pk>) over a random bearer note (comment=cp1 of its hashlock
// note, see requestInvoice) whenever the mint accepts it - there is no capability flag to check
// first (this protocol dispatches by value shape, never version
// negotiation - see requestInvoice itself), so this just tries. Requesting
// an invoice has no burn side effect either way: if the mint doesn't
// accept the output, no invoice is issued and nothing was paid, so
// falling back to a bearer note is always safe - at most this wastes
// one already-persisted address-branch index (harmless, see
// nextCashAddressSecret's own comment). Every existing call site
// (Mint.tsx, TransferDialog.tsx) already required commentAllowed >= 64
// (requireMintComment) before reaching this point, and a cp1 value is
// only 61 characters, so it always fits.
export const requestMintInvoice = async (
  callback: string,
  amountMsat: number,
  domain: string
): Promise<{result: InvoiceResult; secret: string}> => {
  try {
    const secret = generateMintPubkeySecret(domain)
    const cp1 = cp1FromCk1(secret)
    if (cp1) {
      const result = await requestInvoice(callback, amountMsat, cp1)
      return {result, secret}
    }
  } catch {
    // no cash root loaded, or the mint didn't accept this output - either
    // way, no invoice was issued and nothing was paid, so falling back to a
    // bearer note below is always safe
  }
  const secret = generateMintSecret(domain)
  const result = await requestInvoice(callback, amountMsat, hashK1(secret))
  return {result, secret}
}

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
