import {bech32} from '@scure/base'
import {sha256} from '@noble/hashes/sha2.js'
import {secp256k1} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {offlineMode} from './offlineMode'
import {nextCashSecret, requireRecoverableCashSecret} from './cashSecrets'
import {msatToSats} from './helpers'

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

// ---- LUD-01 bech32 encoding ----

export const isBech32Lnurl = (data: string): boolean =>
  data.trim().toUpperCase().startsWith('LNURL1')

export const toBech32Lnurl = (url: string): string => {
  const bytes = new TextEncoder().encode(url)
  return bech32.encode('lnurl', bech32.toWords(bytes), 2048).toUpperCase()
}

export const fromBech32Lnurl = (data: string): string | null => {
  const safe = data.trim().toUpperCase()
  if (!safe.startsWith('LNURL1')) return null
  try {
    const decoded = bech32.decode(
      `LNURL1${safe.slice(6)}` as `${string}1${string}`,
      2048
    )
    return new TextDecoder().decode(bech32.fromWords(decoded.words))
  } catch {
    return null
  }
}

// ---- LUD-17 scheme URLs ----

// mirrors lnurl_server's INSECURE_HOSTS: these (plus .onion) resolve to
// http:// instead of https://
const INSECURE_HOSTS = ['127.0.0.1', '0.0.0.0', 'localhost']

const isInsecureHost = (host: string): boolean =>
  INSECURE_HOSTS.includes(host) || host.endsWith('.onion')

// the scheme to assume for a host that arrived without one. Three places need
// this - a LUD-17 URL, a Lightning Address domain, and a claim link's bare
// mint - and the third of them used to hardcode https, so a note from the
// local dev mint scanned off a vault resolved to a URL nothing serves.
// `hostish` may carry a port or a path; only the host part decides.
export const defaultSchemeFor = (hostish: string): 'http' | 'https' =>
  isInsecureHost(hostish.split('/')[0]!.split(':')[0]!) ? 'http' : 'https'

// the one admission rule every URL this wallet fetches must pass, whether it
// came from a scanned/pasted note string or from a service's own response
// (callback, verify, payLink, ...): https anywhere, http only for the
// deliberate insecure hosts above. Anything else - data:, file:, a bare
// http:// clearnet host - is rejected, so a crafted note can't answer its
// own informational GET (a data: URL carrying a withdrawRequest JSON would
// otherwise mint a self-contained fake "verified" note), and a service
// response can't redirect a k1-bearing callback onto cleartext or a scheme
// fetch() would interpret in some other way. The production CSP already
// blocks most of this in shipped builds - this is the code-level guarantee
// that doesn't depend on the CSP meta surviving a self-hosted build or dev
export const isAllowedServiceUrl = (value: string): boolean => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  if (url.protocol === 'http:') return isInsecureHost(url.hostname)
  return false
}

