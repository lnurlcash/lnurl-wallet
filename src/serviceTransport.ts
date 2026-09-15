import {nappletIsOffline} from './napplet/preferences'
/** Let protocol callers distinguish a local offline choice from ambiguous network failure. */
export const isServiceOffline = (): boolean =>
  import.meta.env.MODE === 'napplet' && nappletIsOffline()
/** Fetch protocol responses through the host when running as a napplet. */
export const fetchServiceResponse = async (
  url: string,
  signal: AbortSignal
): Promise<Response> => {
  if (import.meta.env.MODE !== 'napplet') return fetch(url, {signal})
  if (nappletIsOffline())
    throw new Error('Offline mode is on. No request was sent.')
  const resource = window.napplet?.resource
  if (!resource) throw new Error('The shell must provide NAP-RESOURCE.')
  const fresh = new URL(url)
  if (fresh.protocol !== 'https:') {
    throw new Error('The napplet requires an HTTPS mint.')
  }
  // RESOURCE implementations may cache by URL. LNURL GETs include mutations:
  // every explicit operation needs a new URL, with no automatic retries.
  fresh.searchParams.set('_lnurlwallet', crypto.randomUUID())
  const blob = await resource.bytes(fresh.toString(), {signal})
  if (blob.size > 1024 * 1024) throw new Error('Mint response is too large.')
  return new Response(blob)
}
