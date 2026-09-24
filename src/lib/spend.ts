// LUD-25 spends: what a note's signatures sign, and the plain bearer note.
//
// Every note is a BIP341 taproot output key Q. A spend of it - a ck1 (key
// path) or a cw1 (script path) - is checked as input 0 of one fixed,
// never-broadcast transaction (25.md's "The canonical spend transaction"),
// so every signature in it is an ordinary BIP341/342 signature over that
// transaction's sighash, never over a free-form message:
//
//   nVersion 2, nLockTime as claimed
//   vin[0]   prevout (tagged_hash("LNURLcash/mint", domain), 0), nSequence as claimed
//   vout[0]  value 0, empty scriptPubKey
//   spent    (OP_1 <Q>, 0)
//
// `domain` is the mint's lowercase hostname - the host of the note's own
// withdraw URL - so a signature one mint has seen can never be replayed at
// another. The spent amount is always 0: the mint enforces value from its
// own records, and leaving it unsigned lets a key sign for its note before
// knowing the exact post-fee value. A key-path spend always claims locktime
// 0 and sequence 0xffffffff, so a key has one signature per mint.
import {sha256} from '@noble/hashes/sha2.js'
import {schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {tapLeafHash, taprootTweakPubkey} from './recoverableNotes'
import {fromLud17} from './urls'

export const TAPLEAF_VERSION = 0xc0
export const KEY_PATH_LOCKTIME = 0
export const KEY_PATH_SEQUENCE = 0xffffffff

// BIP341's own nothing-up-my-sleeve point: no known discrete log, so an
// output key built on it has no key path at all
export const NUMS_H = hexToBytes(
  '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0'
)

// The domain a spend of a note at `value` is bound to: the bare, lowercase
// hostname of a note URL (lnurlw://, https://, or bech32-decoded) or a
// mint's server URL - never its scheme or port, same as lnurl-mint's own
// check (config.spend_domains).
export const spendDomainOf = (value: string): string => {
  const expanded = fromLud17(value.trim())
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(expanded)
    ? expanded
    : `https://${expanded}`
  const host = new URL(candidate).hostname.toLowerCase()
  if (!host) throw new Error('A spend domain needs a hostname.')
  return host
}

// spendDomainOf, or null when `value` names no host - for display/UI
// plumbing that must never throw on a malformed stored URL.
export const noteMintOf = (value: string): string | null => {
  try {
    return spendDomainOf(value)
  } catch {
    return null
  }
}

export const spendPrevout = (domain: string): Uint8Array => {
  if (!domain) throw new Error('A spend domain is required.')
  return schnorr.utils.taggedHash(
    'LNURLcash/mint',
    utf8ToBytes(domain.toLowerCase())
  )
}

const u32le = (n: number): Uint8Array => {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n, true)
  return out
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const I64_ZERO = new Uint8Array(8)

// BIP341's SigMsg for input 0 of the canonical spend transaction,
// SIGHASH_DEFAULT, plus BIP342's extension when `leafScript` is given - see
// 25.md's "What a signature signs" for the field table.
export const spendSigMsg = ({
  outputKey,
  domain,
  locktime,
  sequence,
  leafScript
}: {
  outputKey: Uint8Array
  domain: string
  locktime: number
  sequence: number
  leafScript?: Uint8Array
}): Uint8Array => {
  if (outputKey.length !== 32) throw new Error('Q must be 32 bytes.')
  const scriptPubKey = concat(new Uint8Array([0x51, 0x20]), outputKey)
  const parts = [
    new Uint8Array([0x00]), // hash_type: SIGHASH_DEFAULT
    u32le(2), // nVersion
    u32le(locktime),
    sha256(concat(spendPrevout(domain), u32le(0))), // sha_prevouts
    sha256(I64_ZERO), // sha_amounts
    sha256(concat(new Uint8Array([scriptPubKey.length]), scriptPubKey)),
    sha256(u32le(sequence)), // sha_sequences
    sha256(concat(I64_ZERO, new Uint8Array([0x00]))), // sha_outputs
    new Uint8Array([leafScript ? 0x02 : 0x00]), // spend_type, no annex
    u32le(0) // input_index
  ]
  if (leafScript) {
    parts.push(
      tapLeafHash(leafScript, TAPLEAF_VERSION),
      new Uint8Array([0x00]), // key_version
      new Uint8Array([0xff, 0xff, 0xff, 0xff]) // no OP_CODESEPARATOR
    )
  }
  return concat(...parts)
}

const tapSighash = (sigMsg: Uint8Array): Uint8Array =>
  schnorr.utils.taggedHash('TapSighash', new Uint8Array([0x00]), sigMsg)

// What a ck1's signature signs.
export const keyPathSighash = (
  outputKey: Uint8Array,
  domain: string
): Uint8Array =>
  tapSighash(
    spendSigMsg({
      outputKey,
      domain,
      locktime: KEY_PATH_LOCKTIME,
      sequence: KEY_PATH_SEQUENCE
    })
  )

// What a signature inside a cw1's leaf signs, for the claimed time.
export const scriptPathSighash = (
  outputKey: Uint8Array,
  domain: string,
  leafScript: Uint8Array,
  locktime: number,
  sequence: number
): Uint8Array =>
  tapSighash(spendSigMsg({outputKey, domain, locktime, sequence, leafScript}))

// ---- the plain bearer note ----
//
// A secret nobody but its holder knows: NUMS internal key, one
// `OP_SHA256 <h> OP_EQUAL` leaf, spent by revealing the preimage with no
// signature (so bound to no domain). Everything but the preimage follows
// from h, which is why 25.md's short forms work: a 64-hex k1 IS the
// preimage, a 64-hex p1/comment/p IS h, and the mint builds the script.

export const bearerLeaf = (h: Uint8Array): Uint8Array => {
  if (h.length !== 32) throw new Error('h must be a 32-byte sha256.')
  return concat(new Uint8Array([0xa8, 0x20]), h, new Uint8Array([0x87]))
}

export const bearerNote = (
  h: Uint8Array
): {outputKey: Uint8Array; controlBlock: Uint8Array; leaf: Uint8Array} => {
  const leaf = bearerLeaf(h)
  const {outputKey, parity} = taprootTweakPubkey(
    NUMS_H,
    tapLeafHash(leaf, TAPLEAF_VERSION)
  )
  return {
    outputKey,
    controlBlock: concat(new Uint8Array([TAPLEAF_VERSION | parity]), NUMS_H),
    leaf
  }
}

// hex(Q) of the bearer note named by its hex h - the id a mint stores it
// under and certifies (cs1) it over.
export const bearerNoteIdOfHash = (hHex: string): string =>
  bytesToHex(bearerNote(hexToBytes(hHex.trim().toLowerCase())).outputKey)

// hex(Q) of the bearer note a hex preimage k1 spends.
export const bearerNoteIdOfPreimage = (k1Hex: string): string =>
  bytesToHex(bearerNote(sha256(hexToBytes(k1Hex.trim()))).outputKey)
