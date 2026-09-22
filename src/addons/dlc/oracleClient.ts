// A thin, read-only client for a real DLC oracle service's REST API (see
// lnurlcash-oracle's own DESIGN.md "API" section - this deliberately
// matches it field-for-field: oraclePubkeyHex, nonceHex, outcomes: string[]
// for an announcement; {outcome, signatureHex} - 64-byte hex R||s - for an
// attestation). Any oracle that speaks this shape works, not just
// lnurlcash-oracle specifically - nothing here is tied to one deployment.
//
// Used only by the sibling `betlocker` addon (see verbs.ts's own
// oracle.fetchEvents/oracle.fetchAnnouncement/oracle.fetchAttestation),
// never by the `dlc` Playground - that addon's own permissions: [] is
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

export type OracleEventSummary = {
  eventId: string
  category: string
  outcomes: string[]
  maturityTime: number
  status: string
  priceThresholdUsd?: number
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
  return body as OracleEventSummary[]
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
  return body as OracleAnnouncement
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
  const b = body as {
    outcome: string
    signatureHex: string
    resolvedAt: string
    source: string
  }
  return {
    resolved: true,
    outcome: b.outcome,
    signatureHex: b.signatureHex,
    resolvedAt: b.resolvedAt,
    source: b.source
  }
}
