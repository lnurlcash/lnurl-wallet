// A thin, read-only client for a real DLC oracle service's REST API (see
// lnurlcash-oracle's own DESIGN.md "API" section - this deliberately
// matches it field-for-field: oraclePubkeyHex, nonceHex, outcomes: string[]
// for an announcement; {outcome, signatureHex} - 64-byte hex R||s - for an
// attestation). Any oracle that speaks this shape works, not just
// lnurlcash-oracle specifically - nothing here is tied to one deployment.
//
// Used only by the sibling `betlocker` addon (see verbs.ts's own
// oracle.fetchPubkey/oracle.fetchEvents/oracle.fetchAnnouncement/
// oracle.fetchAttestation), never by the `dlc` Playground - that addon's
// own permissions: [] is
// load-bearing (see its manifest's top comment): it must stay unable to
// reach the network at all, so a live-oracle browser cannot live there.
//
// Every call goes through fetchJson (src/lib/net.ts) rather than a bare
// fetch(), so a sandboxed host's own transport hook and this kit's SSRF
// allowlist (isAllowedServiceUrl) apply here exactly as they do to every
// LNURLcash request this wallet makes - a URL an addon holder pasted in is
// exactly the kind of value that policy exists for.
import {fetchJson} from '../../lnurlcash'

const trimSlash = (baseUrl: string): string =>
  baseUrl.trim().replace(/\/+$/, '')

const oracleErrorMessage = (body: unknown, fallback: string): string => {
  const detail = (body as {detail?: unknown} | null)?.detail
  return typeof detail === 'string' && detail ? detail : fallback
}

// Defense in depth, not the actual security boundary: a malformed field
// here would already be caught downstream (e.g. betlock.ts's own strict
// hex-format checks before anything cryptographic happens, or Renderer.tsx's
// own try/catch around every verb call turning an unexpected exception into
// a plain error toast, never a crash) - see this addon's own review of
// exactly why an oracle response can't reach the Expr/UiNode evaluator as
// anything other than a plain data value. Validating the real runtime shape
// here anyway just means a malformed response fails with ONE clear message
// at the fetch boundary, instead of a confusing exception wherever the
// first unchecked field happens to get used.
const isNonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every(isNonEmptyString)

// GET /oracle-pubkey - this oracle's own long-term identity key, fetched
// directly rather than only ever arriving bundled inside an announcement.
// Lets the Lock UI show (or fill the manual oraclePubkeyHex field with)
// exactly which oracle a holder is about to trust, straight from the
// service itself, before ever picking a specific event - copy-pasting a
// pubkey from somewhere else is one more place a value can be mistyped or
// swapped.
export const fetchOraclePubkey = async (baseUrl: string): Promise<string> => {
  const {status, body} = await fetchJson(`${trimSlash(baseUrl)}/oracle-pubkey`)
  if (status !== 200) {
    throw new Error(oracleErrorMessage(body, 'Could not reach that oracle.'))
  }
  const pubkeyHex = (body as {oraclePubkeyHex?: unknown} | null)
    ?.oraclePubkeyHex
  if (typeof pubkeyHex !== 'string' || !/^[0-9a-f]{64}$/i.test(pubkeyHex)) {
    throw new Error(
      'That oracle returned something unexpected for /oracle-pubkey.'
    )
  }
  return pubkeyHex.toLowerCase()
}

export type OracleEventSummary = {
  eventId: string
  category: string
  outcomes: string[]
  maturityTime: number
  status: string
  priceThresholdUsd?: number
}

const asOracleEventSummary = (
  v: unknown,
  index: number
): OracleEventSummary => {
  const o = v as Record<string, unknown> | null
  if (
    !o ||
    typeof o !== 'object' ||
    !isNonEmptyString(o.eventId) ||
    !isNonEmptyString(o.category) ||
    !isStringArray(o.outcomes) ||
    typeof o.maturityTime !== 'number' ||
    !isNonEmptyString(o.status) ||
    (o.priceThresholdUsd !== undefined &&
      typeof o.priceThresholdUsd !== 'number')
  ) {
    throw new Error(
      `That oracle returned a malformed event at position ${index} of /events.`
    )
  }
  return {
    eventId: o.eventId,
    category: o.category,
    outcomes: o.outcomes,
    maturityTime: o.maturityTime,
    status: o.status,
    ...(typeof o.priceThresholdUsd === 'number'
      ? {priceThresholdUsd: o.priceThresholdUsd}
      : {})
  }
}

