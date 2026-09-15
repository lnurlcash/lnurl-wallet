import {DeviceClient} from '../device'
import type {DeviceTransport, DeviceNote} from '../device'
import {identityChallenge, judgeIdentity} from '../devicePinning'
import {useMediatedDeviceQueue, drainPendingDeviceOps} from '../deviceQueue'
import type {PendingDeviceOp} from '../deviceQueue'
import {
  deviceRotate,
  deviceSplit,
  deviceMerge,
  deviceSettle,
  migrateNoteToDevice,
  stageDeviceBoundMint,
  confirmDeviceBoundMint,
  deviceMarkSpent
} from '../deviceOrchestration'
import type {DeviceMutationResult} from '../deviceOrchestration'
import {
  fetchNoteInfoByHash,
  fetchNoteInfo,
  noteEndpointOf,
  buildNoteUrl,
  fetchPayRequest,
  requestInvoice,
  resolveMintInput,
  resolveLnurlInput,
  requireMintComment,
  requireBoundMintQuote,
  validateBoundMintReceipt,
  fetchInvoiceVerification,
  parseMintFee,
  sameInvoice,
  verifyMeltPreimage,
  meltNote,
  decodeBolt11AmountMsat,
  hashK1
} from '../lnurlcash'
import type {InvoiceResult} from '../lnurlcash'
import type {Vault} from './vault'
import {Wallet, requireIssuerUrl} from './wallet'
import {observeMint} from './mints'

type Funding = {
  deviceId: string
  h: string
  endpoint: string
  quote: InvoiceResult
  amount: number
  pubkey: string
  confirmed?: boolean
}
type Payment = {
  deviceId: string
  invoice: string
  endpoint: string
  verify?: string
  proof?: string
}
type Staged = {deviceId: string; h: string; endpoint: string; amount: number}

/** Keep device recovery state encrypted and scoped to its proven identity. */
export class HardwareWallet {
  private client: DeviceClient | null = null
  private identity = ''
  private pendingIdentity = ''
  private queueName = ''
  constructor(
    private vault: Vault,
    private wallet: Wallet
  ) {}

  /** Authenticate a physical vault before enabling its recovery queue or financial commands. */
  async connect(
    transport: DeviceTransport
  ): Promise<{key: string; changed: boolean}> {
    await this.disconnect()
    this.client = new DeviceClient(transport)
    try {
      const info = await this.client.getInfo()
      if (info.storage && info.storage !== 'ok')
        throw new Error(
          `Device storage is ${info.storage}. Use the webwallet diagnostics.`
        )
      const nonce = identityChallenge()
      const saved = await this.vault.meta<{key: string}>('device-identity')
      const verdict = judgeIdentity(
        await this.client.identify(nonce),
        nonce,
        saved?.key ?? null
      )
      if (verdict.kind === 'invalid' || verdict.kind === 'unsupported')
        throw new Error(
          'This device cannot prove its identity. Use supported firmware or the webwallet.'
        )
      this.pendingIdentity = verdict.pubkey
      if (verdict.kind === 'known') await this.acceptIdentity()
      return {key: verdict.pubkey, changed: verdict.kind !== 'known'}
    } catch (error) {
      await this.disconnect()
      throw error
    }
  }

  /** Pin a holder-reviewed identity; never replay another device's pending commits. */
  async acceptIdentity(): Promise<void> {
    if (!this.client || !this.pendingIdentity)
      throw new Error('Connect a device first.')
    await this.vault.setMeta('device-identity', {key: this.pendingIdentity})
    this.identity = this.pendingIdentity
    this.queueName = `device-queue-${this.identity}`
    const queueName = this.queueName
    useMediatedDeviceQueue({
      entries: (await this.vault.meta<PendingDeviceOp[]>(queueName)) ?? [],
      save: entries => this.vault.setMeta(queueName, entries)
    })
    await drainPendingDeviceOps(this.requireClient())
  }

