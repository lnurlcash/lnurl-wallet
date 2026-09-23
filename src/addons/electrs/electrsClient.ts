// A thin, read-only client for an electrs/esplora-compatible REST API
// (the same HTTP interface electrs's own esplora frontend, Blockstream's
// esplora, and mempool.space all speak) - lets a holder point this addon
// at their own self-hosted electrs instance, or any public esplora-shaped
// server, to check the balance and UTXOs of a plain onchain address (e.g.
// one derived by the sibling onchain-receive addon) without this wallet
// running any chain indexing of its own.
//
// Same posture as the sibling betlocker addon's oracleClient.ts: every
// call goes through fetchJson (src/lib/net.ts) rather than a bare fetch(),
// so a holder-pasted server URL goes through this kit's own SSRF allowlist
// (isAllowedServiceUrl) and offline-mode guard exactly like every other
// network request this wallet makes - a holder-entered electrs URL is
// exactly the kind of value that policy exists for.
import {fetchJson} from '../../lnurlcash'

const trimSlash = (baseUrl: string): string =>
  baseUrl.trim().replace(/\/+$/, '')

// esplora/electrs addresses are base58 (mixed-case) or bech32(m)
// (lowercase-only, or uppercase-only by spec) - this is a permissive shape
// check (never a full checksum/alphabet validation, that's not this
// client's job), just enough to keep an address from being interpolated
// into the URL path with characters that could reshape the request (a
// literal `/`, whitespace, etc.)
const isPlausibleAddress = (address: string): boolean =>
  /^[a-zA-Z0-9]{14,90}$/.test(address)

const electrsErrorMessage = (body: unknown, fallback: string): string => {
  if (typeof body === 'string' && body) return body
  const detail = (body as {error?: unknown} | null)?.error
  return typeof detail === 'string' && detail ? detail : fallback
}

export type AddressStats = {
  fundedTxoCount: number
  fundedTxoSum: number
  spentTxoCount: number
  spentTxoSum: number
  txCount: number
}

export type AddressSummary = {
  address: string
  confirmed: AddressStats
  mempool: AddressStats
  // convenience: confirmed balance only, in sats - mempool_stats deltas are
  // NOT included (a holder relying on an unconfirmed inbound payment should
  // see that distinction explicitly, not have it silently folded in)
  confirmedBalanceSat: number
}

const asStats = (v: unknown): AddressStats | null => {
  const o = v as Record<string, unknown> | null
  if (
    !o ||
    typeof o !== 'object' ||
    typeof o.funded_txo_count !== 'number' ||
    typeof o.funded_txo_sum !== 'number' ||
    typeof o.spent_txo_count !== 'number' ||
    typeof o.spent_txo_sum !== 'number' ||
    typeof o.tx_count !== 'number'
  ) {
    return null
  }
  return {
    fundedTxoCount: o.funded_txo_count,
    fundedTxoSum: o.funded_txo_sum,
    spentTxoCount: o.spent_txo_count,
    spentTxoSum: o.spent_txo_sum,
    txCount: o.tx_count
  }
}

// GET /address/:address
export const fetchAddressSummary = async (
  baseUrl: string,
  address: string
): Promise<AddressSummary> => {
  if (!isPlausibleAddress(address)) {
    throw new Error('That does not look like a real onchain address.')
  }
  const {status, body} = await fetchJson(
    `${trimSlash(baseUrl)}/address/${address}`
  )
  if (status !== 200) {
    throw new Error(
      electrsErrorMessage(body, 'Could not reach that electrs/esplora server.')
    )
  }
  const o = body as Record<string, unknown> | null
  const confirmed = asStats(o?.chain_stats)
  const mempool = asStats(o?.mempool_stats)
  if (!confirmed || !mempool) {
    throw new Error(
      'That server returned something unexpected for /address/:address.'
    )
  }
  return {
    address,
    confirmed,
    mempool,
    confirmedBalanceSat: confirmed.fundedTxoSum - confirmed.spentTxoSum
  }
}

export type AddressUtxo = {
  txid: string
  vout: number
  valueSat: number
  confirmed: boolean
  blockHeight: number | null
}

const isTxidHex = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v)

const asUtxo = (v: unknown): AddressUtxo | null => {
  const o = v as Record<string, unknown> | null
  if (
    !o ||
    typeof o !== 'object' ||
    !isTxidHex(o.txid) ||
    typeof o.vout !== 'number' ||
    typeof o.value !== 'number'
  ) {
    return null
  }
  const status = o.status as Record<string, unknown> | undefined
  const confirmed = Boolean(status?.confirmed)
  const blockHeight =
    typeof status?.block_height === 'number' ? status.block_height : null
  return {txid: o.txid, vout: o.vout, valueSat: o.value, confirmed, blockHeight}
}

// GET /address/:address/utxo
export const fetchAddressUtxos = async (
  baseUrl: string,
  address: string
): Promise<AddressUtxo[]> => {
  if (!isPlausibleAddress(address)) {
    throw new Error('That does not look like a real onchain address.')
  }
  const {status, body} = await fetchJson(
    `${trimSlash(baseUrl)}/address/${address}/utxo`
  )
  if (status !== 200) {
    throw new Error(
      electrsErrorMessage(body, 'Could not reach that electrs/esplora server.')
    )
  }
  if (!Array.isArray(body)) {
    throw new Error(
      'That server returned something unexpected for /address/:address/utxo.'
    )
  }
  const utxos = body.map(asUtxo)
  if (utxos.some(u => u === null)) {
    throw new Error(
      'That server returned something unexpected for /address/:address/utxo.'
    )
  }
  return utxos as AddressUtxo[]
}