export const fromLud17 = (url: string): string => {
  const match = url.match(/^(?:lnurlw|lnurlp|lnurlc|keyauth):\/\/([^/]+)/i)
  if (!match) return url
  return url.replace(/^[a-z]+:\/\//i, `${defaultSchemeFor(match[1]!)}://`)
}

export const toLud17w = (url: string): string =>
  url.replace(/^https?:\/\//, 'lnurlw://')

// LUD-16: a Lightning Address resolves to its .well-known payRequest URL -
// a local-part, an "@", and a domain. The domain has to carry a dot,
// because a name without one cannot resolve on the public internet - except
// for the handful of hosts this wallet deliberately reaches over http
// (INSECURE_HOSTS above), where "localhost" is a real destination and has no
// dot to give.
//
// That exception is not tidiness. The mint quick-select builds an address by
// prepending "mint@" to a stored server (Mint.tsx's guessMintAddress), so a
// mint trusted at localhost:8111 - which is exactly what this project's own
// documented dev loop produces - could be typed by hand but not clicked. The
// bare form "localhost:8111" resolved, because isBareMintDomain already bends
// for a dot-less dev host; "mint@localhost:8111" matched neither branch and
// came back "Enter a mint LNURL or Lightning Address" against a button the
// holder had just pressed. 127.0.0.1 hid it: it has dots, so the one dev host
// in the tests was the one that worked.
export const isLightningAddress = (value: string): boolean => {
  const trimmed = value.trim()
  const at = trimmed.indexOf('@')
  // exactly one "@", and something either side of it
  if (at <= 0 || at === trimmed.length - 1) return false
  if (trimmed.indexOf('@', at + 1) !== -1) return false
  const domain = trimmed.slice(at + 1)
  if (/\s/.test(trimmed)) return false
  if (/^[^\s@]+\.[^\s@]+$/.test(domain)) return true
  // dot-less: only the hosts an http fetch is allowed to reach at all, so
  // this can never widen what resolves on the public internet
  return isInsecureHost(domain.split(':')[0])
}

const lnAddressToUrl = (address: string): string => {
  const [name, domain] = address.trim().split('@')
  return `${defaultSchemeFor(domain!)}://${domain}/.well-known/lnurlp/${name}`
}

// a bare mint domain, with no local-part - either literally bare
// ("mint.600.wtf") or with a leading "@" the way some mints display their
// own address ("@mint.600.wtf", NIP-05-style), no scheme and no path. Not a
// general-purpose "guess a URL from a hostname" - specific to this wallet's
// own default mint@<domain> convention (see Mint.tsx's guessMintAddress,
// PUBLIC_MINTS below), the same "mint" username lnurl-mint itself defaults
// USERNAME to, so a mint that actually uses a different one still just
// fails normally and has to be typed out in full. A bare insecure dev host
// ("localhost:8000", no dot at all) is also accepted, so the documented
// local-mint dev loop actually resolves.
const isBareMintDomain = (value: string): boolean => {
  const trimmed = value.trim()
  if (isLightningAddress(trimmed)) return false
  if (/^@?[^\s@/]+\.[^\s@/]+$/.test(trimmed)) return true
  return isInsecureHost(trimmed.replace(/^@/, '').split(':')[0])
}

const bareMintDomainToUrl = (value: string): string =>
  lnAddressToUrl(`mint@${value.trim().replace(/^@/, '')}`)

// narrower than resolveLnurlInput below - a mint lookup accepts a bech32
// LNURL, a Lightning Address, or a bare mint domain (see isBareMintDomain),
// all of which point unambiguously at one payRequest with no guessing at
// scheme or path beyond the "mint" username default the bare form assumes
export const resolveMintInput = (value: string): string | null => {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (isBech32Lnurl(trimmed)) {
    const url = fromBech32Lnurl(trimmed)
    return url && isAllowedServiceUrl(url) ? url : null
  }
  if (isLightningAddress(trimmed)) return lnAddressToUrl(trimmed)
  if (isBareMintDomain(trimmed)) return bareMintDomainToUrl(trimmed)
  return null
}

// matches the LUD-16 .well-known/lnurlp/{name} path any resolved payRequest
// URL follows - whether it got there via an actual Lightning Address
// (lnAddressToUrl above), a bech32 LNURL that happens to decode to the same
// convention, or a raw URL typed/scanned directly. Shared by mintAddressUrl
// and lightningAddressUsername below so neither has to re-derive it from
// the raw input text (which a bech32/scanned URL never carried in the
// first place) - the resolved URL's own path already has the answer.
const LNURLP_PATH_RE = /^(.*\/\.well-known\/)lnurlp\/([^/]+)$/

// LUD-25 mint address (theoretical/experimental - see lnurl-mint's README):
// the withdraw-side mirror of a payRequest URL, at .well-known/lnurlw/{name}
// instead of .../lnurlp/{name} - same username, same origin. Derived
// straight from the payRequest URL itself (whatever this wallet already
// resolved mint input to - see resolveMintInput), not guessed from the raw
// input: null for anything not at that conventional path, nothing to
// mirror.
export const mintAddressUrl = (payUrl: string): string | null => {
  let parsed: URL
  try {
    parsed = new URL(payUrl)
  } catch {
    return null
  }
  const match = parsed.pathname.match(LNURLP_PATH_RE)
  if (!match) return null
  return `${parsed.origin}${match[1]}lnurlw/${match[2]}`
}

// the username segment of a resolved payRequest URL ("mint" out of
// .../.well-known/lnurlp/mint) - null for a URL that isn't at that
// conventional path. Cached onto TrustedMint (see trustedMints.ts) so a
// later quick-select can reconstruct the exact address this mint was
// actually reached at, instead of guessing "mint@<server>" (see Mint.tsx's
// guessMintAddress) for a mint that uses a different one.
export const lightningAddressUsername = (payUrl: string): string | null => {
  try {
    return new URL(payUrl).pathname.match(LNURLP_PATH_RE)?.[2] ?? null
  } catch {
    return null
  }
}

// resolves arbitrary LNURL-ish input (bech32, LUD-17 scheme, Lightning
// Address, plain http(s)) down to a fetchable URL. Every URL-producing
// branch passes isAllowedServiceUrl, so a decoded or pasted URL can never
// smuggle in a non-https scheme (data:, file:) or cleartext http to a
// clearnet host - and the LUD-17 branch's result is re-validated with the
// URL parser rather than trusted from fromLud17's regex host split
export const resolveLnurlInput = (value: string): string | null => {
  // scanners hand the scheme back with the payload, and the conventional QR
  // carries it (toLightningUri) - so this has to read our own codes too
  const trimmed = value.trim().replace(/^lightning:/i, '')
  if (!trimmed) return null
  if (isBech32Lnurl(trimmed)) {
    const url = fromBech32Lnurl(trimmed)
    return url && isAllowedServiceUrl(url) ? url : null
  }
  if (/^(lnurlw|lnurlp|lnurlc|keyauth):\/\//i.test(trimmed)) {
    const url = fromLud17(trimmed)
    return isAllowedServiceUrl(url) ? url : null
  }
  if (isLightningAddress(trimmed)) return lnAddressToUrl(trimmed)
  if (/^https?:\/\//i.test(trimmed)) {
    return isAllowedServiceUrl(trimmed) ? trimmed : null
  }
  return null
}

// ---- bearer notes ----

// a note is its withdraw LNURL with the secret as k1 query param. The k1
// is normalized to lowercase hex - it's bytes, not text, so case carries
// no meaning, and normalizing keeps duplicate detection and the echo check
// (fetchNoteInfo) from treating the same secret pasted in two casings as
// two different notes
export const noteK1 = (url: string): string | null => {
  try {
    return new URL(url).searchParams.get('k1')?.toLowerCase() ?? null
  } catch {
    return null
  }
}

// like noteK1, but throws instead of returning null - a device-backed
// bearer's url deliberately never carries a real k1 (see withoutK1), so
// any call site about to use one for a mint mutation should call this
// instead: it fails loudly and specifically rather than silently sending
// a blank/wrong k1 to a mint
export const requireNoteK1 = (url: string): string => {
  const k1 = noteK1(url)
  if (!k1) {
    throw new Error(
      'This note has no secret in the browser. If it is marked "on device", reconnect the vault before refreshing or spending it.'
    )
  }
  return k1
}

// the amount a note *claims* to carry, straight from the URL - only a claim
// by whoever encoded it (SERVICE ignores it at the informational endpoint),
// safe to show before contacting SERVICE but not to be trusted without a
// matching signature (see verifyNoteSignature) or a fresh online GET
export const noteDeclaredAmount = (url: string): number | null => {
  try {
    const raw = new URL(url).searchParams.get('amount')
    if (raw === null) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

export const noteSignature = (url: string): string | null => {
  try {
    return new URL(url).searchParams.get('sig')
  } catch {
    return null
  }
}

// input only qualifies as a bearer note if it resolves to a URL carrying a
// well-formed k1 - 32 bytes hex, the same shape isPreimage enforces (a k1
// that isn't hex would crash sha256-based hashing later, e.g. in offline
// signature verification during render, so it's rejected at the door)
export const resolveNoteInput = (value: string): string | null => {
  const url = resolveLnurlInput(value)
  const k1 = url ? noteK1(url) : null
  if (!url || !k1 || !isPreimage(k1)) return null
  return url
}

export const isValidNoteInput = (value: string): boolean =>
  resolveNoteInput(value) !== null

// withdrawLink (raw LUD-17 URL of the withdraw endpoint) + a fresh secret
// -> note. `amountMsat` is the declared value (see noteDeclaredAmount) -
// omit it when the real value isn't known yet (e.g. claiming a preimage
// that arrived from outside this wallet, with no invoice request of our
// own to read it from): the spec has SERVICE ignore amount at this
// endpoint regardless, but some implementations validate it strictly, and
// a placeholder like 0 risks being rejected as invalid rather than ignored.
export const buildNoteUrl = (
  withdrawLink: string,
  k1: string,
  amountMsat?: number
): string => {
  const url = new URL(fromLud17(withdrawLink.trim()))
  url.searchParams.set('k1', k1.trim().toLowerCase())
  if (amountMsat !== undefined) {
    url.searchParams.set('amount', String(amountMsat))
  }
  return url.toString()
}

// the same note with its secret swapped out - after rotate/split/merge. A
// signature only carries over when the response actually returned a fresh
// one for this k1.  An ambiguous or non-conformant response drops any stale
// sig because it cannot match the new secret.
export const withNewK1 = (
  url: string,
  k1: string,
  amountMsat: number,
  signature?: string
): string => {
  const newUrl = new URL(url)
  newUrl.searchParams.set('k1', k1)
  newUrl.searchParams.set('amount', String(amountMsat))
  if (signature) newUrl.searchParams.set('sig', signature)
  else newUrl.searchParams.delete('sig')
  return newUrl.toString()
}

// like withNewK1, but deletes k1 instead of setting it - for re-deriving a
// device-backed bearer's blank-mirror url from an existing note's own url
// template (same host/path), after a rotate/split/merge whose fresh secret
// now lives on the device, not in this browser
export const withoutK1 = (
  url: string,
  amountMsat: number,
  signature?: string
): string => {
  const newUrl = new URL(url)
  newUrl.searchParams.delete('k1')
  newUrl.searchParams.set('amount', String(amountMsat))
  if (signature) newUrl.searchParams.set('sig', signature)
  else newUrl.searchParams.delete('sig')
  return newUrl.toString()
}

// strips a note's own sig, if any, leaving k1/amount/everything else
// untouched - for a holder who'd rather hand over a note that can't be
// checked offline against a pinned mint key than have this wallet keep
// disclosing which service issued it. Offline verification (see
// verifyNoteSignature) already treats a missing sig as simply unverifiable,
// never as an error, so a stripped note remains an otherwise ordinary
// bearer note to whoever receives it.
export const withoutSignature = (url: string): string => {
  const newUrl = new URL(url)
  newUrl.searchParams.delete('sig')
  return newUrl.toString()
}

export const serverOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

// The security identity of a SERVICE.  Unlike serverOf's display-only host,
// this retains the scheme and port, so two services at the same hostname do
// not share a signing-key pin.  Bare hosts are accepted for migration and
// manual-entry callers, using the same scheme policy as every network URL.
export const serviceOriginOf = (value: string): string => {
  const expanded = fromLud17(value.trim())
  try {
    if (
      /^[a-z][a-z0-9+.-]*:\/\//i.test(expanded) &&
      !/^https?:\/\//i.test(expanded)
    ) {
      return ''
    }
    const candidate = /^https?:\/\//i.test(expanded)
      ? expanded
      : `${defaultSchemeFor(expanded)}://${expanded}`
    return isAllowedServiceUrl(candidate) ? new URL(candidate).origin : ''
  } catch {
    return ''
  }
}

// The withdraw endpoint's host AND path - what a note has to be rebuilt from,
// and so what a vault must be told to store as a note's `host`.
//
// LUD-25 is explicit that a note is the whole withdrawRequest URL:
// "lnurlw://mint.example/w?k1=<P>&amount=<msat> *is* the bearer note". Reduce
// that to "mint.example" and there is nothing left to GET - the path is not
// decoration, it is part of which note this is, and no amount of guessing
// recovers it for a SERVICE that does not serve withdraw at the root.
//
// serverOf() above is for DISPLAY, where a bare hostname is what a person
// wants to read. It was being used for this too, which is how a vault ended
// up holding notes whose on-screen QR encoded lnurlw://mint.example?k1=...
// and resolved to the mint's landing page. The two are not interchangeable
// and are deliberately not one function.
export const noteEndpointOf = (url: string): string => {
  try {
    const parsed = new URL(fromLud17(url.trim()))
    // A root-path endpoint contributes no path segment, so the rebuilt note
    // is "mint.example?k1=..." rather than "mint.example/?k1=...".
    const path =
      parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '')
    return `${parsed.host}${path}`
  } catch {
    return serverOf(url)
  }
}

// ---- offline verification ----

const MINT_PUBKEY_PATTERN = /^0[23][0-9a-f]{64}$/i
const NOTE_SIGNATURE_PATTERN = /^[0-9a-f]{130}$/i

const parseMintKey = (body: any): {mintPubkey: string} => {
  if (
    typeof body?.mintPubkey !== 'string' ||
    !MINT_PUBKEY_PATTERN.test(body.mintPubkey)
  ) {
    throw new Error(
      'SERVICE did not publish a valid persistent signing key (mintPubkey).'
    )
  }
  return {mintPubkey: body.mintPubkey.toLowerCase()}
}

const requireMutationSignature = (body: any, field: 'sig' | 'sig2'): string => {
  const signature = body?.[field]
  if (typeof signature === 'string' && NOTE_SIGNATURE_PATTERN.test(signature)) {
    return signature.toLowerCase()
  }
  // The SERVICE has already answered OK, so callers must preserve the fresh
  // output secret even though the response is non-conformant.  Reuse the
  // ambiguous-result path which carries or commits those secrets safely.
  throw new AmbiguousMintError(
    `SERVICE confirmed the mutation without a valid ${field} signature.`
  )
}

// Signed the same way LUD-13 signs its auth seed phrase - the standard
// Lightning node `signmessage` wrapping:
//   message = "LNURLcash:" || amount_msat (decimal ASCII) || ":" || hex(sha256(k1))
//   digest  = sha256(sha256("Lightning Signed Message:" || message))
const LIGHTNING_SIGNED_MESSAGE_PREFIX = utf8ToBytes('Lightning Signed Message:')

// LUD-25: for a rotate/split/merge, WALLET - not SERVICE - generates the
// replacement note's secret and discloses only its hash (h/h2 on the
// callback) - a fresh 32-byte value, the same size an actual Lightning
// payment preimage already is, though nothing is ever paid for it. The
// same function also produces the `secret` behind a comment-protected mint
// (see MIN_COMMENT_LENGTH_FOR_SECRET below) - both are the same kind of
// thing, an opaque 32-byte value only WALLET ever needs to produce.
//
// `domain` is the issuing SERVICE's own host (see serverOf) - every call
// site below already has it in scope from the callback/payRequest URL it's
// about to use. Seed-recoverable note secrets (LUD-25): prefers a
// deterministic secret derived from this wallet's seed (see cashSecrets.ts)
// so a lost/reinstalled wallet can reconstruct it from nothing but the seed
// phrase plus a small per-domain index, falling back to plain randomness
// only when no seed-derived root is loaded (locked, or a wallet that hasn't
// re-entered its seed since this feature shipped).
export const generateNoteSecret = (domain: string): string =>
  nextCashSecret(domain) ??
  bytesToHex(crypto.getRandomValues(new Uint8Array(32)))

// New mint invoices and cross-mint transfers must survive a reload after
// payment. Unlike an ordinary mutation output, they cannot safely use the
// in-memory random fallback: require a seed-derived secret whose counter was
// persisted before the quote leaves this wallet.
export const generateMintSecret = (domain: string): string =>
  requireRecoverableCashSecret(domain)

// exported so callers can hash the mint secret behind a LUD-12 `comment`
// the same way (see MIN_COMMENT_LENGTH_FOR_SECRET) - it's the same
// hex-in/hex-out sha256 either way, just applied to a not-yet-disclosed
// secret instead of an existing k1
export const hashK1 = (k1: string): string => bytesToHex(sha256(hexToBytes(k1)))

const noteSignatureDigestForHash = (
  h: string,
  amountMsat: number
): Uint8Array => {
  if (!/^[0-9a-fA-F]{64}$/.test(h.trim())) {
    throw new Error('A note hash must be 32 bytes of hex.')
  }
  const message = utf8ToBytes(
    `LNURLcash:${amountMsat}:${h.trim().toLowerCase()}`
  )
  return sha256(
    sha256(new Uint8Array([...LIGHTNING_SIGNED_MESSAGE_PREFIX, ...message]))
  )
}

const noteSignatureDigest = (k1: string, amountMsat: number): Uint8Array =>
  noteSignatureDigestForHash(hashK1(k1), amountMsat)

// recovers the signer's pubkey from (k1, amountMsat, signature) and checks
// it against `mintPubkey` - true only if both match. `signature` is 65
// bytes, but which end carries the recovery id varies by mint in practice:
// the spec text calls for r || s || recovery-id (trailing - the same
// layout raw BOLT-11 signatures use); lnurl-mint used to instead send its
// underlying Lightning node's signmessage RPC output unreordered -
// recovery-id || r || s (leading) - and has since fixed that, but other
// implementations may still get it wrong. Trying both candidate orderings
// costs nothing security-wise (recovering against the wrong one just
// yields an unrelated pubkey that won't match mintPubkey) and means a note
// verifies correctly regardless of which convention its issuer followed.
const verifyNoteSignatureDigest = (
  digest: Uint8Array,
  signatureHex: string,
  mintPubkeyHex: string
): boolean => {
  let wireSig: Uint8Array
  try {
    wireSig = hexToBytes(signatureHex)
  } catch {
    return false
  }
  if (wireSig.length !== 65) return false
  const target = mintPubkeyHex.toLowerCase()
  const trailing = new Uint8Array([wireSig[64], ...wireSig.subarray(0, 64)])
  const leading = wireSig
  for (const candidate of [trailing, leading]) {
    try {
      // `digest` is already the final double-sha256 per the spec/LUD-13 -
      // @noble/curves' recoverPublicKey otherwise defaults to `prehash:
      // true` and hashes it again internally, which would make this
      // recover against a value nothing ever actually signed and never
      // match a real signer's key (masked in this repo's own tests before
      // this fix, since the mock signer there had the same bug the other
      // way - see lnurlcash.test.ts)
      const recovered = secp256k1.recoverPublicKey(candidate, digest, {
        prehash: false
      })
      if (bytesToHex(recovered) === target) return true
    } catch {
      // not a valid recovery under this ordering - try the other one
    }
  }
  return false
}

export const verifyNoteSignature = (
  k1: string,
  amountMsat: number,
  signatureHex: string,
  mintPubkeyHex: string
): boolean => {
  try {
    return verifyNoteSignatureDigest(
      noteSignatureDigest(k1, amountMsat),
      signatureHex,
      mintPubkeyHex
    )
  } catch {
    // A malformed stored k1 is unverifiable, never a render-time crash.
    return false
  }
}

// A sealed vault discloses h=sha256(k1), not k1. A bound-mint receipt signs
// that same note id, so the companion can authenticate it without asking the
// device to export the bearer secret.
export const verifyNoteSignatureHash = (
  h: string,
  amountMsat: number,
  signatureHex: string,
  mintPubkeyHex: string
): boolean => {
  try {
    return verifyNoteSignatureDigest(
      noteSignatureDigestForHash(h, amountMsat),
      signatureHex,
      mintPubkeyHex
    )
  } catch {
    return false
  }
}

// ---- protocol requests ----

// a request whose outcome is unknown: the failure happened in a window
// where it may already have reached and been processed by the service - a
// timeout, a dropped connection, an unparseable response, or a 200 that
// didn't carry the expected confirmation. Distinct from a parsed
// {"status":"ERROR"} rejection (definitive: processed and refused) and from
// failures before anything was sent (offline mode, a URL this wallet won't
// fetch). For a mutating callback request the difference is fund-critical:
// treating an ambiguous failure as "nothing happened" can discard the fresh
// secrets of outputs the service in fact minted - see AmbiguousMutationError
export class AmbiguousMintError extends Error {}

// an AmbiguousMintError from rotate/split/merge, carrying the fresh
// wallet-generated secrets whose hashes the uncertain request disclosed -
// the only copies of the possibly-minted outputs. Order matches the
// primitive's result shape: [rotated] / [split-off, change] / [merged]
export class AmbiguousMutationError extends AmbiguousMintError {
  readonly newSecrets: string[]
  constructor(message: string, newSecrets: string[]) {
    super(message)
    this.newSecrets = newSecrets
  }
}

// the definitive counterpart: a parsed {"status":"ERROR"} the SERVICE sent,
// carrying its `reason` exactly as it arrived - empty string included.
// Kept separate from `message` (display text, which falls back to this
// wallet's own wording when SERVICE says nothing) because classifyNoteError
// decides a note's fate by matching that text, and must only ever match
// words SERVICE actually said
export class ServiceError extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(reason || 'The service rejected the request without saying why.')
    this.reason = reason
    this.name = 'ServiceError'
  }
}

const lnurlFetch = async (url: string | URL): Promise<any> => {
  if (offlineMode()) {
    throw new Error(
      'Offline mode is on - turn it off in the nav to reach a service.'
    )
  }
  if (!isAllowedServiceUrl(url.toString())) {
    throw new Error(
      'The service provided a URL this wallet will not fetch (not an allowed https/http address).'
    )
  }
  let res: Response
  try {
    // bounded wait: without a timeout a hung service would freeze whatever
    // flow called this (lookup, refresh, melt) forever
    res = await fetch(url.toString(), {signal: AbortSignal.timeout(30_000)})
  } catch (err) {
    // transport failures are ambiguous for a mutating request (see
    // AmbiguousMintError) - the request may have arrived before the failure
    if ((err as Error).name === 'TimeoutError') {
      throw new AmbiguousMintError(
        'The service took too long to respond - try again later.'
      )
    }
    throw new AmbiguousMintError(
      'Failed to reach the service - it may be offline or not allow cross-origin requests.'
    )
  }
  const body = await res.json().catch(() => {
    throw new AmbiguousMintError('Service returned an invalid response.')
  })
  if (body?.status === 'ERROR') {
    throw new ServiceError(typeof body.reason === 'string' ? body.reason : '')
  }
  return body
}

export type WithdrawRequestInfo = {
  tag: 'withdrawRequest'
  callback: string
  k1: string
  minWithdrawable: number
  maxWithdrawable: number
  defaultDescription?: string
  mintPubkey: string
}

export type HashWithdrawRequestInfo = Omit<WithdrawRequestInfo, 'k1'>

const parseNoteLookupBody = (body: any): HashWithdrawRequestInfo => {
  if (
    body?.tag !== 'withdrawRequest' ||
    typeof body.callback !== 'string' ||
    typeof body.maxWithdrawable !== 'number' ||
    !Number.isFinite(body.maxWithdrawable) ||
    body.maxWithdrawable < 0 ||
    (body.minWithdrawable !== undefined &&
      (typeof body.minWithdrawable !== 'number' ||
        !Number.isFinite(body.minWithdrawable) ||
        body.minWithdrawable < 0 ||
        body.minWithdrawable > body.maxWithdrawable))
  ) {
    throw new Error('Not a withdrawRequest (unexpected response).')
  }
  return {...body, ...parseMintKey(body)} as HashWithdrawRequestInfo
}

const requestNoteInfoByHash = async (
  url: string,
  h: string
): Promise<HashWithdrawRequestInfo> => {
  if (!/^[0-9a-f]{64}$/i.test(h)) {
    throw new Error('A note hash must be 32 bytes of hex.')
  }
  const hashUrl = new URL(url)
  hashUrl.searchParams.delete('k1')
  hashUrl.searchParams.delete('amount')
  hashUrl.searchParams.delete('sig')
  hashUrl.searchParams.set('h', h.toLowerCase())
  const body = await lnurlFetch(hashUrl)
  if (body.k1 !== undefined) {
    throw new Error('SERVICE returned k1 in a hash-only lookup response.')
  }
  return parseNoteLookupBody(body)
}

// For device-held notes the companion already has h in public recovery
// metadata and never needs to export k1 merely to inspect value or signing
// keys.  No raw-k1 compatibility fallback is possible or attempted here.
export const fetchNoteInfoByHash = async (
  url: string,
  h: string
): Promise<HashWithdrawRequestInfo> => {
  try {
    return await requestNoteInfoByHash(url, h)
  } catch (err) {
    throw classifyNoteError(err as Error)
  }
}

// The informational GET (LUD-03 step 1) never burns, rotates or alters the
// note.  Prefer LUD-25's h=hex(sha256(k1)) lookup so merely checking value and
// signing keys does not expose the bearer secret.  Fall back to raw k1 only
// when an older SERVICE explicitly reports that k1 is the missing/required
// parameter.  Unknown/spent replies and transport failures never trigger a
// secret-revealing retry.
export const fetchNoteInfo = async (
  url: string
): Promise<WithdrawRequestInfo> => {
  // A device-backed bearer deliberately keeps only a secret-free mirror URL
  // in browser storage. Never send that mirror to /w: SERVICE quite rightly
  // rejects a withdraw lookup without k1, but its validation error hides the
  // useful recovery action (reconnect the vault and export there). Every
  // legitimate caller already reconstructs a secret-bearing URL first.
  const queried = requireNoteK1(url)
  const rawUrl = new URL(url)
  rawUrl.searchParams.delete('sig')
  try {
    const info = await requestNoteInfoByHash(rawUrl.toString(), hashK1(queried))
    return {...info, k1: queried}
  } catch (err) {
    const missingK1 =
      err instanceof ServiceError &&
      /(?:missing|required|specify).{0,40}\bk1\b|\bk1\b.{0,40}(?:missing|required)/i.test(
        err.reason
      )
    if (!missingK1) throw classifyNoteError(err as Error)
  }
  let body: any
  try {
    body = await lnurlFetch(rawUrl)
  } catch (fallbackError) {
    throw classifyNoteError(fallbackError as Error)
  }
  // A raw compatibility response MUST echo the actual bearer secret, never a
  // derived/opaque id.  The hash response omits it; restore the wallet's own
  // already-known value only in the local return object for existing callers.
  if (typeof body.k1 !== 'string' || body.k1.toLowerCase() !== queried) {
    throw new Error(
      "Service echoed back a different k1 than queried - the note may have been redeemed elsewhere, or the service isn't spec-compliant."
    )
  }
  return {
    ...parseNoteLookupBody(body),
    k1: queried
  } as WithdrawRequestInfo
}

// after an AmbiguousMutationError: did the burn the request asked for
// actually happen? Probes one of the input k1s with an informational GET:
// 'live' (still outstanding - the request never landed, so the fresh
// secrets the error carries minted nothing and can be dropped safely),
// 'gone' (the service reports it spent/unknown - the burn landed and the
// carried secrets are the only money left), or 'unknown' (the probe itself
// failed - no information either way, keep everything)
export const probeBurnedNote = async (
  url: string
): Promise<'live' | 'gone' | 'unknown'> => {
  try {
    await fetchNoteInfo(url)
    return 'live'
  } catch (err) {
    if (err instanceof NoteSpentError || err instanceof NoteUnknownError) {
      return 'gone'
    }
    return 'unknown'
  }
}

// LUD-25 mint address (see mintAddressUrl above): the withdraw-side
// discovery response a mint MAY publish there - this mint's own node
// identity (alias/uri/color/capacity), the amount bounds a freshly minted
// note can actually fall into, and payLink back to the real payRequest.
// Unlike WithdrawRequestInfo there's no real k1 behind this - it's purely
// informational (this mint only ever custodies bearer notes, never
// per-user accounts, so there's no balance behind a username to withdraw),
// so it's typed and parsed separately rather than reusing that type with
// an optional k1: nothing here is ever safe to treat as spendable.
export type MintAddressInfo = {
  tag: 'withdrawRequest'
  callback: string
  minWithdrawable: number
  maxWithdrawable: number
  defaultDescription?: string
  // SERVICE signing identity.  It is deliberately separate from nodePubkey:
  // backends without a compatible node signer use a persistent dedicated key.
  mintPubkey: string
  // Best-effort Lightning node identity parsed from nodeUri, for display only.
  nodePubkey?: string
  payLink: string
  nodeAlias?: string
  nodeUri?: string
  nodeColor?: string
  // the wire field is `nodeCapacity` (msat, see lnurl-mint's
  // LnurlMintAddressResponse) - suffixed here so a caller doesn't read a
  // bare capacity as sats, and mapped below, since a rename that isn't
  // mapped just reads undefined
  nodeCapacityMsat?: number
  nodeNumChannels?: number
  nodeNumPeers?: number
  // advance warning of a planned shutdown (lnurl-mint's config.py
  // SUNSET_DATE), ISO-8601 (e.g. "2026-12-31") - absent for a mint with no
  // planned sunset (most of them), or one that predates this field.
  // Independent of the mint actually having stopped minting: this is
  // purely a heads-up to melt/rotate/transfer notes away before that day,
  // not a live status check
  sunsetDate?: string
  // this mint's total outstanding liability, msat (lnurl-mint's
  // NoteStore.outstanding_msat via LnurlMintAddressResponse) - the combined
  // value of every bearer note it has issued and never burned, straight
  // from its own database rather than anything a funding source reports.
  // Server-side this is always present (defaults to 0), but optional here
  // like every other field on this response: a mint that predates it just
  // omits it
  outstandingNotesMsat?: number
}

// Best-effort discovery only: this endpoint is experimental (not part of
// any numbered LUD), so most mints - including ones this wallet otherwise
// works fine with - simply won't have it. Callers should treat a rejection
// here as "no extra info available" and fall back to the payRequest lookup
// (fetchPayRequest), which remains the only functional path to actually
// mint a note.
export const fetchMintAddress = async (
  url: string
): Promise<MintAddressInfo> => {
  const body = await lnurlFetch(url)
  if (
    body?.tag !== 'withdrawRequest' ||
    typeof body.callback !== 'string' ||
    typeof body.payLink !== 'string' ||
    typeof body.maxWithdrawable !== 'number'
  ) {
    throw new Error('Not a mint address response (unexpected shape).')
  }
  const {mintPubkey, nodeCapacity, outstandingNotesMsat, ...rest} = body
  const signingKey = parseMintKey({mintPubkey})
  const nodePubkey =
    typeof body.nodeUri === 'string' &&
    MINT_PUBKEY_PATTERN.test(body.nodeUri.split('@')[0] ?? '')
      ? body.nodeUri.split('@')[0]!.toLowerCase()
      : undefined
  return {
    ...rest,
    ...signingKey,
    nodePubkey,
    nodeCapacityMsat:
      typeof nodeCapacity === 'number' ? nodeCapacity : undefined,
    outstandingNotesMsat:
      typeof outstandingNotesMsat === 'number'
        ? outstandingNotesMsat
        : undefined
  } as MintAddressInfo
}

export type WithdrawSuccessResponse = {
  status: 'OK'
  sig?: string
  sig2?: string
  // LUD-25 melt proof (optional): only present on a melt's response, and
  // only when SERVICE advertises it - see meltNote
  pr?: string
  verify?: string
}

// thrown for the exact {"status":"ERROR","reason":"pending"} case (see
// meltNote) - distinct from any other Error so callers polling a mid-melt
// note (MeltDialog.tsx) can tell "still in flight, try again shortly" apart from
// every other failure, which instead means the k1 is gone for good
export class PendingNoteError extends Error {
  constructor() {
    super(
      'This note has another operation in progress - try again in a moment.'
    )
    this.name = 'PendingNoteError'
  }
}

// thrown when SERVICE reports the k1 as unambiguously already spent (burned
// by a prior melt/rotate/split/merge, or replayed after one of those) -
// distinct from NoteUnknownError below because SERVICE is authoritative
// here: a wallet holding this k1 locally can safely lock it as spent
// without asking, the same as if it had just melted it itself
export class NoteSpentError extends Error {
  constructor(reason: string) {
    super(`This note has already been spent (service says: "${reason}").`)
    this.name = 'NoteSpentError'
  }
}

// Thrown when SERVICE reports an unknown note.  For privacy, a hash lookup
// uses this same response for burned and never-issued identifiers, so it is a
// definitive "not outstanding" verdict but not proof the note never existed.
// It remains distinct from a raw-k1 NoteSpentError for honest local wording.
export class NoteUnknownError extends Error {
  constructor(reason: string) {
    super(
      `The service doesn't recognize this note (service says: "${reason}").`
    )
    this.name = 'NoteUnknownError'
  }
}

// SERVICE's own wording for "this k1 is dead" varies by implementation and
// by endpoint - the informational GET can afford to distinguish "Note
// already spent." from "Unknown note.", while the mutating callback (an
// atomic, possibly multi-k1 request) can only ever say something like
// "Invalid or already spent k1." since it can't tell which case applies to
// which k1. Classified here so every note-specific call site gets a
// consistent, typed error instead of each re-parsing raw reason text.
// Only what SERVICE actually said is matched. Anything else - a transport
// failure, an unparseable body, a rejection carrying no reason at all -
// is no evidence about the note either way and passes through
// unclassified, so probeBurnedNote reads it as 'unknown' and callers keep
// every secret they hold.
const classifyNoteError = (err: Error): Error => {
  if (!(err instanceof ServiceError)) return err
  const reason = err.reason
  if (/spent/i.test(reason)) return new NoteSpentError(reason)
  if (/unknown|not found/i.test(reason)) return new NoteUnknownError(reason)
  return err
}

const callbackRequest = async (
  callback: string,
  params: [string, string][]
): Promise<WithdrawSuccessResponse> => {
  // Every mutation below is a bearer operation and therefore needs at least
  // one non-empty k1. Fail locally with the same actionable message as a
  // secret-free informational GET instead of leaking an empty query to the
  // mint and surfacing its generic request-validation response.
  const k1s = params.filter(([key]) => key === 'k1').map(([, value]) => value)
  if (k1s.length === 0 || k1s.some(k1 => k1.trim() === '')) {
    throw new Error(
      'This note has no secret in the browser. If it is marked "on device", reconnect the vault before refreshing or spending it.'
    )
  }
  let cbUrl: URL
  try {
    cbUrl = new URL(callback)
  } catch {
    throw new Error('The service provided an invalid callback URL.')
  }
  // append (not set): merge repeats the k1 param
  for (const [key, value] of params) cbUrl.searchParams.append(key, value)
  let body: any
  try {
    body = await lnurlFetch(cbUrl)
  } catch (err) {
    // a k1 already mid-melt (see meltNote) rejects any other callback
    // naming it with this exact reason string, verbatim per spec
    if (err instanceof ServiceError && err.reason === 'pending') {
      throw new PendingNoteError()
    }
    // a transport-level failure leaves the mutation's outcome unknown -
    // it must reach callers typed, not reclassified from its message text
    if (err instanceof AmbiguousMintError) throw err
    throw classifyNoteError(err as Error)
  }
  if (body?.status !== 'OK') {
    throw new AmbiguousMintError('Operation was not confirmed by the service.')
  }
  return body as WithdrawSuccessResponse
}

export type MeltResult = {
  // LUD-25 melt proof (optional): a LUD-21-style URL SERVICE MAY return,
  // proving this exact outgoing payment settled - see
  // fetchInvoiceVerification. Absent unless SERVICE advertises it
  // (lnurl-mint: only when VERIFY_ENABLED).
  verify?: string
  // the invoice being paid, echoed back alongside the proof - lets the
  // caller bind a later settled report to THIS melt, not some other
  // payment's (see sameInvoice)
  pr?: string
}

// melt: burn a single note, the service pays `pr` of exactly its value -
// merge first to melt several notes in one payment (the spec dropped
// multi-k1 melt). `{"status":"OK"}` here only means the payment is now in
// flight, NOT that the note is confirmed spent: SERVICE pays pr
// asynchronously and only finalizes the burn once it settles, restoring
// the note to outstanding if the payment fails instead. Callers should
// treat this as "melt requested," not "melt done" - see BearerCard's melt
// action for how that plays out in the UI.
export const meltNote = async (
  callback: string,
  k1: string,
  pr: string
): Promise<MeltResult> => {
  const body = await callbackRequest(callback, [
    ['k1', k1],
    ['pr', pr.trim()]
  ])
  return {
    verify: body.verify,
    pr: typeof body.pr === 'string' ? body.pr : undefined
  }
}

// ---- hash-parameterized primitives ----
//
// The actual mint call behind rotate/split/merge, taking a hash the caller
// already has instead of generating one itself. This is what LNURLvault
// integration (see deviceOrchestration.ts) drives directly - a device's own
// new_secret/new_secret_pair produces `h`/`h2` there, not this browser's
// generateNoteSecret(). rotateNote/splitNote/mergeNotes below are just the
// browser-generates-its-own-secret case of these.

export type HashedMutationResult = {signature: string}

export const rotateNoteWithHash = async (
  callback: string,
  k1: string,
  h: string
): Promise<HashedMutationResult> => {
  const body = await callbackRequest(callback, [
    ['k1', k1],
    ['h', h]
  ])
  return {signature: requireMutationSignature(body, 'sig')}
}

export type HashedSplitResult = {
  signature: string
  changeSignature: string
}

export const splitNoteWithHash = async (
  callback: string,
  k1s: string[],
  amountMsat: number,
  h: string,
  h2: string
): Promise<HashedSplitResult> => {
  const body = await callbackRequest(callback, [
    ...k1s.map((k1): [string, string] => ['k1', k1]),
    ['amount', String(amountMsat)],
    ['h', h],
    ['h2', h2]
  ])
  return {
    signature: requireMutationSignature(body, 'sig'),
    changeSignature: requireMutationSignature(body, 'sig2')
  }
}

export const mergeNotesWithHash = async (
  callback: string,
  k1s: string[],
  h: string
): Promise<HashedMutationResult> => {
  const body = await callbackRequest(callback, [
    ...k1s.map((k1): [string, string] => ['k1', k1]),
    ['h', h]
  ])
  return {signature: requireMutationSignature(body, 'sig')}
}

export type RotateResult = {k1: string; signature: string}

// rotate: burn k1, get a fresh secret of the same value - closes the window
// in which any previous holder (or logged URL) could redeem the note. Also
// how a wallet obtains a compact, offline-verifiable copy of a note that
// doesn't have one yet (e.g. straight after minting). Per LUD-25, this
// wallet - not the service - generates that fresh secret and discloses
// only its hash (h): the service never sees, generates, or persists the
// replacement note's raw secret, closing the prior-holder exposure a
// server-generated one would otherwise reopen every time.
export const rotateNote = async (
  callback: string,
  k1: string
): Promise<RotateResult> => {
  const newK1 = generateNoteSecret(serverOf(callback))
  try {
    const result = await rotateNoteWithHash(callback, k1, hashK1(newK1))
    return {k1: newK1, signature: result.signature}
  } catch (err) {
    // the request may have landed - the fresh secret is then the only copy
    // of the rotated note, so it rides the error rather than vanishing
    if (err instanceof AmbiguousMintError) {
      throw new AmbiguousMutationError((err as Error).message, [newK1])
    }
    throw err
  }
}

export type SplitResult = {
  k1: string
  signature: string
  change: string
  changeSignature: string
}

// split: burn one or many k1s (LUD-25: "one or many | no | yes"), mint one
// note worth `amountMsat` and one carrying the remainder of their combined
// value - both secrets wallet-generated per LUD-25 (see rotateNote),
// disclosed as h/h2. Splitting several notes at once needs no prior merge:
// this burns all of them in a single request, same as mergeNotes does
export const splitNote = async (
  callback: string,
  k1s: string[],
  amountMsat: number
): Promise<SplitResult> => {
  const domain = serverOf(callback)
  const newK1 = generateNoteSecret(domain)
  const changeK1 = generateNoteSecret(domain)
  try {
    const result = await splitNoteWithHash(
      callback,
      k1s,
      amountMsat,
      hashK1(newK1),
      hashK1(changeK1)
    )
    return {
      k1: newK1,
      signature: result.signature,
      change: changeK1,
      changeSignature: result.changeSignature
    }
  } catch (err) {
    // the request may have landed - the fresh secrets are then the only
    // copies of both outputs, so they ride the error rather than vanishing
    if (err instanceof AmbiguousMintError) {
      throw new AmbiguousMutationError((err as Error).message, [
        newK1,
        changeK1
      ])
    }
    throw err
  }
}

// merge: burn all given notes, mint one worth their sum - wallet-generated
// secret per LUD-25 (see rotateNote), disclosed as h
export const mergeNotes = async (
  callback: string,
  k1s: string[]
): Promise<RotateResult> => {
  const newK1 = generateNoteSecret(serverOf(callback))
  try {
    const result = await mergeNotesWithHash(callback, k1s, hashK1(newK1))
    return {k1: newK1, signature: result.signature}
  } catch (err) {
    // the request may have landed - the fresh secret is then the only copy
    // of the merged note, so it rides the error rather than vanishing
    if (err instanceof AmbiguousMintError) {
      throw new AmbiguousMutationError((err as Error).message, [newK1])
    }
    throw err
  }
}

export type SettledNote = {
  k1: string
  amountMsat: number
  signature?: string
  callback: string
}

// Resolves what a split's change note or a merge's result note is actually
// worth without mutating it again. Neither response
// carries its own amount (WithdrawSuccessResponse has none - the spec's
// only source of truth for a note's value is an informational GET), and a
// mint that charges fees (LUD-25) may have deducted some from a split's
// change, or refunded some into a merge's result - using the naively
// computed pre-fee amount instead pairs a wrong `amount` with a signature
// the mint actually issued for the true one, so the note looks unsigned
// even though it isn't. The lookup uses h=sha256(k1), so the existing note and
// its signature can be retained without another mutation.
export const settleNote = async (
  baseUrl: string,
  k1: string,
  expectedAmountMsat: number,
  signature: string | undefined
): Promise<SettledNote> => {
  const info = await fetchNoteInfo(
    withNewK1(baseUrl, k1, expectedAmountMsat, signature)
  )
  return {
    k1,
    amountMsat: info.maxWithdrawable,
    signature,
    callback: info.callback
  }
}

// ---- minting via LUD-06 payRequest ----

export type MintFee = {
  baseFeeMsat: number
  feePpm: number
}

export type PayRequestInfo = {
  tag: 'payRequest'
  callback: string
  minSendable: number
  maxSendable: number
  metadata: string
  // LUD-25: present when paying this mints a bearer note at this raw
  // LUD-17 withdraw endpoint. Current minting binds the note to a
  // wallet-chosen secret through the mandatory callback comment.
  withdrawLink?: string
  // Optional on this payRequest shape.  When present it is the SERVICE
  // signing key, which may deliberately differ from the invoice/node key.
  mintPubkey?: string
  // LUD-25 (optional): parsed from metadata (see parseMintFee) - absent
  // means SERVICE didn't advertise one, which the spec says to read as
  // fee-free, not "unknown"
  mintFee?: MintFee
  // LUD-12 capacity. It is optional for a generic payRequest, but a current
  // LUD-25 mint payRequest must advertise at least 64 characters so WALLET
  // can send the hex sha256 commitment naming the new note.
  commentAllowed?: number
  // Additive ForgeSworn/Moneyer extension. Literal true means the mint also
  // accepts the matching `h` field and may offer an authenticated receipt;
  // it never substitutes for commentAllowed above.
  mintToHash?: boolean
}

// The current LUD-25 draft profile requires enough room for exactly what
// generateNoteSecret + hashK1 produce: a hex-encoded 32-byte hash.
export const MIN_COMMENT_LENGTH_FOR_SECRET = 64

// true only if SERVICE's payRequest advertised enough `commentAllowed`
// (LUD-12) to carry a hex-encoded 32-byte hash. Generic callers can inspect
// this predicate; mint-creation paths must call requireMintComment below.
export const canUseMintComment = (info: PayRequestInfo): boolean =>
  typeof info.commentAllowed === 'number' &&
  info.commentAllowed >= MIN_COMMENT_LENGTH_FOR_SECRET

// Refuse before requesting an invoice: paying an unnamed mint invoice can
// recreate the preimage-race design the current LUD-25 profile removes.
export const requireMintComment = (info: PayRequestInfo): void => {
  if (!canUseMintComment(info)) {
    throw new Error(
      'This mint cannot create current LUD-25 notes because it does not advertise commentAllowed: 64.'
    )
  }
}

// LUD-25 mint fees (optional): SERVICE signals what it withholds on minting
// via an extra ["text/plain", "Mint fees: <base_fee_msat>,<fee_percent_ppm>"]
// entry in a payRequest's metadata array, so a WALLET can warn the payer up
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
// is always whatever the informational GET reports after claiming (see
// Mint.tsx's claim)
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

// fee_percent_ppm is parts-per-million - /10_000 for a percent, then trim
// the trailing zeros toFixed leaves behind (2000 ppm -> "0.2000" -> "0.2")
export const formatFeePercent = (ppm: number): string =>
  (ppm / 10_000).toFixed(4).replace(/\.?0+$/, '')

// parseMintFee already collapses a fully-zero fee down to null, so by the
// time one reaches here at least one of the two components is set - only
// mention the one(s) that actually are
export const describeMintFee = (fee: MintFee): string =>
  [
    fee.baseFeeMsat > 0 ? `${msatToSats(fee.baseFeeMsat)} sat flat` : null,
    fee.feePpm > 0
      ? `${formatFeePercent(fee.feePpm)}% of the amount paid`
      : null
  ]
    .filter(Boolean)
    .join(' + ')

export const fetchPayRequest = async (url: string): Promise<PayRequestInfo> => {
  const body = await lnurlFetch(url)
  if (body?.tag !== 'payRequest' || typeof body.callback !== 'string') {
    throw new Error('Not a payRequest (unexpected response).')
  }
  const mintFee =
    typeof body.metadata === 'string' ? parseMintFee(body.metadata) : null
  return {
    ...body,
    mintFee: mintFee ?? undefined,
    mintToHash: body.mintToHash === true,
    commentAllowed:
      typeof body.commentAllowed === 'number' ? body.commentAllowed : undefined
  } as PayRequestInfo
}

export type BoundMintCommitment = {
  h: string
  amountMsat: number
  signature?: string
}

const parseBoundMintCommitment = (
  value: unknown
): BoundMintCommitment | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (
    typeof raw.h !== 'string' ||
    !/^[0-9a-fA-F]{64}$/.test(raw.h) ||
    typeof raw.amount !== 'number' ||
    !Number.isSafeInteger(raw.amount) ||
    raw.amount <= 0 ||
    (raw.sig !== undefined && typeof raw.sig !== 'string')
  ) {
    return undefined
  }
  return {
    h: raw.h.toLowerCase(),
    amountMsat: raw.amount,
    ...(typeof raw.sig === 'string' ? {signature: raw.sig} : {})
  }
}

