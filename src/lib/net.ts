import {isAllowedServiceUrl} from './urls'
import {AmbiguousMintError, ServiceError} from './errors'

// host policy hook: refuse a request before it's ever attempted (e.g. a
// wallet-wide "offline mode" toggle). Defaults to always-allow; a host
// configures this once at startup - see lnurlcash.ts.
export type NetworkGuard = () => void

let networkGuard: NetworkGuard = () => {}

export const configureNetworkGuard = (guard: NetworkGuard): void => {
  networkGuard = guard
}

// host transport hook: how a request actually reaches the SERVICE (e.g. a
// sandboxed host with no direct network access, going through its shell).
// Defaults to fetch with redirects exposed to this module; a host configures
// this once at startup. A custom transport is trusted to do the same rather
// than following a redirect before its destination has passed the URL policy.
// `method` defaults to GET at every call site except the LUD-25 Part 2 username
// registration endpoints (addresses.ts), the one place in this kit that isn't
// a plain k1-bearing GET callback (see 25.md's Seed & derivation).
export type Transport = (
  url: string,
  signal: AbortSignal,
  method: string
) => Promise<Response>

let transport: Transport = (url, signal, method) =>
  fetch(url, {signal, method, redirect: 'manual'})

export const configureTransport = (next: Transport): void => {
  transport = next
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5
const MAX_BODY_BYTES = 1_048_576

const fetchResponse = async (
  url: string,
  method: string
): Promise<Response> => {
  try {
    // bounded wait: without a timeout a hung service would freeze whatever
    // flow called this (lookup, refresh, melt) forever
    return await transport(url, AbortSignal.timeout(30_000), method)
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
}

const fetchFollowingSafeRedirects = async (
  startUrl: string,
  method: string
): Promise<Response> => {
  let current = startUrl
  let currentMethod = method
  for (let redirects = 0; ; redirects++) {
    const response = await fetchResponse(current, currentMethod)
    const redirected =
      response.type === 'opaqueredirect' ||
      REDIRECT_STATUSES.has(response.status)
    if (!redirected) return response

    const location = response.headers.get('location')
    if (!location || redirects >= MAX_REDIRECTS) {
      throw new AmbiguousMintError(
        location
          ? 'The service redirected too many times.'
          : 'The service redirected without exposing a safe destination.'
      )
    }

    let next: string
    try {
      next = new URL(location, current).toString()
    } catch {
      throw new AmbiguousMintError(
        'The service redirected to an invalid destination.'
      )
    }
    if (!isAllowedServiceUrl(next)) {
      throw new AmbiguousMintError(
        'The service redirected somewhere this wallet will not fetch.'
      )
    }
    await response.body?.cancel().catch(() => {})
    // Match fetch's redirect method rules while keeping every destination
    // visible for admission here: 303 changes any non-HEAD request to GET,
    // and 301/302 do the same for POST. 307/308 preserve the method.
    if (
      (response.status === 303 && currentMethod !== 'HEAD') ||
      ((response.status === 301 || response.status === 302) &&
        currentMethod === 'POST')
    ) {
      currentMethod = 'GET'
    }
    current = next
  }
}

const readBoundedJson = async (response: Response): Promise<any> => {
  // A configured host transport is trusted and older hosts/tests may return
  // the minimal Response-like shape this hook historically accepted. Real
  // fetch responses take the bounded streaming path below.
  if (!response.headers) {
    try {
      return await response.json()
    } catch {
      throw new AmbiguousMintError('Service returned an invalid response.')
    }
  }
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new AmbiguousMintError('The service returned an oversized response.')
  }

  if (!response.body) {
    throw new AmbiguousMintError('Service returned an invalid response.')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const {done, value} = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {})
        throw new AmbiguousMintError(
          'The service returned an oversized response.'
        )
      }
      chunks.push(value)
    }
  } catch (err) {
    if (err instanceof AmbiguousMintError) throw err
    throw new AmbiguousMintError(
      'The service response was interrupted before it could be read.'
    )
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new AmbiguousMintError('Service returned an invalid response.')
  }
}

// the one choke point every LNURLcash request in this kit goes through -
// lookups, melt, split, merge, rotate, verify, minting.
export const lnurlFetch = async (
  url: string | URL,
  method: string = 'GET'
): Promise<any> => {
  networkGuard()
  if (!isAllowedServiceUrl(url.toString())) {
    throw new Error(
      'The service provided a URL this wallet will not fetch (not an allowed https/http address).'
    )
  }
  const res = await fetchFollowingSafeRedirects(url.toString(), method)
  const body = await readBoundedJson(res)
  if (body?.status === 'ERROR') {
    throw new ServiceError(typeof body.reason === 'string' ? body.reason : '')
  }
  return body
}