// GET /events - every event this oracle has ever announced, most useful
// filtered client-side to status:"announced" (not yet resolved) for a
// "pick one to bet on" list.
export const fetchOracleEvents = async (
  baseUrl: string
): Promise<OracleEventSummary[]> => {
  const {status, body} = await fetchJson(`${trimSlash(baseUrl)}/events`)
  if (status !== 200) {
    throw new Error(oracleErrorMessage(body, 'Could not reach that oracle.'))
  }
  if (!Array.isArray(body)) {
    throw new Error('That oracle returned something unexpected for /events.')
  }
  return body.map((item, i) => asOracleEventSummary(item, i))
}

export type OracleAnnouncement = {
  oraclePubkeyHex: string
  nonceHex: string
  outcomes: string[]
  eventId: string
  maturityTime: number
  priceThresholdUsd?: number
}

// GET /events/{eventId}/announcement - exactly the shape planBet (betlock.ts)
// needs: oraclePubkeyHex, nonceHex, outcomes.
export const fetchOracleAnnouncement = async (
  baseUrl: string,
  eventId: string
): Promise<OracleAnnouncement> => {
  const id = encodeURIComponent(eventId.trim())
  const {status, body} = await fetchJson(
    `${trimSlash(baseUrl)}/events/${id}/announcement`
  )
  if (status !== 200) {
    throw new Error(
      oracleErrorMessage(
        body,
        `Could not fetch the announcement for "${eventId}".`
      )
    )
  }
  const o = body as Record<string, unknown> | null
  if (
    !o ||
    typeof o !== 'object' ||
    !/^[0-9a-f]{64}$/i.test(String(o.oraclePubkeyHex ?? '')) ||
    !/^[0-9a-f]{64}$/i.test(String(o.nonceHex ?? '')) ||
    !isStringArray(o.outcomes) ||
    !isNonEmptyString(o.eventId) ||
    typeof o.maturityTime !== 'number' ||
    (o.priceThresholdUsd !== undefined &&
      typeof o.priceThresholdUsd !== 'number')
  ) {
    throw new Error(
      `That oracle returned a malformed announcement for "${eventId}".`
    )
  }
  return {
    oraclePubkeyHex: (o.oraclePubkeyHex as string).toLowerCase(),
    nonceHex: (o.nonceHex as string).toLowerCase(),
    outcomes: o.outcomes,
    eventId: o.eventId,
    maturityTime: o.maturityTime,
    ...(typeof o.priceThresholdUsd === 'number'
      ? {priceThresholdUsd: o.priceThresholdUsd}
      : {})
  }
}

export type OracleAttestationResult =
  | {
      resolved: true
      outcome: string
      signatureHex: string
      resolvedAt: string
      source: string
    }
  | {resolved: false}

// GET /events/{eventId}/attestation - 404 until the oracle actually
// resolves the event (see lnurlcash-oracle's own endpoint comment: "never
// a guess, never early"), which this surfaces as {resolved:false} rather
// than an error - "not resolved yet" is the expected, common case while
// redeeming, not a failure.
export const fetchOracleAttestation = async (
  baseUrl: string,
  eventId: string
): Promise<OracleAttestationResult> => {
  const id = encodeURIComponent(eventId.trim())
  const {status, body} = await fetchJson(
    `${trimSlash(baseUrl)}/events/${id}/attestation`
  )
  if (status === 404) return {resolved: false}
  if (status !== 200) {
    throw new Error(
      oracleErrorMessage(
        body,
        `Could not fetch the attestation for "${eventId}".`
      )
    )
  }
  const b = body as Record<string, unknown> | null
  if (
    !b ||
    typeof b !== 'object' ||
    !isNonEmptyString(b.outcome) ||
    !/^[0-9a-f]{128}$/i.test(String(b.signatureHex ?? '')) ||
    !isNonEmptyString(b.resolvedAt) ||
    !isNonEmptyString(b.source)
  ) {
    throw new Error(
      `That oracle returned a malformed attestation for "${eventId}".`
    )
  }
  return {
    resolved: true,
    outcome: b.outcome,
    signatureHex: (b.signatureHex as string).toLowerCase(),
    resolvedAt: b.resolvedAt,
    source: b.source
  }
}
