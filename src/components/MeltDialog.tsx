import type {Component} from 'solid-js'
import {Show, For, createSignal, createMemo, onMount, onCleanup} from 'solid-js'
import {
  IoClipboardSharp,
  IoCloseSharp,
  IoReturnDownForwardSharp,
  IoRefreshSharp,
  IoTrashSharp
} from 'solid-icons/io'
import {MdSharpKeyboard} from 'solid-icons/md'

import type {Bearer} from '../storage'
import {useWallet} from '../WalletContext'
import {useDevice} from '../DeviceContext'
import type {PayRequestInfo, MeltResult, InternalTransferResult} from '../lnurlcash'
import {
  isBolt11Invoice,
  isLightningAddress,
  resolveMintInput,
  fetchPayRequest,
  requestInvoice,
  fetchInvoiceVerification,
  decodeBolt11AmountMsat,
  serverOf,
  requireNoteK1,
  withNewK1,
  meltNote,
  mergeNotes,
  splitNote,
  settleNote,
  probeBurnedNote,
  sameInvoice,
  NoteSpentError,
  AmbiguousMutationError,
  payInternalTransfer
} from '../lnurlcash'
import {
  deviceMerge,
  deviceSplit,
  deviceSettle,
  deviceMeltRequest,
  markDeviceNoteSpent,
  requireDeviceClient
} from '../deviceOrchestration'
import {
  notify,
  NotifyKind,
  msatToSats,
  satsToMsat,
  pasteFromClipboard
} from '../helpers'
import {offlineMode} from '../offlineMode'
import {getTrustedMintNodeColor} from '../trustedMints'
import {
  storeableMeltAddresses,
  addStoreableMeltAddress,
  removeStoreableMeltAddress
} from '../storeableLinks'
import ScanToggle from './ScanToggle'
import NfcToggle from './NfcToggle'
import Dialog from './Dialog'
import FiatValue from './FiatValue'

export type MeltDialogProps = {
  onClose: () => void
  // pre-fills a pasted bolt11 handed off from ReceiveDialog's own invoice
  // detection (see meltHandoff.ts) - Wallet.tsx picks that up on mount and
  // opens this dialog with it already set, skipping the paste step
  initialInvoice?: string
  // same idea, for a Lightning Address recognized by Wallet.tsx's own hero
  // paste widget - looked up on mount just like a manually pasted address
  initialAddress?: string
}

// same cadence as Mint.tsx's LUD-21 verify poll - a melt's own LUD-25 melt
// proof (see meltNote) is checked the same way that poll checks an
// incoming payment
const PENDING_POLL_SECONDS = 5

