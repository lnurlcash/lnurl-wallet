import {
  resolveNoteInput,
  noteK1,
  noteDeclaredAmount,
  noteEndpointOf,
  withNewK1,
  fetchNoteInfo,
  hashK1,
  rotateNoteWithHash,
  splitNoteWithHash,
  mergeNotesWithHash,
  meltNote,
  decodeBolt11AmountMsat,
  isBolt11Invoice,
  resolveMintInput,
  resolveLnurlInput,
  fetchPayRequest,
  requireMintComment,
  requestInvoice,
  buildNoteUrl,
  NoteSpentError,
  NoteUnknownError,
  serverOf,
  fetchInvoiceVerification,
  sameInvoice,
  verifyMeltPreimage,
  toBech32Lnurl,
  toLud17w,
  isPreimage
} from '../lnurlcash'
import {Vault} from './vault'
import type {Note, CashState} from './vault'
import {cashRootFromHex} from '../keys'
import {cashSecretFromRoot} from '../cashSecrets'
import {observeMint} from './mints'
import {claimLinkToNoteInput, claimParamsFromHref} from '../claimLink'

export type HistoryEntry = {
  id: string
  time: number
  action: string
  message: string
}

/** Restrict bearer disclosure to the HTTPS issuer selected by the user. */
export const requireIssuerUrl = (url: string, issuer: string): string => {
  const target = new URL(url)
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    target.origin !== new URL(issuer).origin
  ) {
    throw new Error('The mint returned an address outside its HTTPS origin.')
  }
  return target.toString()
}

const newNote = (url: string, amount: number, reason: string): Note => ({
  id: crypto.randomUUID(),
  url,
  amount,
  reason,
  status: 'pending',
  updatedAt: Date.now()
})

/** LNURLcash operations with encrypted recovery records written before mutations. */
export class Wallet {
  constructor(readonly vault: Vault) {}

  /** Append a local encrypted activity entry; no bearer secrets are recorded. */
  async log(action: string, message: string): Promise<void> {
    const entries = (await this.vault.meta<HistoryEntry[]>('history')) ?? []
    await this.vault.setMeta('history', [
      ...entries,
      {id: crypto.randomUUID(), time: Date.now(), action, message}
    ])
  }

  /** Keep the incoming note, then rotate after the user's receive confirmation. */
  async receive(input: string): Promise<void> {
    const clean = input.trim().replace(/^lightning:/i, '')
    const claim = claimParamsFromHref(clean)
    const url =
      (claim && claimLinkToNoteInput(claim)) || resolveNoteInput(clean)
    if (!url) throw new Error('Not an LNURLcash note.')
    requireIssuerUrl(url, url)
    if (
      (await this.vault.notes()).some(
        n =>
          noteK1(n.url) === noteK1(url) &&
          noteEndpointOf(n.url) === noteEndpointOf(url)
      )
    ) {
      throw new Error('This note is already in the wallet.')
    }
    const note = {
      ...newNote(
        url,
        noteDeclaredAmount(url) ?? 0,
        'Received; not yet rotated.'
      ),
      status: 'unverified' as const
    }
    await this.vault.save(note)
    await this.transform([note.id], 'rotate')
    await this.log('receive', 'Received a note and rotated its secret.')
  }

  /** Reconcile a stored candidate without repeating any mutation. */
  async refresh(id: string): Promise<void> {
    const note = await this.find(id)
    if (note.invoiceType === 'payment' && note.status === 'pending')
      throw new Error(
        'Verify this payment first. If it failed, explicitly mark the note unspent before checking it.'
      )
    try {
      const info = await fetchNoteInfo(note.url)
      requireIssuerUrl(info.callback, note.url)
      await observeMint(this.vault, note.url, info.mintPubkey)
      await this.vault.save({
        ...note,
        amount: info.maxWithdrawable,
        status: note.status === 'shared' ? 'shared' : 'ready',
        reason:
          'Confirmed outstanding by issuer. Rotate if another holder has a copy.',
        updatedAt: Date.now()
      })
    } catch (error) {
      if (
        error instanceof NoteSpentError ||
        error instanceof NoteUnknownError
      ) {
        if (error instanceof NoteUnknownError && note.status === 'pending')
          return
        await this.vault.save({
          ...note,
          status: 'spent',
          reason:
            'Not outstanding. This alone does not prove a payment settled.',
          updatedAt: Date.now()
        })
      } else throw error
    }
  }