export type InvoiceResult = {
  pr: string
  // LUD-21 (optional): a URL to poll for this invoice's settlement status
  verify?: string
  // LUD-11: false means SERVICE wants the payRequest LNURL/Lightning
  // Address itself (not this one invoice, which is always spent once
  // paid regardless) kept around and reused - per spec, disposable being
  // null/absent MUST be read as true, so only an explicit `false` counts
  disposable: boolean
  // Per-quote acknowledgement and optional pre-settlement commitment for
  // the additive bound-receipt extension.
  mintToHash: boolean
  mint?: BoundMintCommitment
}

// `outputHash` names a current LUD-25 mint output. It is sent as the
// mandatory LUD-12 comment and repeated as the additive `h` extension. The
// parameter is omitted for ordinary Lightning payments.
export const requestInvoice = async (
  payCallback: string,
  amountMsat: number,
  outputHash?: string
): Promise<InvoiceResult> => {
  const cbUrl = new URL(payCallback)
  cbUrl.searchParams.set('amount', String(amountMsat))
  if (outputHash !== undefined) {
    if (!isPreimage(outputHash)) {
      throw new Error(
        'An output hash must be 32 bytes of hex - no invoice was requested.'
      )
    }
    const h = outputHash.trim().toLowerCase()
    cbUrl.searchParams.set('comment', h)
    cbUrl.searchParams.set('h', h)
  }
  const body = await lnurlFetch(cbUrl)
  if (typeof body?.pr !== 'string') {
    throw new Error('Service did not return an invoice.')
  }
  // a service that answers an amount request with an invoice for a
  // DIFFERENT amount is broken or hostile - the invoice's amount is
  // checked wherever it decodes (an amountless one is passed through:
  // nothing to check it against here, the mint judges it later)
  const invoiceMsat = decodeBolt11AmountMsat(body.pr)
  if (invoiceMsat !== null && invoiceMsat !== amountMsat) {
    throw new Error(
      `Service returned an invoice for ${invoiceMsat} msat, not the ${amountMsat} requested.`
    )
  }
  return {
    pr: body.pr,
    verify: typeof body.verify === 'string' ? body.verify : undefined,
    disposable: body.disposable !== false,
    mintToHash: body.mintToHash === true,
    mint: parseBoundMintCommitment(body.mint)
  }
}

