import {afterEach, describe, expect, it, vi} from 'vitest'
import {configureTransport, lnurlFetch, type Transport} from './net'
import {AmbiguousMintError} from './errors'

const defaultTransport: Transport = (url, signal, method) =>
  fetch(url, {signal, method, redirect: 'manual'})

afterEach(() => {
  configureTransport(defaultTransport)
  vi.unstubAllGlobals()
})

describe('configureTransport', () => {
  it('uses plain fetch by default', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({tag: 'withdrawRequest'}))
    )
    vi.stubGlobal('fetch', fetchMock)
    const body = await lnurlFetch('https://mint.example.com/w')
    expect(body.tag).toBe('withdrawRequest')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mint.example.com/w',
      expect.objectContaining({redirect: 'manual'})
    )
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
      expect.any(AbortSignal),
      'GET'
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

  it('refuses an oversized body even when content-length is absent', async () => {
    configureTransport(async () => new Response('x'.repeat(1_048_577)))
    await expect(lnurlFetch('https://mint.example.com/w')).rejects.toThrow(
      /oversized response/
    )
  })

  it('rechecks every redirect before sending the next request', async () => {
    const transport = vi.fn<Transport>().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {location: 'http://attacker.example/steal'}
      })
    )
    configureTransport(transport)
    await expect(
      lnurlFetch('https://mint.example.com/w/cb?k1=secret')
    ).rejects.toThrow(/will not fetch/)
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('follows an admitted redirect with the same method', async () => {
    const transport = vi
      .fn<Transport>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: {location: 'https://mint.example.com/current'}
        })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({status: 'OK'})))
    configureTransport(transport)
    await expect(
      lnurlFetch('https://mint.example.com/register', 'POST')
    ).resolves.toEqual({status: 'OK'})
    expect(transport).toHaveBeenNthCalledWith(
      2,
      'https://mint.example.com/current',
      expect.any(AbortSignal),
      'POST'
    )
  })

  it('uses GET after a POST receives a 302, matching fetch semantics', async () => {
    const transport = vi
      .fn<Transport>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {location: 'https://mint.example.com/current'}
        })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({status: 'OK'})))
    configureTransport(transport)
    await expect(
      lnurlFetch('https://mint.example.com/register', 'POST')
    ).resolves.toEqual({status: 'OK'})
    expect(transport).toHaveBeenNthCalledWith(
      2,
      'https://mint.example.com/current',
      expect.any(AbortSignal),
      'GET'
    )
  })

  it('classifies a mid-body stream failure as ambiguous', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"status":'))
        controller.error(new Error('connection reset'))
      }
    })
    configureTransport(async () => new Response(body))
    await expect(lnurlFetch('https://mint.example.com/w')).rejects.toThrow(
      AmbiguousMintError
    )
  })
})
