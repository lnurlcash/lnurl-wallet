import {afterEach, describe, expect, it} from 'vitest'
import {configureTransport, type Transport} from '../../lnurlcash'
import {
  fetchOracleAnnouncement,
  fetchOracleAttestation,
  fetchOracleEvents
} from './oracleClient'

const defaultTransport: Transport = (url, signal, method) =>
  fetch(url, {signal, method, redirect: 'manual'})

afterEach(() => {
  configureTransport(defaultTransport)
})

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {status})

describe('fetchOracleEvents', () => {
  it('returns the parsed event list on 200', async () => {
    const events = [
      {
        eventId: 'btc-100k-2026',
        category: 'btc-price',
        outcomes: ['above', 'below'],
        maturityTime: 1_790_000_000,
        status: 'announced'
      }
    ]
    configureTransport(async () => jsonResponse(200, events))
    await expect(
      fetchOracleEvents('https://oracle.example.com')
    ).resolves.toEqual(events)
  })

  it('strips a trailing slash from the base URL', async () => {
    let seenUrl = ''
    configureTransport(async url => {
      seenUrl = url
      return jsonResponse(200, [])
    })
    await fetchOracleEvents('https://oracle.example.com/')
    expect(seenUrl).toBe('https://oracle.example.com/events')
  })

  it('surfaces the FastAPI detail message on a non-200 status', async () => {
    configureTransport(async () => jsonResponse(500, {detail: 'db is down'}))
    await expect(
      fetchOracleEvents('https://oracle.example.com')
    ).rejects.toThrow('db is down')
  })

  it('refuses a body that is not an array', async () => {
    configureTransport(async () => jsonResponse(200, {not: 'an array'}))
    await expect(
      fetchOracleEvents('https://oracle.example.com')
    ).rejects.toThrow(/unexpected/)
  })

  it('still refuses a disallowed URL before the transport is ever called', async () => {
    const transport = async (): Promise<Response> => {
      throw new Error('should not be called')
    }
    configureTransport(transport)
    await expect(fetchOracleEvents('ftp://oracle.example.com')).rejects.toThrow(
      /will not fetch/
    )
  })
})

describe('fetchOracleAnnouncement', () => {
  const ANNOUNCEMENT = {
    oraclePubkeyHex: '11'.repeat(32),
    nonceHex: '22'.repeat(32),
    outcomes: ['above', 'below'],
    eventId: 'btc-100k-2026',
    maturityTime: 1_790_000_000
  }

  it('returns the announcement on 200, URL-encoding the event id', async () => {
    let seenUrl = ''
    configureTransport(async url => {
      seenUrl = url
      return jsonResponse(200, ANNOUNCEMENT)
    })
    await expect(
      fetchOracleAnnouncement('https://oracle.example.com', 'btc 100k/2026')
    ).resolves.toEqual(ANNOUNCEMENT)
    expect(seenUrl).toBe(
      'https://oracle.example.com/events/btc%20100k%2F2026/announcement'
    )
  })

  it('throws a specific message on a 404', async () => {
    configureTransport(async () =>
      jsonResponse(404, {detail: 'No such event.'})
    )
    await expect(
      fetchOracleAnnouncement('https://oracle.example.com', 'nope')
    ).rejects.toThrow('No such event.')
  })
})

describe('fetchOracleAttestation', () => {
  it('reports not-resolved (not an error) on a 404', async () => {
    configureTransport(async () =>
      jsonResponse(404, {detail: 'Not resolved yet.'})
    )
    await expect(
      fetchOracleAttestation('https://oracle.example.com', 'btc-100k-2026')
    ).resolves.toEqual({resolved: false})
  })

  it('returns the resolved attestation on 200', async () => {
    const attestation = {
      outcome: 'above',
      signatureHex: '33'.repeat(64),
      resolvedAt: '2026-01-01T00:00:00Z',
      source: 'median of 5 exchanges: 101000.00 USD'
    }
    configureTransport(async () => jsonResponse(200, attestation))
    await expect(
      fetchOracleAttestation('https://oracle.example.com', 'btc-100k-2026')
    ).resolves.toEqual({resolved: true, ...attestation})
  })

  it('throws on a non-404 error status', async () => {
    configureTransport(async () => jsonResponse(500, {detail: 'boom'}))
    await expect(
      fetchOracleAttestation('https://oracle.example.com', 'btc-100k-2026')
    ).rejects.toThrow('boom')
  })
})