  /** Rotate, split or combine; all candidate secrets survive an interrupted request. */
  async transform(
    ids: string[],
    action: 'rotate' | 'split' | 'combine',
    amount?: number
  ): Promise<string[]> {
    if (
      !ids.length ||
      new Set(ids).size !== ids.length ||
      ids.length > 100 ||
      (action === 'rotate' && ids.length !== 1) ||
      (action === 'combine' && ids.length < 2)
    ) {
      throw new Error('Select the notes for this operation.')
    }
    const notes = await Promise.all(ids.map(id => this.find(id)))
    if (notes.some(n => ['spent', 'shared', 'pending'].includes(n.status))) {
      throw new Error(
        'Check unresolved notes before using them; shared notes cannot be spent here.'
      )
    }
    const infos = await Promise.all(notes.map(n => fetchNoteInfo(n.url)))
    const callback = requireIssuerUrl(infos[0].callback, notes[0].url)
    await observeMint(this.vault, notes[0].url, infos[0].mintPubkey)
    if (
      notes.some(
        (n, i) =>
          noteEndpointOf(n.url) !== noteEndpointOf(notes[0].url) ||
          requireIssuerUrl(infos[i].callback, n.url) !== callback
      )
    ) {
      throw new Error('Select notes from the same mint endpoint.')
    }
    const total = infos.reduce((sum, info) => sum + info.maxWithdrawable, 0)
    if (!Number.isSafeInteger(total) || total <= 0)
      throw new Error('Invalid mint amount.')
    if (
      action === 'split' &&
      (!Number.isSafeInteger(amount) || amount! <= 0 || amount! >= total)
    ) {
      throw new Error(
        'The split amount must be positive and smaller than the selected balance.'
      )
    }
    const outputs: Note[] = []
    for (const value of action === 'split'
      ? [amount!, total - amount!]
      : [total])
      outputs.push({
        ...newNote(
          withNewK1(
            notes[0].url,
            await this.vault.nextSecret(serverOf(notes[0].url)),
            value
          ),
          value,
          `${action}: recovery candidate; check online.`
        ),
        designId: notes[0].designId,
        label: notes[0].label
      })
    for (const output of outputs) await this.vault.save(output)
    for (const note of notes)
      await this.vault.save({
        ...note,
        status: 'pending',
        reason: `${action}: request may be in flight; check online.`,
        updatedAt: Date.now()
      })
    const k1s = notes.map(n => noteK1(n.url)!)
    const hashes = outputs.map(n => hashK1(noteK1(n.url)!))
    let signatures: string[]
    if (action === 'split') {
      const result = await splitNoteWithHash(
        callback,
        k1s,
        amount!,
        hashes[0],
        hashes[1]
      )
      signatures = [result.signature, result.changeSignature]
    } else {
      const result =
        action === 'rotate'
          ? await rotateNoteWithHash(callback, k1s[0], hashes[0])
          : await mergeNotesWithHash(callback, k1s, hashes[0])
      signatures = [result.signature]
    }
    // Keep every source even after confirmation. A failure at any write can be
    // reconciled by hash lookup; no output secret depends on a success response.
    for (const note of notes)
      await this.vault.save({
        ...note,
        status: 'spent',
        reason: `${action} accepted by issuer.`,
        updatedAt: Date.now()
      })
    for (const [index, output] of outputs.entries()) {
      await this.vault.save({
        ...output,
        url: withNewK1(
          output.url,
          noteK1(output.url)!,
          output.amount,
          signatures[index]
        )
      })
      await this.refresh(output.id)
    }
    await this.log(
      action,
      `${action}: ${total / 1000} sats at ${serverOf(notes[0].url)}.`
    )
    return outputs.map(note => note.id)
  }

