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
// Defaults to plain fetch; a host configures this once at startup.
export type Transport = (url: string, signal: AbortSignal) => Promise<Response>

let transport: Transport = (url, signal) => fetch(url, {signal})

export const configureTransport = (next: Transport): void => {
  transport = next
}

// the one choke point every LNURLcash request in this kit goes through -
// lookups, melt, split, merge, rotate, verify, minting.
export const lnurlFetch = async (url: string | URL): Promise<any> => {
  networkGuard()
  if (!isAllowedServiceUrl(url.toString())) {
    throw new Error(
      'The service provided a URL this wallet will not fetch (not an allowed https/http address).'
    )
  }
  let res: Response
  try {
    // bounded wait: without a timeout a hung service would freeze whatever
    // flow called this (lookup, refresh, melt) forever
    res = await transport(url.toString(), AbortSignal.timeout(30_000))
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