// pay an external Lightning invoice by burning a held bearer note - this
// wallet has no Lightning node of its own, so "paying" is always spending a
// note out. Manually handing a note over as-is (no invoice involved) lives
// on the note's own card instead (see BearerCard's Unveil).
const MeltDialog: Component<MeltDialogProps> = props => {
  const {addBearer, updateBearer, removeBearer, bearers, logActivity} =
    useWallet()
  const {client: deviceClient} = useDevice()
  let pasteRef: HTMLInputElement | null = null

  const [value, setValue] = createSignal('')
  // the paste field is hidden behind a keyboard icon on mobile (see
  // .paste-keyboard-btn) - desktop ignores this, CSS only hides the field
  // under the mobile breakpoint
  const [showKeyboard, setShowKeyboard] = createSignal(false)
  // this wallet has no Lightning node of its own, so paying an invoice here
  // means spending it out of a held bearer note - melt only ever takes a
  // single k1, so 2+ selected notes get merged into one first
  const [pastedInvoice, setPastedInvoice] = createSignal<string | null>(
    props.initialInvoice ?? null
  )
  const [selectedIds, setSelectedIds] = createSignal<Set<string>>(new Set())
  const [paying, setPaying] = createSignal(false)
  // which burn is awaiting its explicit confirm click, if any - a melt
  // locks the note as spent the moment the request lands (and burns it
  // server-side once the payment settles), so neither fires on a single
  // stray click. Same posture as TransferDialog's own confirm step
  const [confirming, setConfirming] = createSignal<'pay' | 'split' | null>(null)

  // a Lightning Address has no invoice of its own yet - resolving one just
  // gets its payRequest, then an amount is needed before an actual invoice
  // (and thus a pastedInvoice) exists
  const [lnAddressPayRequest, setLnAddressPayRequest] =
    createSignal<PayRequestInfo | null>(null)
  // the raw address itself, kept alongside its resolved payRequest above -
  // needed at invoice-request time to save it as storeable (LUD-11), and
  // otherwise not derivable back from lnAddressPayRequest alone
  const [lnAddressText, setLnAddressText] = createSignal('')
  const [lnAddressAmountSats, setLnAddressAmountSats] = createSignal('')
  const [fetchingInvoice, setFetchingInvoice] = createSignal(false)
  // LUD-25 Part 2's Internal transfer: burning a held note straight onto
  // the recipient's own registered branch, skipping Lightning entirely -
  // see payWithInternalTransfer below. A separate confirm/busy pair from
  // the ordinary melt flow's own (confirming/paying), since this never
  // touches pastedInvoice at all
  const [confirmingTransfer, setConfirmingTransfer] = createSignal(false)
  const [transferring, setTransferring] = createSignal(false)

  // set right after a melt is requested, alongside the LUD-25 melt proof
  // URL it returned - polled until that proof reports the payment settled
  const [pendingNote, setPendingNote] = createSignal<Bearer | null>(null)
  const [meltVerifyUrl, setMeltVerifyUrl] = createSignal<string | null>(null)
  const [secondsLeft, setSecondsLeft] = createSignal(PENDING_POLL_SECONDS)
  const [checkingPending, setCheckingPending] = createSignal(false)
  let pollTimer: ReturnType<typeof setInterval> | null = null

  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
  }

  // a melt's {"status":"OK"} only means the payment is in flight (see
  // meltNote) - its melt proof (LUD-25's `verify`, only present when the
  // service advertises one) is how its actual fate gets confirmed: once it
  // reports `settled`, the outgoing payment went through for good, so the
  // note (already locked as spent locally) really is gone. Unlike the old
  // rotate-and-see probe, a not-yet-settled result never distinguishes
  // "still in flight" from "failed" - a genuinely failed melt only shows up
  // here as a check that keeps not reporting settled, same as one that's
  // merely slow; the note can still be freed by hand (BearerCard's "Unspend
  // anyway") if it's ever confirmed to have actually failed some other way
  const checkPending = async () => {
    const note = pendingNote()
    const url = meltVerifyUrl()
    if (!note || !url || checkingPending()) return
    setCheckingPending(true)
    try {
      const result = await fetchInvoiceVerification(url)
      if (!result.settled) return // still in flight - next tick
      // a settled report is only this payment's proof when it's for the
      // invoice this melt actually paid - a mint that mixes up proofs (or
      // a migrated/compromised verify endpoint) must not confirm the wrong
      // payment
      const paid = pastedInvoice()
      if (paid && !sameInvoice(result.pr, paid)) {
        stopPolling()
        setPendingNote(null)
        setMeltVerifyUrl(null)
        notify(
          "The service's payment proof is for a different invoice than the one paid - the note stays locked as spent; check the payment's outcome before clearing or unspending it.",
          NotifyKind.ERROR
        )
        props.onClose()
        return
      }
      stopPolling()
      setPendingNote(null)
      setMeltVerifyUrl(null)
      // this is the settlement-confirmed moment, not optimistic - mirrors
      // exactly when the local spent-flag above already landed
      if (note.deviceId) {
        await markDeviceNoteSpent(deviceClient(), note.deviceId)
      }
      logActivity(
        'melt',
        `Melted ${msatToSats(note.amount)} sats from ${serverOf(note.url)} to pay an invoice. Verify: ${url}.`,
        note.label
      )
      notify('Payment confirmed - the note is gone.', NotifyKind.SUCCESS)
      props.onClose()
    } catch {
      // a single failed check isn't fatal - the next tick tries again
    } finally {
      setCheckingPending(false)
    }
  }

  const startPolling = (note: Bearer, verifyUrl: string) => {
    stopPolling()
    setPendingNote(note)
    setMeltVerifyUrl(verifyUrl)
    setSecondsLeft(PENDING_POLL_SECONDS)
    pollTimer = setInterval(() => {
      setSecondsLeft(s => {
        if (s <= 1) {
          checkPending()
          return PENDING_POLL_SECONDS
        }
        return s - 1
      })
    }, 1000)
  }

  // manual click: check right away, then restart the countdown so the next
  // automatic tick isn't immediately on its heels. checkPending's own guard
  // stops a second concurrent check, but on its own that still lets a rapid
  // double-click (or a click landing right as the automatic tick was about
  // to fire) restart the interval twice in a row - guard here too so the
  // whole "check + restart" action only happens once per click
  const manualCheckPending = () => {
    if (checkingPending()) return
    checkPending()
    const note = pendingNote()
    const url = meltVerifyUrl()
    if (note && url) startPolling(note, url)
  }

  onCleanup(stopPolling)

  const isValid = createMemo(
    () =>
      value() === '' || isBolt11Invoice(value()) || isLightningAddress(value())
  )

  // a Lightning Address just gets its payRequest here - getInvoiceFromAddress
  // below turns that into an actual invoice once an amount is chosen
  const lookupLnAddress = async (address: string) => {
    const url = resolveMintInput(address)
    if (!url) {
      notify('Not a valid Lightning Address.', NotifyKind.ERROR)
      return
    }
    setFetchingInvoice(true)
    setConfirmingTransfer(false)
    try {
      setLnAddressPayRequest(await fetchPayRequest(url))
      setLnAddressText(address)
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setFetchingInvoice(false)
    }
  }

  onMount(() => {
    if (props.initialAddress) lookupLnAddress(props.initialAddress)
  })

  const handleValue = (raw: string) => {
    const trimmed = raw.trim()
    if (isBolt11Invoice(trimmed)) {
      setPastedInvoice(trimmed)
      setValue('')
      return
    }
    if (isLightningAddress(trimmed)) {
      lookupLnAddress(trimmed)
      setValue('')
      return
    }
    notify('Not a valid bolt11 invoice or Lightning Address.', NotifyKind.ERROR)
  }

  const handle = () => {
    if (value() === '') return
    handleValue(value())
  }

  const paste = async () => {
    const text = await pasteFromClipboard()
    if (text !== null) {
      setValue(text)
      setShowKeyboard(true)
      pasteRef?.focus()
      handle()
    }
  }

  const onScan = (scanned: string) => handleValue(scanned)

  // click-to-select from the saved-addresses picker below
  const selectSavedAddress = (address: string) => handleValue(address)

  // validates lnAddressAmountSats() against the payRequest's bounds, then
  // turns it into an actual bolt11 - same shape as a directly pasted one
  const getInvoiceFromAddress = async () => {
    const info = lnAddressPayRequest()
    if (!info) return
    const msat = satsToMsat(lnAddressAmountSats())
    if (!lnAddressAmountSats() || !Number.isFinite(msat) || msat <= 0) {
      notify('Enter an amount in sats.', NotifyKind.ERROR)
      return
    }
    if (msat < info.minSendable || msat > info.maxSendable) {
      notify(
        `Amount must be between ${msatToSats(info.minSendable)} and ${msatToSats(info.maxSendable)} sats.`,
        NotifyKind.ERROR
      )
      return
    }
    setFetchingInvoice(true)
    try {
      const result = await requestInvoice(info.callback, msat)
      setPastedInvoice(result.pr)
      // LUD-11: this address says it's meant to be reused for future
      // melts (not this one invoice, which is spent once paid regardless)
      // - save it, kept apart from Mint.tsx's own storeable mints (see
      // storeableLinks.ts - a melt destination isn't necessarily a mint)
      if (!result.disposable) addStoreableMeltAddress(lnAddressText())
      setLnAddressPayRequest(null)
      setLnAddressAmountSats('')
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setFetchingInvoice(false)
    }
  }

  // Coin selection for an internal transfer: an exact match needs no split
  // at all, so it's strictly better than accumulating past the target and
  // minting leftover change - a single matching note is a free rotate
  // (Internal transfer, 25.md: "a plain rotate is free"), and even the
  // full-held-total case still avoids a split's change note and its fee.
  // Only checks those two exact cases (a single note, or everything
  // available) rather than searching every subset for one that happens to
  // sum exactly - a general subset-sum search is overkill for what's
  // normally a handful of notes per mint, and this still always finds a
  // usable selection via the plain accumulate-in-order walk when no exact
  // one exists.
  const pickInternalTransferBearers = (
    available: Bearer[],
    msat: number
  ): Bearer[] => {
    const exact = available.find(b => b.amount === msat)
    if (exact) return [exact]
    const total = available.reduce((sum, b) => sum + b.amount, 0)
    if (total === msat) return available
    const picked: Bearer[] = []
    let running = 0
    for (const bearer of available) {
      if (running >= msat) break
      picked.push(bearer)
      running += bearer.amount
    }
    return picked
  }

  // picks notes at the recipient's own mint (see pickInternalTransferBearers)
  // and burns them straight onto the recipient's next derived pubkey (see
  // lib's payInternalTransfer) - no invoice, no Lightning round trip, and
  // nothing to poll afterward (finishMelt exists for a melt's async
  // settlement; this isn't one)
  const payWithInternalTransfer = async () => {
    const info = lnAddressPayRequest()
    const hint = internalTransferHint()
    if (!info || !hint) return
    const msat = satsToMsat(lnAddressAmountSats())
    if (!lnAddressAmountSats() || !Number.isFinite(msat) || msat <= 0) {
      notify('Enter an amount in sats.', NotifyKind.ERROR)
      return
    }
    if (msat < info.minSendable || msat > info.maxSendable) {
      notify(
        `Amount must be between ${msatToSats(info.minSendable)} and ${msatToSats(info.maxSendable)} sats.`,
        NotifyKind.ERROR
      )
      return
    }
    const picked = pickInternalTransferBearers(internalTransferBearers(), msat)
    const total = picked.reduce((sum, b) => sum + b.amount, 0)
    if (total < msat || picked.length === 0) {
      notify(
        `Not enough notes at ${serverOf(info.callback)} to cover this with an internal transfer.`,
        NotifyKind.ERROR
      )
      return
    }
    setConfirmingTransfer(false)
    setTransferring(true)
    try {
      const base = picked[0]
      const k1s = picked.map(b => requireNoteK1(b.url))
      let changeK1: string | undefined
      let changeSignature: string | undefined
      try {
        const result: InternalTransferResult = await payInternalTransfer(
          base.callback,
          k1s,
          msat,
          total,
          hint
        )
        if (result.kind === 'split') {
          changeK1 = result.change
          changeSignature = result.changeSignature
        }
      } catch (err) {
        if (!(err instanceof AmbiguousMutationError)) throw err
        // the request may have landed despite the failure - probe one
        // input before deciding what (if anything) the carried change
        // secret is worth, same reconciliation mergeSelectionIfNeeded/
        // splitAndPay already do for their own mutations
        const outcome = await probeBurnedNote(base.url)
        if (outcome === 'live') throw err // nothing burned - a plain failure
        if (outcome === 'unknown') {
          if (err.newSecrets.length > 0) {
            await addBearer({
              url: withNewK1(base.url, err.newSecrets[0], total - msat),
              callback: base.callback,
              amount: total - msat,
              verified: false,
              mintPubkey: base.mintPubkey
            })
          }
          throw new Error(
            'The internal transfer may have gone through but could not be confirmed - ' +
              (err.newSecrets.length > 0
                ? 'the possible change is stored unverified alongside your originals. Refresh it to reconcile before trying again.'
                : 'the input notes are still shown as unspent. Refresh them before trying again.')
          )
        }
        // 'gone': the burn landed - any carried secret is the only money left
        if (err.newSecrets.length > 0) changeK1 = err.newSecrets[0]
      }
      // every input is burned server-side from here on - any change is the
      // only money left from this selection, so (when present) it's
      // stored BEFORE any removeBearer of an input
      if (changeK1) {
        const change = await addBearer({
          url: withNewK1(base.url, changeK1, total - msat, changeSignature),
          callback: base.callback,
          amount: total - msat,
          verified: false,
          mintPubkey: base.mintPubkey
        })
        for (const bearer of picked) removeBearer(bearer.id)
        try {
          const settledChange = await settleNote(
            base.url,
            changeK1,
            total - msat,
            changeSignature
          )
          await updateBearer(change.id, {
            url: withNewK1(
              base.url,
              settledChange.k1,
              settledChange.amountMsat,
              settledChange.signature
            ),
            callback: settledChange.callback,
            amount: settledChange.amountMsat,
            verified: true
          })
        } catch (err) {
          notify(
            `Sent, but settling the change note didn't complete (${(err as Error).message}) - it's tracked unverified; refresh it to repair.`,
            NotifyKind.ERROR
          )
        }
      } else {
        for (const bearer of picked) removeBearer(bearer.id)
      }
      logActivity(
        'melt',
        `Sent ${msatToSats(msat)} sats to ${lnAddressText() || serverOf(info.callback)} via an internal transfer at ${serverOf(info.callback)}.`
      )
      notify(
        `Sent ${msatToSats(msat)} sats via internal transfer.`,
        NotifyKind.SUCCESS
      )
      setLnAddressPayRequest(null)
      setLnAddressAmountSats('')
      props.onClose()
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setTransferring(false)
    }
  }

  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handle()
    }
  }

  const invoiceAmountMsat = createMemo(() => {
    const invoice = pastedInvoice()
    return invoice ? decodeBolt11AmountMsat(invoice) : null
  })

  const unspentBearers = createMemo(() => bearers().filter(b => !b.spent))

  // LUD-25 Part 2's Internal transfer: eligible only if the looked-up
  // address published a cx1 (Seed & derivation) AND this wallet holds a
  // verified, browser-held note at that SAME mint - device-backed notes
  // are excluded because the vault always generates its own output secret
  // (deviceOrchestration.ts's deviceMerge/deviceSplit), with no way yet to
  // name an external recipient's pubkey as that output instead.
  const internalTransferHint = createMemo(
    () => lnAddressPayRequest()?.internalTransfer ?? null
  )
  const internalTransferBearers = createMemo(() => {
    const info = lnAddressPayRequest()
    if (!info || !internalTransferHint()) return []
    const server = serverOf(info.callback)
    return unspentBearers().filter(
      b => !b.deviceId && b.callback !== '' && serverOf(b.url) === server
    )
  })
  const internalTransferAvailableMsat = createMemo(() =>
    internalTransferBearers().reduce((sum, b) => sum + b.amount, 0)
  )
  const selectedBearers = createMemo(() =>
    bearers().filter(b => selectedIds().has(b.id))
  )
  const selectedTotal = createMemo(() =>
    selectedBearers().reduce((sum, b) => sum + b.amount, 0)
  )
  // merging (and, if needed, splitting) burns notes and mints replacements,
  // so every selected note must come from the same service, already be
  // verified (callback known), and not be locally locked as spent
  const selectionValid = createMemo(() => {
    const picked = selectedBearers()
    if (picked.length === 0) return false
    const server = serverOf(picked[0].url)
    return picked.every(
      b => serverOf(b.url) === server && b.callback !== '' && !b.spent
    )
  })

  // melt demands an exact match - an invoice amount that fails to decode is
  // treated as unknown, not zero, so it's left for the service to judge
  // rather than blocking here
  const selectionPayable = createMemo(() => {
    if (!selectionValid()) return false
    const amount = invoiceAmountMsat()
    return amount === null || selectedTotal() === amount
  })

  // covers the invoice but isn't an exact note - Split and pay carves off
  // exact change (keeping the remainder as a fresh note) before melting
  const selectionNeedsSplit = createMemo(() => {
    if (!selectionValid()) return false
    const amount = invoiceAmountMsat()
    return amount !== null && selectedTotal() > amount
  })

  // the sentence the confirm step restates before anything irreversible
  // fires - what exactly gets burned, for how much, and where the change
  // goes on a split
  const confirmText = createMemo(() => {
    const action = confirming()
    if (!action) return ''
    const total = selectedTotal()
    const amount = invoiceAmountMsat()
    const count = selectedBearers().length
    const notes = `${count} note${count === 1 ? '' : 's'}`
    if (action === 'split' && amount !== null) {
      return `Split off ${msatToSats(amount)} sats - keeping the ${msatToSats(total - amount)} sats change as a fresh note - and melt it to pay this invoice?`
    }
    if (amount !== null) {
      return `Melt ${notes} worth ${msatToSats(total)} sats to pay this invoice?`
    }
    return `Melt ${notes} to pay this invoice? Its amount couldn't be read - the service checks the exact match.`
  })

  const toggleSelect = (id: string, isSelected: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (isSelected) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const clearInvoice = () => {
    stopPolling()
    setPendingNote(null)
    setMeltVerifyUrl(null)
    setPastedInvoice(null)
    setSelectedIds(new Set<string>())
    setConfirming(null)
  }

  // merges the selection into one note worth their sum - a no-op returning
  // the note itself when only one is selected, since merge only makes
  // sense for 2+. settleNote reads the actual value back (a mint MAY
  // refund part of its fees on merge - LUD-25) by hash, without exporting or
  // rotating the merged secret. Melt below demands an exact amount match, so the stored note must be
  // trustworthy, not the naive pre-fee sum. If a vault is connected, the
  // merged note lands there instead - regardless of whether any of the
  // inputs were themselves device-backed (mixed selections are fine, see
  // deviceOrchestration.ts)
  const mergeSelectionIfNeeded = async (
    picked: ReturnType<typeof selectedBearers>
  ) => {
    if (picked.length === 1) return picked[0]
    const base = picked[0]
    const total = picked.reduce((sum, b) => sum + b.amount, 0)
    const client = deviceClient()
    if (client) {
      const merged = await deviceMerge(
        client,
        picked.map(b => ({deviceId: b.deviceId, url: b.url})),
        base.callback,
        total
      )
      // the mint call inside deviceMerge already burned every input
      // server-side, so the merged output is the only money left - it must
      // end up tracked no matter what fails from here on. Settle first
      // (best-effort), then addBearer BEFORE any removeBearer of an input;
      // a failed settle still tracks a mirror of the raw output
      // (unverified, at its expected pre-fee amount), which the next device
      // refresh can repair
      let settled = merged
      let verified = false
      try {
        settled = await deviceSettle(client, merged)
        verified = true
      } catch (err) {
        notify(
          `Merged, but settling the new note didn't complete (${(err as Error).message}) - it's tracked unverified; refresh it with the vault connected to repair.`,
          NotifyKind.ERROR
        )
      }
      const added = await addBearer({
        url: settled.url,
        callback: settled.callback,
        amount: settled.amountMsat,
        verified,
        mintPubkey: base.mintPubkey,
        deviceId: settled.deviceId,
        deviceHash: settled.deviceHash
      })
      for (const bearer of picked) removeBearer(bearer.id)
      return added
    }
    const mergedK1s = picked.map(b => requireNoteK1(b.url))
    let mergedK1: string
    let mergedSignature: string | undefined
    try {
      const merged = await mergeNotes(base.callback, mergedK1s)
      mergedK1 = merged.k1
      mergedSignature = merged.signature
    } catch (err) {
      if (!(err instanceof AmbiguousMutationError)) throw err
      // the merge request may have landed despite the failure - probe one
      // input before deciding what the fresh secret it carried is worth
      const outcome = await probeBurnedNote(base.url)
      if (outcome === 'live') throw err // nothing burned - a plain failure
      if (outcome === 'unknown') {
        // can't tell: track the possible output without dropping the
        // inputs, and stop here rather than pay from a limbo state
        await addBearer({
          url: withNewK1(base.url, err.newSecrets[0], total),
          callback: base.callback,
          amount: total,
          verified: false,
          mintPubkey: base.mintPubkey
        })
        throw new Error(
          'The merge may have gone through but could not be confirmed - the possible combined note is stored unverified alongside your originals. Refresh them to reconcile before paying.'
        )
      }
      // 'gone': the burn landed - the carried secret is the only money left
      mergedK1 = err.newSecrets[0]
    }
    // the mint call above already burned every input server-side, so the
    // merged output is the only money left - it is stored BEFORE any
    // removeBearer of an input, then settled in place: a failed settle
    // leaves an unverified note a refresh can repair, not a lost secret
    const added = await addBearer({
      url: withNewK1(base.url, mergedK1, total, mergedSignature),
      callback: base.callback,
      amount: total,
      verified: false,
      mintPubkey: base.mintPubkey
    })
    for (const bearer of picked) removeBearer(bearer.id)
    let current: Bearer = added
    try {
      const settled = await settleNote(
        base.url,
        mergedK1,
        total,
        mergedSignature
      )
      const settledUrl = withNewK1(
        base.url,
        settled.k1,
        settled.amountMsat,
        settled.signature
      )
      await updateBearer(added.id, {
        url: settledUrl,
        callback: settled.callback,
        amount: settled.amountMsat,
        verified: true
      })
      current = {
        ...added,
        url: settledUrl,
        callback: settled.callback,
        amount: settled.amountMsat,
        verified: true
      }
    } catch (err) {
      notify(
        `Merged, but settling the new note didn't complete (${(err as Error).message}) - it's tracked unverified; refresh it to repair.`,
        NotifyKind.ERROR
      )
    }
    return current
  }

  // called right after meltNote locks a note as spent. If the service
  // returned a LUD-25 melt proof, checkPending polls it to confirm
  // settlement and closes once it does - same as BearerCard's melt, the
  // note stays in the wallet (locked) rather than being removed outright,
  // in case that confirmation never arrives. Without one there's nothing
  // to poll, so this treats the request as done right away: the note was
  // already locked as spent, and BearerCard's "Unspend anyway" remains the
  // way back if it later turns out the payment actually failed
  const finishMelt = async (note: Bearer, result: {verify?: string}) => {
    if (result.verify) {
      notify(
        'Payment requested and the note is locked as spent - confirming...',
        NotifyKind.LOADING
      )
      startPolling(note, result.verify)
      return
    }
    // no melt proof to poll, so the note locking as spent locally is all
    // the confirmation there is. The device copy is deliberately NOT
    // marked spent here: this wallet never learns whether the async payout
    // actually settled, the mint restores the note if it failed, and the
    // vault protocol has no unspend - a prematurely marked device note
    // would strand those sats on the device for good. The stale CONFIRMED
    // copy a successful melt leaves behind is the safe direction: a later
    // refresh with the vault connected reconciles it
    logActivity(
      'melt',
      `Melted ${msatToSats(note.amount)} sats from ${serverOf(note.url)} to pay an invoice.`,
      note.label
    )
    notify(
      "Payment requested and the note is locked as spent - this mint doesn't support checking automatically." +
        (note.deviceId
          ? ' The vault copy is kept until the outcome is known - refresh it with the vault connected to reconcile.'
          : ''),
      NotifyKind.SUCCESS
    )
    props.onClose()
  }

  // melts the selected note(s) as-is - only valid once they're already
  // worth exactly the invoice (merged into one first if there's more than
  // one). Per meltNote's own semantics a resolved call only means the
  // payment is in flight, not confirmed spent - see finishMelt for what
  // happens next
  const payInvoice = async () => {
    const invoice = pastedInvoice()
    const picked = selectedBearers()
    if (!invoice || !selectionPayable() || picked.length === 0) return
    setConfirming(null)
    setPaying(true)
    try {
      const current = await mergeSelectionIfNeeded(picked)
      let result: MeltResult
      try {
        result = current.deviceId
          ? await deviceMeltRequest(
              requireDeviceClient(deviceClient()),
              current.deviceId,
              current.callback,
              invoice
            )
          : await meltNote(
              current.callback,
              requireNoteK1(current.url),
              invoice
            )
      } catch (err) {
        // this melt names a single note (current), so a NoteSpentError here
        // is unambiguous - it's already gone, lock it the same way a
        // successful melt would have rather than leave it looking spendable
        if (err instanceof NoteSpentError) {
          await updateBearer(current.id, {spent: true})
          logActivity(
            'spent',
            `${serverOf(current.url)} reports ${msatToSats(current.amount)} sats as already spent - marked spent locally.`,
            current.label
          )
        }
        throw err
      }
      await updateBearer(current.id, {spent: true})
      setSelectedIds(new Set<string>())
      await finishMelt(current, result)
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setPaying(false)
    }
  }

  // for a selection worth more than the invoice: splits off the exact
  // amount owed directly from every selected note - keeping the remainder
  // as a fresh note - then melts that exact piece, all in one click. Split
  // takes one or many k1s per LUD-25 ("one or many | no | yes"), so this
  // burns the whole selection in a single callback request; no merge round
  // trip first, unlike an exact-amount pay (see payInvoice/meltNote, which
  // only ever takes a single k1 and still needs one)
  const splitAndPay = async () => {
    const invoice = pastedInvoice()
    const picked = selectedBearers()
    const target = invoiceAmountMsat()
    if (!invoice || !selectionNeedsSplit() || target === null) return
    if (picked.length === 0) return
    setConfirming(null)
    setPaying(true)
    try {
      const base = picked[0]
      const total = picked.reduce((sum, b) => sum + b.amount, 0)
      const client = deviceClient()
      if (client) {
        const parts = await deviceSplit(
          client,
          picked.map(b => ({deviceId: b.deviceId, url: b.url})),
          base.callback,
          target,
          total
        )
        // the mint call inside deviceSplit already burned every input
        // server-side - both outputs are the only money left, so both
        // addBearers happen BEFORE any removeBearer of an input, and a
        // failed settle of the change leg still tracks a mirror of the raw
        // output (unverified, at its expected pre-fee amount). The next
        // device refresh repairs the mirror
        let settledChange = parts.change
        let changeVerified = false
        try {
          settledChange = await deviceSettle(client, parts.change)
          changeVerified = true
        } catch (err) {
          notify(
            `Split succeeded, but settling the change note didn't complete (${(err as Error).message}) - it's tracked unverified; refresh it with the vault connected to repair.`,
            NotifyKind.ERROR
          )
        }
        await addBearer({
          url: settledChange.url,
          callback: settledChange.callback,
          amount: settledChange.amountMsat,
          verified: changeVerified,
          mintPubkey: base.mintPubkey,
          deviceId: settledChange.deviceId,
          deviceHash: settledChange.deviceHash
        })
        const spend = await addBearer({
          url: parts.target.url,
          callback: parts.target.callback,
          amount: target,
          verified: true,
          mintPubkey: base.mintPubkey,
          deviceId: parts.target.deviceId,
          deviceHash: parts.target.deviceHash
        })
        for (const bearer of picked) removeBearer(bearer.id)
        let result: MeltResult
        try {
          result = await deviceMeltRequest(
            client,
            parts.target.deviceId,
            spend.callback,
            invoice
          )
        } catch (err) {
          if (err instanceof NoteSpentError) {
            await updateBearer(spend.id, {spent: true})
            logActivity(
              'spent',
              `${serverOf(spend.url)} reports ${msatToSats(spend.amount)} sats as already spent - marked spent locally.`
            )
          }
          throw err
        }
        await updateBearer(spend.id, {spent: true})
        setSelectedIds(new Set<string>())
        await finishMelt(spend, result)
        return
      }
      let partK1: string
      let partSignature: string | undefined
      let changeK1: string
      let changeSignature: string | undefined
      let partVerified = false
      try {
        const parts = await splitNote(
          base.callback,
          picked.map(b => requireNoteK1(b.url)),
          target
        )
        partK1 = parts.k1
        partSignature = parts.signature
        changeK1 = parts.change
        changeSignature = parts.changeSignature
        partVerified = true
      } catch (err) {
        if (!(err instanceof AmbiguousMutationError)) throw err
        // the split request may have landed despite the failure - probe
        // one input before deciding what the carried secrets are worth
        const outcome = await probeBurnedNote(base.url)
        if (outcome === 'live') throw err // nothing burned - a plain failure
        if (outcome === 'unknown') {
          // can't tell: track both possible outputs without dropping the
          // inputs, and stop here rather than pay from a limbo state
          await addBearer({
            url: withNewK1(base.url, err.newSecrets[0], target),
            callback: base.callback,
            amount: target,
            verified: false,
            mintPubkey: base.mintPubkey
          })
          await addBearer({
            url: withNewK1(base.url, err.newSecrets[1], total - target),
            callback: base.callback,
            amount: total - target,
            verified: false,
            mintPubkey: base.mintPubkey
          })
          throw new Error(
            'The split may have gone through but could not be confirmed - the possible outputs are stored unverified alongside your originals. Refresh them to reconcile before paying.'
          )
        }
        // 'gone': the burn landed - the carried secrets are the only money
        partK1 = err.newSecrets[0]
        changeK1 = err.newSecrets[1]
      }
      // the inputs are burned server-side from here on, so both outputs
      // are stored BEFORE any removeBearer of an input; the change is then
      // settled in place (a failed settle leaves an unverified note a
      // refresh can repair, not a lost secret)
      const spend = await addBearer({
        url: withNewK1(base.url, partK1, target, partSignature),
        callback: base.callback,
        amount: target,
        verified: partVerified,
        mintPubkey: base.mintPubkey
      })
      const change = await addBearer({
        url: withNewK1(base.url, changeK1, total - target, changeSignature),
        callback: base.callback,
        amount: total - target,
        verified: false,
        mintPubkey: base.mintPubkey
      })
      for (const bearer of picked) removeBearer(bearer.id)
      // settleNote: the change may be worth less than total - target if
      // this mint charges fees (LUD-25 deducts them from change, never the
      // melted amount) - updated to its true value, not the naive pre-fee
      // one, or its signature won't verify against it
      try {
        const settledChange = await settleNote(
          base.url,
          changeK1,
          total - target,
          changeSignature
        )
        await updateBearer(change.id, {
          url: withNewK1(
            base.url,
            settledChange.k1,
            settledChange.amountMsat,
            settledChange.signature
          ),
          callback: settledChange.callback,
          amount: settledChange.amountMsat,
          verified: true
        })
      } catch (err) {
        notify(
          `Split succeeded, but settling the change note didn't complete (${(err as Error).message}) - it's tracked unverified; refresh it to repair.`,
          NotifyKind.ERROR
        )
      }
      let result: MeltResult
      try {
        result = await meltNote(
          spend.callback,
          requireNoteK1(spend.url),
          invoice
        )
      } catch (err) {
        if (err instanceof NoteSpentError) {
          await updateBearer(spend.id, {spent: true})
          logActivity(
            'spent',
            `${serverOf(spend.url)} reports ${msatToSats(spend.amount)} sats as already spent - marked spent locally.`
          )
        }
        throw err
      }
      await updateBearer(spend.id, {spent: true})
      setSelectedIds(new Set<string>())
      await finishMelt(spend, result)
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setPaying(false)
    }
  }

  return (
    <Dialog onClose={props.onClose}>
      <figure class="paste-widget">
        <figcaption>Melt - pay an invoice with a bearer note</figcaption>
        <div class="paste-input-row">
          <ScanToggle
            onScan={onScan}
            accept={v => isBolt11Invoice(v) || isLightningAddress(v)}
          />
          <NfcToggle
            onScan={onScan}
            accept={v => isBolt11Invoice(v) || isLightningAddress(v)}
          />
          <button
            type="button"
            class="icon-btn paste-icon-btn"
            title="Paste from clipboard"
            onClick={paste}
          >
            <IoClipboardSharp />
          </button>
          <button
            type="button"
            class="icon-btn paste-keyboard-btn"
            title="Type instead"
            onClick={() => setShowKeyboard(v => !v)}
          >
            <MdSharpKeyboard />
          </button>
          <div
            class="paste-input-wrapper"
            classList={{'mobile-open': showKeyboard()}}
          >
            <input
              ref={pasteRef}
              type="text"
              class="paste-input"
              classList={{invalid: value() !== '' && !isValid()}}
              placeholder="lnbc1... or user@example.com"
              value={value()}
              onInput={e => setValue(e.currentTarget.value)}
              onKeyDown={onKeydown}
            />
            <Show when={value() !== ''}>
              <button
                type="button"
                class="icon-btn paste-clear-btn"
                title="Clear"
                onClick={() => setValue('')}
              >
                <IoCloseSharp />
              </button>
            </Show>
          </div>
          <button
            type="button"
            class="icon-btn paste-confirm-btn"
            title={offlineMode() ? 'Offline mode is on' : 'Continue'}
            disabled={
              value() === '' || !isValid() || fetchingInvoice() || offlineMode()
            }
            onClick={handle}
          >
            <Show
              when={fetchingInvoice()}
              fallback={<IoReturnDownForwardSharp />}
            >
              <IoRefreshSharp class="spin" />
            </Show>
          </button>
        </div>
        <Show when={value() !== '' && !isValid()}>
          <p class="warning">
            Not a valid bolt11 invoice or Lightning Address.
          </p>
        </Show>
        <Show when={lnAddressPayRequest()}>
          {info => (
            <div class="form-item">
              <label>
                Amount (sats, {msatToSats(info().minSendable)} -{' '}
                {msatToSats(info().maxSendable)})
              </label>
              <input
                type="number"
                min="1"
                placeholder="amount in sats"
                value={lnAddressAmountSats()}
                onInput={e => setLnAddressAmountSats(e.currentTarget.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    if (!fetchingInvoice() && !offlineMode())
                      getInvoiceFromAddress()
                  }
                }}
              />
              <Show
                when={internalTransferHint() && internalTransferAvailableMsat() > 0}
              >
                <p class="bearer-hint">
                  You hold {msatToSats(internalTransferAvailableMsat())} sats
                  at {serverOf(info().callback)} - paying this address can
                  skip Lightning entirely (LUD-25 internal transfer).
                </p>
              </Show>
              <Show
                when={confirmingTransfer()}
                fallback={
                  <div class="btns">
                    <button
                      disabled={fetchingInvoice() || offlineMode()}
                      onClick={getInvoiceFromAddress}
                    >
                      <Show when={fetchingInvoice()}>
                        <IoRefreshSharp class="spin" />
                        &nbsp;
                      </Show>
                      Get invoice
                    </button>
                    <Show
                      when={
                        internalTransferHint() &&
                        internalTransferAvailableMsat() > 0
                      }
                    >
                      <button
                        disabled={
                          transferring() ||
                          offlineMode() ||
                          !lnAddressAmountSats()
                        }
                        onClick={() => setConfirmingTransfer(true)}
                      >
                        Pay via internal transfer
                      </button>
                    </Show>
                    <button
                      onClick={() => {
                        setLnAddressPayRequest(null)
                        setConfirmingTransfer(false)
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                }
              >
                <p class="warning">
                  Send {lnAddressAmountSats()} sats to{' '}
                  {lnAddressText() || 'this address'} directly at{' '}
                  {serverOf(info().callback)} - no Lightning payment
                  involved. This can't be undone.
                </p>
                <div class="btns">
                  <button
                    disabled={transferring() || offlineMode()}
                    onClick={payWithInternalTransfer}
                  >
                    <Show when={transferring()}>
                      <IoRefreshSharp class="spin" />
                      &nbsp;
                    </Show>
                    Yes, send it
                  </button>
                  <button
                    disabled={transferring()}
                    onClick={() => setConfirmingTransfer(false)}
                  >
                    Cancel
                  </button>
                </div>
              </Show>
            </div>
          )}
        </Show>
      </figure>
      <Show when={storeableMeltAddresses().length > 0}>
        <h4>Your saved addresses</h4>
        <p>
          These said their own address is meant to be reused, not a one-time
          link (LUD-11) - saved here for a one-click return trip. Melt
          destinations only, kept separate from the mints on the Mint page.
        </p>
        <div class="mint-picker">
          <For each={storeableMeltAddresses()}>
            {link => (
              <span class="mint-picker-entry">
                <button
                  disabled={offlineMode()}
                  onClick={() => selectSavedAddress(link.address)}
                >
                  {link.address}
                </button>
                <button
                  class="icon-btn"
                  title="Forget this address"
                  onClick={() => removeStoreableMeltAddress(link.address)}
                >
                  <IoTrashSharp />
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>
      <Show when={pastedInvoice()}>
        <Show
          when={!pendingNote()}
          fallback={
            <>
              <h4>Confirming payment</h4>
              <p class="bearer-hint">
                Checking the mint's own melt proof (LUD-25) for this payment -
                once it reports the outgoing payment settled, the note is
                confirmed gone for good.
              </p>
              <div class="btns">
                <button
                  disabled={checkingPending() || offlineMode()}
                  onClick={manualCheckPending}
                >
                  <Show when={checkingPending()}>
                    <IoRefreshSharp class="spin" />
                    &nbsp;
                  </Show>
                  {checkingPending()
                    ? 'Checking...'
                    : `Check payment (${secondsLeft()}s)`}
                </button>
              </div>
            </>
          }
        >
          <h4>Pay with your bearer notes</h4>
          <Show
            when={invoiceAmountMsat() !== null}
            fallback={
              <p class="bearer-hint">
                Couldn't read an amount from this invoice - select note(s) from
                one mint and the service will judge whether they cover it.
              </p>
            }
          >
            <p class="bearer-hint">
              Wants {msatToSats(invoiceAmountMsat()!)} sats
              <FiatValue msat={invoiceAmountMsat()!} /> - select note(s) from
              one mint worth at least that. Melt only spends a note of exactly
              the invoice amount, so an exact match pays directly and anything
              over it needs Split and pay first.
            </p>
          </Show>
          <Show
            when={unspentBearers().length > 0}
            fallback={<p>No bearer notes to pay with yet.</p>}
          >
            <div class="bearer-list">
              <For each={unspentBearers()}>
                {bearer => {
                  // not grouped by mint here (unlike the wallet page) -
                  // each card already names its own mint below the
                  // amount, so the tint (see BearerCard's own noteColor)
                  // is looked up per-note instead of once per group
                  const noteColor = () =>
                    getTrustedMintNodeColor(serverOf(bearer.url))
                  return (
                    <figure
                      class="bearer-card"
                      classList={{tinted: !!noteColor()}}
                      style={
                        noteColor() ? {'--note-tint': noteColor()!} : undefined
                      }
                    >
                      <div class="bearer-head">
                        <label class="bearer-select">
                          <input
                            type="checkbox"
                            checked={selectedIds().has(bearer.id)}
                            disabled={!bearer.callback}
                            onChange={e =>
                              toggleSelect(bearer.id, e.currentTarget.checked)
                            }
                          />
                        </label>
                        <div
                          class="bearer-title clickable"
                          onClick={() =>
                            bearer.callback &&
                            toggleSelect(
                              bearer.id,
                              !selectedIds().has(bearer.id)
                            )
                          }
                        >
                          <span class="bearer-amount">
                            {msatToSats(bearer.amount)} sats
                          </span>
                          <Show when={!bearer.callback}>
                            <span class="bearer-pending">unverified</span>
                          </Show>
                          <span class="bearer-server">
                            {serverOf(bearer.url)}
                          </span>
                        </div>
                      </div>
                    </figure>
                  )
                }}
              </For>
            </div>
          </Show>
          <Show when={selectedBearers().length > 0}>
            <p class="bearer-hint">
              Selected {msatToSats(selectedTotal())} sats
              <Show when={!selectionPayable() && !selectionNeedsSplit()}>
                {' '}
                - not enough selected yet, or spans more than one mint
              </Show>
            </p>
          </Show>
          <Show
            when={confirming()}
            fallback={
              <div class="btns">
                <Show
                  when={selectionNeedsSplit()}
                  fallback={
                    <button
                      disabled={
                        paying() || !selectionPayable() || offlineMode()
                      }
                      onClick={() => setConfirming('pay')}
                    >
                      Pay invoice
                    </button>
                  }
                >
                  <button
                    disabled={paying() || offlineMode()}
                    onClick={() => setConfirming('split')}
                  >
                    Split and pay
                  </button>
                </Show>
                <button onClick={clearInvoice}>Clear</button>
              </div>
            }
          >
            {/* the burn restated in plain terms before it fires - a melt
              locks the note the moment the request lands, so this is the
              last chance to catch a misclick or a wrong invoice. The invoice
              itself is shown verbatim: "this invoice" needs an on-screen
              identity, or a swapped-in QR/paste for the same amount would
              be undetectable here */}
            <p class="warning">{confirmText()} This can't be undone.</p>
            <p class="mint-pubkey">{pastedInvoice()}</p>
            <div class="btns">
              <button
                disabled={paying() || offlineMode()}
                onClick={() =>
                  confirming() === 'split' ? splitAndPay() : payInvoice()
                }
              >
                <Show when={paying()}>
                  <IoRefreshSharp class="spin" />
                  &nbsp;
                </Show>
                Yes, pay it
              </button>
              <button disabled={paying()} onClick={() => setConfirming(null)}>
                Cancel
              </button>
            </div>
          </Show>
        </Show>
      </Show>
    </Dialog>
  )
}
export default MeltDialog
