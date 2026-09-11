import {bech32} from '@scure/base'
import {isPreimage} from './bolt11'
import {isCk1} from './recoverableNotes'

// LUD-25 LNURLcash - bearer assets. Draft spec:
// https://github.com/lnurl/luds/blob/lnurlcash/25.md
//
// A bearer note is an ordinary LUD-03 withdrawRequest link whose k1 *is*
// the asset. No new endpoint, no new encoding. A GET on the note's LNURL
// is purely informational (the authoritative value is always
// maxWithdrawable, never the URL's own `amount`); every mutating op goes
// to the `callback` from that response - see request.ts.

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

// the one admission rule every URL a client fetches must pass, whether it
// came from a scanned/pasted note string or from a service's own response
// (callback, verify, payLink, ...): https anywhere, http only for the
// deliberate insecure hosts above. Anything else - data:, file:, a bare
// http:// clearnet host - is rejected, so a crafted note can't answer its
// own informational GET (a data: URL carrying a withdrawRequest JSON would
// otherwise mint a self-contained fake "verified" note), and a service
// response can't redirect a k1-bearing callback onto cleartext or a scheme
// fetch() would interpret in some other way.
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
// for the handful of hosts this is deliberately reachable over http
// (INSECURE_HOSTS above), where "localhost" is a real destination and has no
// dot to give.
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
// general-purpose "guess a URL from a hostname" - specific to the
// "mint@<domain>" default convention lnurl-mint itself defaults its own
// USERNAME to, so a mint that actually uses a different one still just
// fails normally and has to be typed out in full. A bare insecure dev host
// ("localhost:8000", no dot at all) is also accepted, so a local-mint dev
// loop actually resolves.
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
// straight from the payRequest URL itself (whatever a caller already
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
// conventional path. Useful for reconstructing the exact address a mint
// was actually reached at, instead of guessing "mint@<server>" for a mint
// that uses a different one.
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
  // carries it (lightning: URIs) - so this has to read those too
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
// (see request.ts's fetchNoteInfo) from treating the same secret pasted in
// two casings as two different notes
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
// matching signature (see signature.ts's verifyNoteSignature) or a fresh
// online GET
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

// a well-formed note secret: either a legacy 32-byte hex preimage, or a
// LUD-25 Part 2 ck1 recoverable-signature secret (see
// src/lib/recoverableNotes.ts) - dispatched on the string's own shape, same as
// every other Part 1/Part 2 dual-mode field in this codebase (no version
// flag). A k1 that's neither would crash sha256-based hashing (isPreimage's
// own reason for existing) or ecrecover later, so it's rejected at the door
// either way.
export const isValidK1 = (value: string): boolean =>
  isPreimage(value) || isCk1(value)

// input only qualifies as a bearer note if it resolves to a URL carrying a
// well-formed k1 (see isValidK1)
export const resolveNoteInput = (value: string): string | null => {
  const url = resolveLnurlInput(value)
  const k1 = url ? noteK1(url) : null
  if (!url || !k1 || !isValidK1(k1)) return null
  return url
}

export const isValidNoteInput = (value: string): boolean =>
  resolveNoteInput(value) !== null

// withdrawLink (raw LUD-17 URL of the withdraw endpoint) + a fresh secret
// -> note. `amountMsat` is the declared value (see noteDeclaredAmount) -
// omit it when the real value isn't known yet (e.g. claiming a preimage
// that arrived from outside this client, with no invoice request of its
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
// now lives on the device, not in the browser
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
// checked offline against a pinned mint key than keep disclosing which
// service issued it. Offline verification (signature.ts) already treats a
// missing sig as simply unverifiable, never as an error, so a stripped
// note remains an otherwise ordinary bearer note to whoever receives it.
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

// The withdraw endpoint's host AND path - what a note has to be rebuilt from.
//
// LUD-25 is explicit that a note is the whole withdrawRequest URL:
// "lnurlw://mint.example/w?k1=<P>&amount=<msat> *is* the bearer note". Reduce
// that to "mint.example" and there is nothing left to GET - the path is not
// decoration, it is part of which note this is, and no amount of guessing
// recovers it for a SERVICE that does not serve withdraw at the root.
//
// serverOf() above is for DISPLAY, where a bare hostname is what a person
// wants to read. The two are not interchangeable and are deliberately not
// one function.
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
