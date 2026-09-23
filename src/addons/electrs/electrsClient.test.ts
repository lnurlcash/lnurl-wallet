import {afterEach, describe, expect, it} from 'vitest'
import {configureTransport, type Transport} from '../../lnurlcash'
import {fetchAddressSummary, fetchAddressUtxos} from './electrsClient'

const defaultTransport: Transport = (url, signal, method) =>
  fetch(url, {signal, method, redirect: 'manual'})

afterEach(() => {
  configureTransport(defaultTransport)
})

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {status})

const ADDRESS = 'bc1p'.padEnd(62, 'q')

describe('fetchAddressSummary', () => {
  const STATS_SHAPE = {
    funded_txo_count: 2,
    funded_txo_sum: 150_000,
    spent_txo_count: 1,
    spent_txo_sum: 50_000,
    tx_count: 3
  }

  it('returns the parsed summary on 200, computing confirmed balance', async () => {
    configureTransport(async () =>
      jsonResponse(200, {
        address: ADDRESS,
        chain_stats: STATS_SHAPE,
        mempool_stats: {
          funded_txo_count: 0,
          funded_txo_sum: 0,
          spent_txo_count: 0,
          spent_txo_sum: 0,
          tx_count: 0
        }
      })
    )
    const summary = await fetchAddressSummary(
      'https://esplora.example.com',
      ADDRESS
    )
    expect(summary.confirmedBalanceSat).toBe(100_000)
    expect(summary.confirmed.txCount).toBe(3)
  })

  it('strips a trailing slash and interpolates the address into the path', async () => {
    let seenUrl = ''
    configureTransport(async url => {
      seenUrl = url
      return jsonResponse(200, {
        chain_stats: STATS_SHAPE,
        mempool_stats: STATS_SHAPE
      })
    })
    await fetchAddressSummary('https://esplora.example.com/', ADDRESS)
    expect(seenUrl).toBe(`https://esplora.example.com/address/${ADDRESS}`)
  })

  it('refuses an address-shaped value that is not actually plausible', async () => {
    await expect(
      fetchAddressSummary('https://esplora.example.com', 'not an address!!')
    ).rejects.toThrow(/does not look like/)
  })

  it('surfaces the server error message on a non-200 status', async () => {
    configureTransport(async () => jsonResponse(500, {error: 'db is down'}))
    await expect(
      fetchAddressSummary('https://esplora.example.com', ADDRESS)
    ).rejects.toThrow('db is down')
  })

  it('refuses a body missing chain_stats/mempool_stats', async () => {
    configureTransport(async () => jsonResponse(200, {address: ADDRESS}))
    await expect(
      fetchAddressSummary('https://esplora.example.com', ADDRESS)
    ).rejects.toThrow(/unexpected/)
  })

  it('still refuses a disallowed URL before the transport is ever called', async () => {
    configureTransport(async () => {
      throw new Error('should not be called')
    })
    await expect(
      fetchAddressSummary('ftp://esplora.example.com', ADDRESS)
    ).rejects.toThrow(/will not fetch/)
  })
})

describe('fetchAddressUtxos', () => {
  const TXID = '11'.repeat(32)

  it('returns the parsed utxo list on 200', async () => {
    configureTransport(async () =>
      jsonResponse(200, [
        {
          txid: TXID,
          vout: 0,
          value: 25_000,
          status: {confirmed: true, block_height: 900_000}
        }
      ])
    )
    await expect(
      fetchAddressUtxos('https://esplora.example.com', ADDRESS)
    ).resolves.toEqual([
      {
        txid: TXID,
        vout: 0,
        valueSat: 25_000,
        confirmed: true,
        blockHeight: 900_000
      }
    ])
  })

  it('treats an unconfirmed utxo as confirmed:false with no block height', async () => {
    configureTransport(async () =>
      jsonResponse(200, [
        {txid: TXID, vout: 1, value: 1_000, status: {confirmed: false}}
      ])
    )
    const [utxo] = await fetchAddressUtxos(
      'https://esplora.example.com',
      ADDRESS
    )
    expect(utxo).toEqual({
      txid: TXID,
      vout: 1,
      valueSat: 1_000,
      confirmed: false,
      blockHeight: null
    })
  })

  it('refuses a body that is not an array', async () => {
    configureTransport(async () => jsonResponse(200, {not: 'an array'}))
    await expect(
      fetchAddressUtxos('https://esplora.example.com', ADDRESS)
    ).rejects.toThrow(/unexpected/)
  })

  it('refuses a utxo entry whose fields do not match the declared shape', async () => {
    configureTransport(async () =>
      jsonResponse(200, [{txid: 'not-hex', vout: 0, value: 1}])
    )
    await expect(
      fetchAddressUtxos('https://esplora.example.com', ADDRESS)
    ).rejects.toThrow(/unexpected/)
  })
})