export type VerifyResult = {
  settled: boolean
  preimage: string | null
  pr: string
  mint?: BoundMintCommitment
}

// LUD-21: polls whether an invoice from requestInvoice has settled, via the
// URL it optionally returned as `verify`. `preimage` is only populated by a
// service that chooses to return it. For current comment-bound minting it is
// safe settlement proof and is not the note secret; callers must still bind
// the response to the exact requested invoice with sameInvoice.
export const fetchInvoiceVerification = async (
  verifyUrl: string
): Promise<VerifyResult> => {
  const body = await lnurlFetch(verifyUrl)
  if (typeof body?.settled !== 'boolean' || typeof body?.pr !== 'string') {
    throw new Error('Service returned an unexpected verify response.')
  }
  return {
    settled: body.settled,
    preimage: typeof body.preimage === 'string' ? body.preimage : null,
    pr: body.pr,
    mint: parseBoundMintCommitment(body.mint)
  }
}

// Refuse before an invoice is displayed unless the mint committed this exact
// quote to the staged device hash and a fee-compatible net amount. A
// pre-settlement signature would falsely claim value already exists.
export const requireBoundMintQuote = (
  invoice: InvoiceResult,
  expectedH: string,
  grossMsat: number,
  fee?: MintFee
): BoundMintCommitment => {
  const h = expectedH.trim().toLowerCase()
  if (!isPreimage(h)) throw new Error('The expected mint output is malformed.')
  const commitment = invoice.mint
  if (!invoice.mintToHash || !invoice.verify || !commitment) {
    throw new Error(
      'The mint did not offer an authenticated device-bound receipt for this quote.'
    )
  }
  if (commitment.h !== h) {
    throw new Error('The mint committed the quote to a different output.')
  }
  const amountAccepted = fee
    ? withinMintFeeBand(grossMsat, commitment.amountMsat, fee)
    : commitment.amountMsat === grossMsat
  if (!amountAccepted) {
    throw new Error(
      'The mint committed the quote to an unexpected note amount.'
    )
  }
  if (commitment.signature !== undefined) {
    throw new Error('The mint signed an output before its invoice settled.')
  }
  return commitment
}