  /** Request an exact amount from a Lightning address before the holder reviews payment. */
  async paymentInvoice(address: string, amount: number): Promise<string> {
    const url = resolveMintInput(address) ?? resolveLnurlInput(address)
    if (!url) throw new Error('Enter a Lightning address or LNURL-pay URL.')
    requireIssuerUrl(url, url)
    const info = await fetchPayRequest(url)
    if (
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      amount < info.minSendable ||
      amount > info.maxSendable
    )
      throw new Error(
        `Amount must be ${info.minSendable / 1000}–${info.maxSendable / 1000} sats.`
      )
    const quote = await requestInvoice(
      requireIssuerUrl(info.callback, url),
      amount
    )
    if (
      !isBolt11Invoice(quote.pr) ||
      decodeBolt11AmountMsat(quote.pr) !== amount
    )
      throw new Error('The requested invoice has a different amount.')
    if (!quote.disposable) {
      const saved = (await this.vault.meta<string[]>('payment-addresses')) ?? []
      await this.vault.setMeta('payment-addresses', [
        ...new Set([...saved, address])
      ])
    }
    return quote.pr
  }

  /** Split or combine selected notes into an exact payment note while preserving change. */
  async preparePayment(ids: string[], invoice: string): Promise<string> {
    const amount = decodeBolt11AmountMsat(invoice)
    if (!isBolt11Invoice(invoice) || !amount)
      throw new Error('Enter a fixed-amount invoice first.')
    const notes = await Promise.all(ids.map(id => this.find(id)))
    if (!notes.length || notes.some(note => note.status !== 'ready'))
      throw new Error('Select confirmed notes.')
    const total = notes.reduce((sum, note) => sum + note.amount, 0)
    if (total < amount)
      throw new Error('Selected notes do not cover the invoice.')
    if (ids.length === 1 && total === amount) return ids[0]
    const outputs = await this.transform(
      ids,
      total > amount ? 'split' : 'combine',
      amount
    )
    const exact = (await this.vault.notes()).find(
      note =>
        outputs.includes(note.id) &&
        note.amount === amount &&
        note.status === 'ready'
    )
    if (!exact)
      throw new Error(
        'Mint fees changed the output amount. Review the new notes before paying.'
      )
    return exact.id
  }

  /** Submit a fixed-amount invoice; an accepted request is not settlement proof. */
  async pay(id: string, input: string): Promise<void> {
    const invoice = input.trim().replace(/^lightning:/i, '')
    const amount = decodeBolt11AmountMsat(invoice)
    if (!isBolt11Invoice(invoice) || !amount)
      throw new Error('Use a fixed-amount BOLT11 invoice.')
    const note = await this.find(id)
    if (note.status !== 'ready')
      throw new Error('Select a confirmed, unshared note.')
    const info = await fetchNoteInfo(note.url)
    const callback = requireIssuerUrl(info.callback, note.url)
    if (info.maxWithdrawable !== amount)
      throw new Error(
        'Invoice and note amounts must match. Split or combine first.'
      )
    await this.vault.save({
      ...note,
      status: 'pending',
      invoice,
      invoiceType: 'payment',
      reason:
        'Payment requested. Check status; never infer settlement from dispatch.',
      updatedAt: Date.now()
    })
    const result = await meltNote(callback, noteK1(note.url)!, invoice)
    if (result.verify) {
      if (!result.pr || !sameInvoice(result.pr, invoice))
        throw new Error('The payment proof refers to a different invoice.')
      const current = await this.find(id)
      await this.vault.save({
        ...current,
        verifyUrl: requireIssuerUrl(result.verify, note.url)
      })
    }
    await this.log('payment', `Requested a payment of ${amount / 1000} sats.`)
  }

