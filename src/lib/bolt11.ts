import {bech32} from '@scure/base'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'

// bolt11 is bech32 - case-insensitive - so invoice equality is a
// normalized string compare. Used to bind a verify response (or a melt
// proof) to the exact invoice it claims to report on: a settled result for
// some OTHER invoice must never confirm a client's payment
export const sameInvoice = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase()

// a payment preimage (the future k1): 32 bytes hex
export const isPreimage = (value: string): boolean =>
  /^[0-9a-fA-F]{64}$/.test(value.trim())

// a raw BOLT-11 invoice - loose shape check only (one of the known network
// prefixes, an optional amount, then the bech32 separator), same
// non-exhaustive spirit as isValidNoteInput (urls.ts). Anchored to actual
// bolt11 prefixes (bc/tb/bcrt/...) rather than a bare "ln", which a bech32
// LNURL ("lnurl1...") would also match.
export const isBolt11Invoice = (value: string): boolean =>
  /^ln(bc|tb|bcrt|tbs|sb)[0-9]*[munp]?1[a-z0-9]+$/.test(
    value.trim().toLowerCase()
  )

// per unit of the invoice's amount digits, relative to whole BTC (10^-3,
// 10^-6, 10^-9, 10^-12), converted straight to msat (1 BTC = 10^11 msat)
const BOLT11_AMOUNT_MSAT_PER_UNIT: Record<string, number> = {
  '': 100_000_000_000,
  m: 100_000_000,
  u: 100_000,
  n: 100,
  p: 0.1
}

// per BOLT-11's own multiplier-choice algorithm (the `bolt11` Python
// package's msat_to_amount, which lnurl-mint's own bech32m.py reuses
// verbatim for LUD-25 Part 2's amount-encoding cs1 - see
// recoverableNotes.ts's encodeCs1WithAmount): the COARSEST unit ('' > m >
// u > n > p) that still represents amount_msat exactly as an integer
// digit count. Each successive per-unit value differs by exactly 1000x,
// so this always terminates - worst case 'p' (0.1 msat/digit) divides any
// integer msat amount exactly.
export const encodeBolt11AmountSuffix = (amountMsat: number): string => {
  if (!Number.isInteger(amountMsat) || amountMsat < 0) {
    throw new Error('amount_msat must be a non-negative integer.')
  }
  for (const multiplier of ['', 'm', 'u', 'n', 'p'] as const) {
    const digits = amountMsat / BOLT11_AMOUNT_MSAT_PER_UNIT[multiplier]!
    if (Number.isInteger(digits)) return `${digits}${multiplier}`
  }
  // unreachable: 'p' above always divides an integer amountMsat exactly
  throw new Error('amount_msat could not be encoded.')
}

// the inverse of encodeBolt11AmountSuffix - an HRP amount suffix
// ("<digits><multiplier>", e.g. "10n") back to msat. Null (never throws)
// on anything that doesn't parse, same convention as
// decodeBolt11AmountMsat below (which this doesn't share code with,
// despite the overlap, so each stays a faithful, independent mirror of
// its own reference algorithm).
export const decodeBolt11AmountSuffix = (suffix: string): number | null => {
  const match = suffix.match(/^(\d+)([munp])?$/)
  if (!match) return null
  const [, digits, multiplier] = match
  const msat = Number(digits) * BOLT11_AMOUNT_MSAT_PER_UNIT[multiplier ?? '']!
  return Number.isSafeInteger(msat) ? msat : null
}

// pulls just the amount out of a bolt11 invoice's human-readable part - no
// full bech32/TLV decode needed for that. The bech32 separator is the LAST
// '1' in the string (data characters can also be '1'); everything before it
// is "ln" + network + optional digits + optional multiplier. Null for a
// no-amount invoice or anything that doesn't parse as one.
export const decodeBolt11AmountMsat = (pr: string): number | null => {
  const trimmed = pr.trim().toLowerCase()
  const sep = trimmed.lastIndexOf('1')
  if (sep < 2) return null
  const hrp = trimmed.slice(0, sep)
  const match = hrp.match(/^ln(?:bc|tb|bcrt|tbs|sb)(\d+)?([munp])?$/)
  if (!match) return null
  const [, digits, multiplier] = match
  if (!digits) return null
  const msat = Number(digits) * BOLT11_AMOUNT_MSAT_PER_UNIT[multiplier || '']!
  return Number.isInteger(msat) ? msat : null
}

// BOLT-11's tagged-field type values - each is the data part's own bech32
// charset index of the letter the spec names it after (e.g. 'p' is index 1
// in "qpzry9x8gf2tvdw0s3jn54khce6mua7l"), not an arbitrary enum
const BOLT11_TAG_PAYMENT_HASH = 1

// full bech32 decode this time (decodeBolt11AmountMsat above only reads the
// human-readable part) - walks the tagged-field section to pull out
// payment_hash ('p', always exactly 52 5-bit words = 260 bits = the 256-bit
// hash plus 4 padding bits) so a disclosed melt/mint preimage can be
// checked against the actual invoice it claims to settle, not just trusted
// on the service's word. Layout after the checksum-stripped data words:
// [7 words timestamp][tagged fields: 1 word type + 2 words length + data]
// [104 words signature] - the signature isn't tagged, so the field loop
// stops 104 words short of the end rather than trying to parse it as one
export const decodeBolt11PaymentHash = (pr: string): string | null => {
  const trimmed = pr.trim().toLowerCase()
  try {
    const decoded = bech32.decode(trimmed as `${string}1${string}`, 2048)
    const words = decoded.words
    const fieldsEnd = words.length - 104
    let pos = 7
    while (pos + 3 <= fieldsEnd) {
      const tag = words[pos]
      const len = words[pos + 1]! * 32 + words[pos + 2]!
      const start = pos + 3
      const end = start + len
      if (end > fieldsEnd) break
      if (tag === BOLT11_TAG_PAYMENT_HASH && len === 52) {
        return bytesToHex(
          bech32.fromWords(words.slice(start, end)).slice(0, 32)
        )
      }
      pos = end
    }
    return null
  } catch {
    return null
  }
}

// true only when preimage is well-formed AND actually hashes to the exact
// payment_hash this invoice commits to - the one thing that turns a
// service's bare {"preimage": "..."} claim into independent proof, the same
// way offline verification (signature.ts) turns a bare mintPubkey claim
// into one. Never throws: an undecodable invoice or malformed preimage is
// simply not verified, same as a missing preimage
export const verifyMeltPreimage = (pr: string, preimage: string): boolean => {
  if (!isPreimage(preimage)) return false
  const expected = decodeBolt11PaymentHash(pr)
  if (!expected) return false
  return bytesToHex(sha256(hexToBytes(preimage))) === expected
}