  private requireClient(): DeviceClient {
    if (!this.client || !this.identity)
      throw new Error('Review and accept the connected device identity first.')
    return this.client
  }
  private name(value: string): string {
    return `device-${value}-${this.identity}`
  }

  /** Inventory contains hashes and amounts; it never exports a bearer secret. */
  async notes(): Promise<DeviceNote[]> {
    return this.requireClient().listAllNotes()
  }

  private async checked(
    id: string,
    allowPending = false
  ): Promise<{note: DeviceNote; result: DeviceMutationResult}> {
    const note = (await this.notes()).find(note => note.id === id)
    if (
      !note ||
      (note.state !== 'confirmed' &&
        !(allowPending && note.state === 'pending'))
    )
      throw new Error('Select a confirmed device note.')
    const staged = (
      (await this.vault.meta<Staged[]>(this.name('staged'))) ?? []
    ).find(entry => entry.deviceId === id)
    const host = note.host || staged?.endpoint
    if (!host)
      throw new Error(
        'This device note has no retained mint endpoint. Recover it in the webwallet.'
      )
    const endpoint = requireIssuerUrl(host, host)
    const info = note.h
      ? await fetchNoteInfoByHash(endpoint, note.h)
      : await fetchNoteInfo(
          buildNoteUrl(endpoint, await this.requireClient().exportSecret(id))
        )
    const callback = requireIssuerUrl(info.callback, endpoint)
    await observeMint(this.vault, endpoint, info.mintPubkey)
    return {
      note,
      result: {
        deviceId: id,
        deviceHash: note.h,
        amountMsat: info.maxWithdrawable,
        url: endpoint,
        callback,
        signature: note.sig
      }
    }
  }

