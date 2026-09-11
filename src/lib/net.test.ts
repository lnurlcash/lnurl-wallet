import {afterEach, describe, expect, it, vi} from 'vitest'
import {configureTransport, lnurlFetch, type Transport} from './net'
import {AmbiguousMintError} from './errors'

const defaultTransport: Transport = (url, signal) => fetch(url, {signal})

afterEach(() => {
  configureTransport(defaultTransport)
  vi.unstubAllGlobals()
})

describe('configureTransport', () => {
  it('uses plain fetch by default', async () => {
    const fetchMock = vi.fn(
      async () => ({json: async () => ({tag: 'withdrawRequest'})}) as Response
    )
    vi.stubGlobal('fetch', fetchMock)
    const body = await lnurlFetch('https://mint.example.com/w')
    expect(body.tag).toBe('withdrawRequest')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('routes every request through a configured transport, with a signal', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const transport = vi.fn<Transport>(
      async () => new Response(JSON.stringify({status: 'OK'}))
    )
    configureTransport(transport)
    const body = await lnurlFetch('https://mint.example.com/w/cb?k1=x')
    expect(body.status).toBe('OK')
    expect(transport).toHaveBeenCalledWith(
      'https://mint.example.com/w/cb?k1=x',
      expect.any(AbortSignal)
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats a transport failure as ambiguous, same as a fetch failure', async () => {
    configureTransport(async () => {
      throw new Error('shell refused')
    })
    await expect(lnurlFetch('https://mint.example.com/w')).rejects.toThrow(
      AmbiguousMintError
    )
  })

  it('still refuses a disallowed URL before the transport is ever called', async () => {
    const transport = vi.fn<Transport>()
    configureTransport(transport)
    await expect(lnurlFetch('ftp://mint.example.com/w')).rejects.toThrow(
      /will not fetch/
    )
    expect(transport).not.toHaveBeenCalled()
  })
})