  /** Reserve the mint output before asking for its funding invoice. */
  async mint(input: string, amount: number): Promise<string> {
    const url = resolveMintInput(input) ?? resolveLnurlInput(input)
    if (!url) throw new Error('Enter a mint URL or Lightning address.')
    requireIssuerUrl(url, url)
    const info = await fetchPayRequest(url)
    requireMintComment(info)
    if (!info.withdrawLink)
      throw new Error('This service does not mint LNURLcash notes.')
    if (
      !Number.isSafeInteger(amount) ||
      amount < info.minSendable ||
      amount > info.maxSendable
    ) {
      throw new Error(
        `Mint amount must be between ${info.minSendable / 1000} and ${info.maxSendable / 1000} sats.`
      )
    }
    const endpoint = requireIssuerUrl(
      info.withdrawLink.replace(/^lnurlw:/i, 'https:'),
      url
    )
    const callback = requireIssuerUrl(info.callback, url)
    if (info.mintPubkey) await observeMint(this.vault, url, info.mintPubkey)
    const k1 = await this.vault.nextSecret(serverOf(url))
    const note = newNote(
      buildNoteUrl(endpoint, k1, amount),
      amount,
      'Awaiting external invoice payment; check after paying.'
    )
    await this.vault.save(note)
    const quote = await requestInvoice(callback, amount, hashK1(k1))
    if (
      !isBolt11Invoice(quote.pr) ||
      decodeBolt11AmountMsat(quote.pr) !== amount
    )
      throw new Error(
        'The mint returned a funding invoice for a different amount.'
      )
    await this.vault.save({
      ...note,
      invoice: quote.pr,
      invoiceType: 'funding',
      verifyUrl: quote.verify ? requireIssuerUrl(quote.verify, url) : undefined
    })
    const saved = (await this.vault.meta<string[]>('mint-addresses')) ?? []
    if (!quote.disposable && !saved.includes(input))
      await this.vault.setMeta('mint-addresses', [...saved, input])
    await this.log(
      'mint',
      `Prepared a funding invoice for ${amount / 1000} sats.`
    )
    return quote.pr
  }

  /** Move value to another mint by paying its persisted output's exact funding invoice. */
  async transfer(id: string, destination: string): Promise<void> {
    const source = await this.find(id)
    if (source.status !== 'ready') throw new Error('Select a confirmed note.')
    const target =
      resolveMintInput(destination) ?? resolveLnurlInput(destination)
    if (!target || new URL(target).origin === new URL(source.url).origin)
      throw new Error('Choose a different destination mint.')
    const invoice = await this.mint(target, source.amount)
    await this.pay(id, invoice)
    await this.log(
      'transfer',
      'Transfer requested; both source and destination remain recoverable while pending.'
    )
  }

  /** Verify an invoice's own preimage before marking a payment settled. */
  async settlement(id: string): Promise<boolean> {
    const note = await this.find(id)
    if (!note.verifyUrl || !note.invoice) return false
    const result = await fetchInvoiceVerification(
      requireIssuerUrl(note.verifyUrl, note.url)
    )
    if (!sameInvoice(result.pr, note.invoice))
      throw new Error('Verification refers to another invoice.')
    if (!result.settled) return false
    if (!result.preimage || !verifyMeltPreimage(note.invoice, result.preimage))
      throw new Error('Settlement has no valid payment preimage.')
    if (note.invoiceType === 'payment') {
      await this.vault.save({
        ...note,
        status: 'spent',
        proof: result.preimage,
        reason: 'Payment settlement verified against its BOLT11 payment hash.',
        updatedAt: Date.now()
      })
    } else {
      await this.refresh(id)
      const refreshed = await this.find(id)
      if (refreshed.status !== 'ready') return false
      await this.vault.save({...refreshed, proof: result.preimage})
    }
    await this.log(
      'settlement',
      'Verified a payment preimage against its invoice.'
    )
    return true
  }

