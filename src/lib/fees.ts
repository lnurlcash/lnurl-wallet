// ---- LUD-25 mint fees ----

export type MintFee = {
  baseFeeMsat: number
  feePpm: number
}

// The current LUD-25 draft profile requires enough room for exactly what
// a wallet-generated secret + hashK1 produce: a hex-encoded 32-byte hash.
export const MIN_COMMENT_LENGTH_FOR_SECRET = 64

export type PayRequestCommentInfo = {commentAllowed?: number}

// true only if SERVICE's payRequest advertised enough `commentAllowed`
// (LUD-12) to carry a hex-encoded 32-byte hash. Generic callers can inspect
// this predicate; mint-creation paths must call requireMintComment below.
export const canUseMintComment = (info: PayRequestCommentInfo): boolean =>
  typeof info.commentAllowed === 'number' &&
  info.commentAllowed >= MIN_COMMENT_LENGTH_FOR_SECRET

// Refuse before requesting an invoice: paying an unnamed mint invoice can
// recreate the preimage-race design the current LUD-25 profile removes.
export const requireMintComment = (info: PayRequestCommentInfo): void => {
  if (!canUseMintComment(info)) {
    throw new Error(
      'This mint cannot create current LUD-25 notes because it does not advertise commentAllowed: 64.'
    )
  }
}

// LUD-25 mint fees (optional): SERVICE signals what it withholds on minting
// via an extra ["text/plain", "Mint fees: <base_fee_msat>,<fee_percent_ppm>"]
// entry in a payRequest's metadata array, so a client can warn the payer up
// front that the note it ends up holding may be worth less than the invoice
// it paid. A SERVICE that omits the entry is assumed fee-free.
export const parseMintFee = (metadata: string): MintFee | null => {
  let entries: unknown
  try {
    entries = JSON.parse(metadata)
  } catch {
    return null
  }
  if (!Array.isArray(entries)) return null
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry[0] !== 'text/plain') continue
    const match =
      typeof entry[1] === 'string' &&
      entry[1].match(/^Mint fees:\s*(\d+)\s*,\s*(\d+)\s*$/)
    if (!match) continue
    const baseFeeMsat = Number(match[1])
    const feePpm = Number(match[2])
    if (!Number.isFinite(baseFeeMsat) || !Number.isFinite(feePpm)) continue
    // a >= 100% fee can never net anything at all (applyMintFee floors at 0
    // while the target stays positive), so there is no gross-up to offer
    // and nothing a caller could do with one. Treat it as no valid fee
    // entry at all.
    if (feePpm >= 1_000_000) continue
    // an explicit "Mint fees: 0,0" has the exact same effect as omitting
    // the entry entirely - treat it identically, so callers don't need to
    // special-case a fee that's technically present but withholds nothing
    if (baseFeeMsat === 0 && feePpm === 0) return null
    return {baseFeeMsat, feePpm}
  }
  return null
}

// the note value SERVICE is expected to credit after withholding its
// advertised fee - per the spec text, "amount - base_fee_msat - amount *
// fee_percent_ppm / 1_000_000". Floored since msat is necessarily an
// integer and SERVICE presumably can't credit a fractional one; this is
// only ever an estimate to display before paying - the authoritative value
// is always whatever the informational GET reports after claiming
export const applyMintFee = (grossMsat: number, fee: MintFee): number => {
  // gross * ppm exceeds Number.MAX_SAFE_INTEGER around 100 BTC at a
  // realistic ppm, and a rounded product floors to the wrong msat - so the
  // multiply is split across the divide, keeping both halves exact at any
  // amount that fits in msat
  const whole = Math.floor(grossMsat / 1e6)
  const rest = grossMsat % 1e6
  const proportional =
    whole * fee.feePpm + Math.floor((rest * fee.feePpm) / 1e6)
  return Math.max(0, grossMsat - fee.baseFeeMsat - proportional)
}

// Live mints differ on whether the advertised fee is withheld exactly in
// msat or rounded up to a whole sat. A receipt amount inside this band is
// compatible with either reading; anything outside it contradicts the quote.
export const withinMintFeeBand = (
  grossMsat: number,
  netMsat: number,
  fee: MintFee
): boolean => {
  const exactNet = applyMintFee(grossMsat, fee)
  const exactFee = grossMsat - exactNet
  const roundedNet = Math.max(0, grossMsat - Math.ceil(exactFee / 1000) * 1000)
  return netMsat >= roundedNet && netMsat <= exactNet
}

// the inverse: the smallest invoice whose note still nets netMsat once
// SERVICE's fee comes out. It has to be the smallest - anything above it
// is the payer overpaying a fee for nothing - and flooring in applyMintFee
// puts it a little either side of the linear inverse, so it's searched for
// rather than computed (applyMintFee is non-decreasing in gross with
// per-msat steps of 0 or 1, so that gross always exists and is unique)
export const grossUpForMintFee = (netMsat: number, fee: MintFee): number => {
  if (netMsat <= 0) return 0
  // applyMintFee is non-decreasing in gross, so the answer is the leftmost
  // gross that clears netMsat and binary search finds it exactly. A walk
  // can't: near a 100% fee the distance from any linear estimate runs to
  // millions of msat, and a walk bounded by a guard stops wherever the
  // guard runs out and silently overpays the difference
  let lo = netMsat
  let hi = netMsat + fee.baseFeeMsat
  // doubled rather than derived from the linear inverse, which divides by
  // zero at a 100% fee. The bound only has to clear netMsat; the search
  // does the rest. Exhausting it means no gross ever nets netMsat (a >=
  // 100% fee, which parseMintFee already refuses to return)
  let guard = 0
  while (applyMintFee(hi, fee) < netMsat && guard++ < 64) hi *= 2
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (applyMintFee(mid, fee) < netMsat) lo = mid + 1
    else hi = mid
  }
  return lo
}