// Authenticate the settled receipt without k1: the signature is over the
// already-known output hash. Invoice, hash and amount must all repeat the
// pre-payment commitment before the device can move PENDING -> CONFIRMED.
export const validateBoundMintReceipt = (
  invoice: InvoiceResult,
  verification: VerifyResult,
  expectedH: string,
  expectedAmountMsat: number,
  mintPubkey: string
): Required<BoundMintCommitment> => {
  if (!verification.settled) throw new Error('The invoice has not settled.')
  if (!sameInvoice(invoice.pr, verification.pr)) {
    throw new Error('The settlement receipt names a different invoice.')
  }
  const receipt = verification.mint
  if (
    !receipt ||
    receipt.h !== expectedH.trim().toLowerCase() ||
    receipt.amountMsat !== expectedAmountMsat
  ) {
    throw new Error('The settlement receipt does not match the mint quote.')
  }
  if (
    !receipt.signature ||
    !verifyNoteSignatureHash(
      receipt.h,
      receipt.amountMsat,
      receipt.signature,
      mintPubkey
    )
  ) {
    throw new Error('The settled mint receipt has an invalid signature.')
  }
  return {...receipt, signature: receipt.signature}
}

// bolt11 is bech32 - case-insensitive - so invoice equality is a
// normalized string compare. Used to bind a verify response (or a melt
// proof) to the exact invoice it claims to report on: a settled result for
// some OTHER invoice must never confirm this wallet's payment
export const sameInvoice = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase()

// a payment preimage (the future k1): 32 bytes hex
export const isPreimage = (value: string): boolean =>
  /^[0-9a-fA-F]{64}$/.test(value.trim())

// a raw BOLT-11 invoice - loose shape check only (one of the known network
// prefixes, an optional amount, then the bech32 separator), same
// non-exhaustive spirit as isValidNoteInput. Anchored to actual bolt11
// prefixes (bc/tb/bcrt/...) rather than a bare "ln", which a bech32 LNURL
// ("lnurl1...") would also match.
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
  const msat = Number(digits) * BOLT11_AMOUNT_MSAT_PER_UNIT[multiplier || '']
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
      const len = words[pos + 1] * 32 + words[pos + 2]
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
// way offline verification (see above) turns a bare mintPubkey claim into
// one. Never throws: an undecodable invoice or malformed preimage is simply
// not verified, same as a missing preimage
export const verifyMeltPreimage = (pr: string, preimage: string): boolean => {
  if (!isPreimage(preimage)) return false
  const expected = decodeBolt11PaymentHash(pr)
  if (!expected) return false
  return bytesToHex(sha256(hexToBytes(preimage))) === expected
}