  /** Recover seed-derived notes sequentially, stopping on uncertainty rather than treating it as a gap. */
  async recover(
    input: string,
    progress: (index: number) => void,
    signal: AbortSignal,
    start = 0,
    importedRoot = -1
  ): Promise<number> {
    const cash =
      importedRoot < 0
        ? await this.vault.meta<CashState>('cash')
        : (await this.vault.meta<CashState[]>('cash-imports'))?.[importedRoot]
    if (!cash) throw new Error('No seed-derived cash key is available.')
    if (!Number.isSafeInteger(start) || start < 0 || start > 1000000)
      throw new Error('Invalid start index.')
    const payUrl = resolveMintInput(input) ?? resolveLnurlInput(input)
    if (!payUrl) throw new Error('Invalid mint address.')
    requireIssuerUrl(payUrl, payUrl)
    const info = await fetchPayRequest(payUrl)
    if (!info.withdrawLink)
      throw new Error('This mint has no withdraw endpoint.')
    const endpoint = requireIssuerUrl(
      info.withdrawLink.replace(/^lnurlw:/i, 'https:'),
      payUrl
    )
    const domain = serverOf(payUrl),
      root = cashRootFromHex(cash.root)
    const known = new Set(
      (await this.vault.notes()).map(
        n => `${noteEndpointOf(n.url)}:${noteK1(n.url)}`
      )
    )
    let gap = 0,
      added = 0,
      index = start
    for (; gap < 20 && index < start + 10000; index++) {
      signal.throwIfAborted()
      progress(index)
      const k1 = cashSecretFromRoot(root, domain, index)
      const url = buildNoteUrl(endpoint, k1)
      try {
        const found = await fetchNoteInfo(url)
        requireIssuerUrl(found.callback, endpoint)
        await observeMint(this.vault, url, found.mintPubkey)
        gap = 0
        const identity = `${noteEndpointOf(url)}:${k1}`
        if (!known.has(identity)) {
          await this.vault.save({
            ...newNote(
              withNewK1(url, k1, found.maxWithdrawable),
              found.maxWithdrawable,
              `Recovered cash index ${index}; rotate before handover.`
            ),
            status: 'ready'
          })
          known.add(identity)
          added++
        }
      } catch (error) {
        if (error instanceof NoteSpentError) gap = 0
        else if (error instanceof NoteUnknownError) gap++
        else throw error
      }
    }
    if (gap < 20)
      throw new Error(`Scan limit reached. Resume from index ${index}.`)
    if (importedRoot < 0) {
      const current = await this.vault.meta<CashState>('cash')
      await this.vault.setMeta('cash', {
        ...current!,
        indices: {
          ...current!.indices,
          [domain]: Math.max(current!.indices[domain] ?? 0, index)
        },
        scanned: [...new Set([...current!.scanned, domain])]
      })
    }
    await this.log('recovery', `Recovered ${added} notes at ${domain}.`)
    return added
  }

  /** Recover a legacy preimage-based note only when the holder explicitly supplies it. */
  async recoverPreimage(endpoint: string, preimage: string): Promise<void> {
    if (!isPreimage(preimage))
      throw new Error('A preimage must be 32 bytes of hexadecimal.')
    await this.receive(
      buildNoteUrl(requireIssuerUrl(endpoint, endpoint), preimage.trim())
    )
  }

  /** Keep local labels and history without changing note value. */
  async annotate(id: string, label: string): Promise<void> {
    if (label.length > 200) throw new Error('Label exceeds 200 characters.')
    await this.vault.save({
      ...(await this.find(id)),
      label,
      updatedAt: Date.now()
    })
  }

  /** Hide old records without deleting recovery data, or explicitly unlock a handed-over copy for checking. */
  async mark(id: string, action: 'spent' | 'unspent' | 'hide'): Promise<void> {
    const note = await this.find(id)
    if (action === 'hide' && !['spent', 'shared'].includes(note.status))
      throw new Error('Only inactive notes can be hidden.')
    await this.vault.save({
      ...note,
      status:
        action === 'unspent'
          ? 'unverified'
          : action === 'spent'
            ? 'shared'
            : note.status,
      hidden: action === 'hide',
      reason: `Locally marked ${action}; issuer status is separate.`,
      updatedAt: Date.now()
    })
    await this.log(action, `A note was marked ${action}.`)
  }

  /** Record handover before displaying the bearer secret. */
  async share(
    id: string,
    format: 'url' | 'lnurl' | 'lnurlw' | 'claim' = 'url'
  ): Promise<string> {
    const note = await this.find(id)
    if (note.status !== 'ready')
      throw new Error('Only a confirmed note can be shared.')
    await this.vault.save({
      ...note,
      status: 'shared',
      reason: 'Handed over; excluded from spendable balance.',
      updatedAt: Date.now()
    })
    await this.log('handover', `Handed over ${note.amount / 1000} sats.`)
    if (format === 'lnurl') return toBech32Lnurl(note.url)
    if (format === 'lnurlw') return toLud17w(note.url)
    if (format === 'claim') {
      const params = new URLSearchParams({
        u: noteEndpointOf(note.url),
        k1: noteK1(note.url)!,
        a: String(note.amount)
      })
      return `https://wallet.lnurlcash.com/#/claim?${params}`
    }
    return note.url
  }

  private async find(id: string): Promise<Note> {
    const note = (await this.vault.notes()).find(n => n.id === id)
    if (!note) throw new Error('Note not found.')
    return note
  }
}