  /** Reuse the webwallet's staged device mutations and durable commit queue. */
  async transform(
    ids: string[],
    action: 'rotate' | 'split' | 'combine',
    amount = 0
  ): Promise<void> {
    if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length)
      throw new Error('Select device notes.')
    if (
      (action === 'rotate' && ids.length !== 1) ||
      (action === 'combine' && ids.length < 2)
    )
      throw new Error('Invalid note selection.')
    const records = await Promise.all(ids.map(id => this.checked(id)))
    const first = records[0].result
    if (
      records.some(
        ({result}) =>
          noteEndpointOf(result.url) !== noteEndpointOf(first.url) ||
          result.callback !== first.callback
      )
    )
      throw new Error('Select notes from one mint endpoint.')
    const total = records.reduce((sum, {result}) => sum + result.amountMsat, 0)
    if (!Number.isSafeInteger(total) || total <= 0)
      throw new Error('Invalid selected amount.')
    if (
      action === 'split' &&
      (!Number.isSafeInteger(amount) || amount <= 0 || amount >= total)
    )
      throw new Error('Split amount must be smaller than the selected balance.')
    const client = this.requireClient()
    let outputs: DeviceMutationResult[]
    if (action === 'rotate')
      outputs = [
        await deviceRotate(client, {...first, amount: first.amountMsat})
      ]
    else if (action === 'combine')
      outputs = [
        await deviceMerge(
          client,
          records.map(record => record.result),
          first.callback,
          total
        )
      ]
    else {
      const split = await deviceSplit(
        client,
        records.map(record => record.result),
        first.callback,
        amount,
        total
      )
      outputs = [split.target, split.change]
    }
    for (const output of outputs) {
      const settled = await deviceSettle(client, output)
      requireIssuerUrl(settled.callback, output.url)
    }
    await this.wallet.log('device', `${action} on the connected vault.`)
  }

  /** Rotate a wallet note onto the device, retaining the original as a recovery candidate. */
  async moveToDevice(id: string): Promise<void> {
    const client = this.requireClient()
    const note = (await this.vault.notes()).find(note => note.id === id)
    if (!note || note.status !== 'ready')
      throw new Error('Select a confirmed wallet note.')
    const info = await fetchNoteInfo(note.url)
    const callback = requireIssuerUrl(info.callback, note.url)
    await this.vault.save({
      ...note,
      status: 'pending',
      reason: 'Moving to device; check both candidates after interruption.'
    })
    await migrateNoteToDevice(client, {
      url: note.url,
      callback,
      amount: info.maxWithdrawable
    })
    await this.vault.save({
      ...note,
      status: 'spent',
      reason: 'Replacement held by the physical vault.',
      updatedAt: Date.now()
    })
    await this.wallet.log(
      'device',
      'Moved a wallet note to the physical vault.'
    )
  }

  /** Recover device value into this wallet and rotate before marking the device copy spent. */
  async moveToWallet(id: string): Promise<void> {
    const {note, result} = await this.checked(id, true)
    const k1 = await this.requireClient().exportSecret(id)
    if (note.h && hashK1(k1) !== note.h.toLowerCase())
      throw new Error('Device exported a different note.')
    await this.wallet.receive(buildNoteUrl(result.url, k1, result.amountMsat))
    await deviceMarkSpent(this.requireClient(), id)
  }

  /** Keep the device-generated commitment before requesting or revealing a funding invoice. */
  async mint(input: string, amount: number): Promise<string> {
    const url = resolveMintInput(input) ?? resolveLnurlInput(input)
    if (!url) throw new Error('Enter a mint address.')
    requireIssuerUrl(url, url)
    const info = await fetchPayRequest(url)
    requireMintComment(info)
    if (
      !info.withdrawLink ||
      !info.mintPubkey ||
      !Number.isSafeInteger(amount) ||
      amount < info.minSendable ||
      amount > info.maxSendable
    )
      throw new Error('This mint cannot fund that device note.')
    const endpoint = requireIssuerUrl(
      info.withdrawLink.replace(/^lnurlw:/i, 'https:'),
      url
    )
    const callback = requireIssuerUrl(info.callback, url)
    const staged = await stageDeviceBoundMint(this.requireClient())
    const candidates =
      (await this.vault.meta<Staged[]>(this.name('staged'))) ?? []
    await this.vault.setMeta(this.name('staged'), [
      ...candidates,
      {...staged, endpoint, amount}
    ])
    const quote = await requestInvoice(callback, amount, staged.h)
    if (decodeBolt11AmountMsat(quote.pr) !== amount)
      throw new Error(
        'The mint returned a funding invoice for a different amount.'
      )
    const commitment = requireBoundMintQuote(
      quote,
      staged.h,
      amount,
      parseMintFee(info.metadata) ?? undefined
    )
    quote.verify = requireIssuerUrl(quote.verify!, url)
    const receipts =
      (await this.vault.meta<Funding[]>(this.name('funding'))) ?? []
    await this.vault.setMeta(this.name('funding'), [
      ...receipts,
      {
        ...staged,
        endpoint,
        quote,
        amount: commitment.amountMsat,
        pubkey: info.mintPubkey
      }
    ])
    await observeMint(this.vault, url, info.mintPubkey)
    return quote.pr
  }

  /** Authenticate the bound receipt before confirming device custody. */
  async settleFunding(): Promise<void> {
    const receipts =
      (await this.vault.meta<Funding[]>(this.name('funding'))) ?? []
    for (const entry of receipts.filter(entry => !entry.confirmed)) {
      const verification = await fetchInvoiceVerification(
        requireIssuerUrl(entry.quote.verify!, entry.endpoint)
      )
      if (!verification.settled) continue
      const receipt = validateBoundMintReceipt(
        entry.quote,
        verification,
        entry.h,
        entry.amount,
        entry.pubkey
      )
      await confirmDeviceBoundMint(this.requireClient(), {
        deviceId: entry.deviceId,
        h: entry.h,
        withdrawLink: entry.endpoint,
        amountMsat: receipt.amountMsat,
        signature: receipt.signature
      })
      entry.confirmed = true
      await this.vault.setMeta(this.name('funding'), receipts)
    }
  }

  /** Store payment intent before exporting its one-use device secret. */
  async pay(id: string, invoice: string): Promise<void> {
    const {result} = await this.checked(id)
    if (decodeBolt11AmountMsat(invoice) !== result.amountMsat)
      throw new Error(
        'Split or combine device notes to match the invoice amount.'
      )
    const payments =
      (await this.vault.meta<Payment[]>(this.name('payments'))) ?? []
    if (payments.some(entry => entry.deviceId === id))
      throw new Error(
        'This device note already has a recorded payment; verify it before retrying.'
      )
    const payment: Payment = {deviceId: id, invoice, endpoint: result.url}
    payments.push(payment)
    await this.vault.setMeta(this.name('payments'), payments)
    const k1 = await this.requireClient().exportSecret(id)
    if (result.deviceHash && hashK1(k1) !== result.deviceHash.toLowerCase())
      throw new Error('Device exported a different note.')
    const response = await meltNote(result.callback, k1, invoice)
    if (response.verify) {
      if (!response.pr || !sameInvoice(response.pr, invoice))
        throw new Error('Payment receipt refers to another invoice.')
      payment.verify = requireIssuerUrl(response.verify, result.url)
      await this.vault.setMeta(this.name('payments'), payments)
    }
  }

  /** Burn the device copy only after the payment preimage proves settlement. */
  async settlePayments(): Promise<void> {
    const payments =
      (await this.vault.meta<Payment[]>(this.name('payments'))) ?? []
    for (const payment of payments.filter(
      entry => entry.verify && !entry.proof
    )) {
      const result = await fetchInvoiceVerification(
        requireIssuerUrl(payment.verify!, payment.endpoint)
      )
      if (!sameInvoice(result.pr, payment.invoice))
        throw new Error('Verification refers to another invoice.')
      if (!result.settled) continue
      if (
        !result.preimage ||
        !verifyMeltPreimage(payment.invoice, result.preimage)
      )
        throw new Error('Invalid payment proof.')
      await deviceMarkSpent(this.requireClient(), payment.deviceId)
      payment.proof = result.preimage
      await this.vault.setMeta(this.name('payments'), payments)
    }
  }

  /** Fetch and fund a second mint using an exact-value device note. */
  async transfer(id: string, destination: string): Promise<void> {
    const {result} = await this.checked(id)
    const target =
      resolveMintInput(destination) ?? resolveLnurlInput(destination)
    if (!target || new URL(target).origin === new URL(result.url).origin)
      throw new Error('Choose a different destination mint.')
    await this.pay(id, await this.mint(target, result.amountMsat))
  }

  /** Export only after explicit handover and durably record that the device copy is spent. */
  async share(id: string): Promise<string> {
    const {result} = await this.checked(id)
    const k1 = await this.requireClient().exportSecret(id)
    if (result.deviceHash && hashK1(k1) !== result.deviceHash.toLowerCase())
      throw new Error('Device exported a different note.')
    const url = buildNoteUrl(result.url, k1, result.amountMsat)
    const noteId = crypto.randomUUID()
    await this.vault.save({
      id: noteId,
      url,
      amount: result.amountMsat,
      status: 'shared',
      reason: 'Device handover; excluded from balance.',
      updatedAt: Date.now()
    })
    await deviceMarkSpent(this.requireClient(), id)
    return url
  }
  /** Rename only through the device's physical approval flow. */
  async rename(id: string, label: string): Promise<void> {
    await this.requireClient().rename(id, label)
  }
  /** Reload retained device invoices after a reconnect. */
  async funding(): Promise<Funding[]> {
    this.requireClient()
    return (await this.vault.meta<Funding[]>(this.name('funding'))) ?? []
  }
  /** Close sessions when locking the wallet or leaving its device tool. */
  async disconnect(): Promise<void> {
    const client = this.client
    this.client = null
    this.identity = ''
    this.pendingIdentity = ''
    useMediatedDeviceQueue(null)
    await client?.disconnect()
  }
}
