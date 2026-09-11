import type {Component} from 'solid-js'
import {Show, For, createSignal, createMemo, onCleanup} from 'solid-js'
import {useNavigate} from '@solidjs/router'
import {IoRefreshSharp} from 'solid-icons/io'

import type {Bearer} from '../storage'
import {useWallet} from '../WalletContext'
import {useDevice} from '../DeviceContext'
import type {PayRequestInfo} from '../lnurlcash'
import {
  resolveMintInput,
  fetchPayRequest,
  fetchInvoiceVerification,
  buildNoteUrl,
  withNewK1,
  fetchNoteInfo,
  rotateNote,
  meltNote,
  requireNoteK1,
  serverOf,
  serviceOriginOf,
  noteEndpointOf,
  isPreimage,
  isCk1,
  applyMintFee,
  describeMintFee,
  probeBurnedNote,
  sameInvoice,
  requestMintInvoice,
  requireMintComment,
  PendingNoteError,
  AmbiguousMutationError
} from '../lnurlcash'
import {
  deviceMeltRequest,
  deviceMint,
  markDeviceNoteSpent,
  requireDeviceClient
} from '../deviceOrchestration'
import {
  notify,
  NotifyKind,
  msatToSats,
  floorMsatToSat,
  copyToClipboard
} from '../helpers'
import {isMintTrusted, addTrustedMint, trustedMints} from '../trustedMints'
import {offlineMode} from '../offlineMode'
import Qr from './Qr'
import Dialog from './Dialog'
import FiatValue from './FiatValue'

export type TransferDialogProps = {
  sourceBearer: Bearer
  onClose: () => void
}

// same cadence as Mint.tsx's LUD-21 verify poll and MeltDialog.tsx's pending-melt
// poll - this is really both of those chained together
const TRANSFER_POLL_SECONDS = 5

// moves a note's value to a different mint - there's no such primitive in
// the protocol itself, only melt (burn + pay an invoice) and minting (pay a
// payRequest bound to a fresh wallet-chosen k1). So a "transfer" here is:
// request an invoice from the destination for exactly this note's value,
// melt the source note to pay it (this wallet IS the payer, funded by the
// note instead of an external wallet), then claim the destination note once
// its invoice settles - via the destination's own LUD-21 verify if it has
// one, same as Mint.tsx's own payment flow, since we're in exactly the
// position that convenience is meant for (the legitimate payer checking on
// its own payment, not a third party snooping the verify endpoint)
const TransferDialog: Component<TransferDialogProps> = props => {
  const {addBearer, updateBearer, logActivity} = useWallet()
  const {client: deviceClient} = useDevice()
  const navigate = useNavigate()

  const [mintInput, setMintInput] = createSignal('')
  const [payRequest, setPayRequest] = createSignal<PayRequestInfo | null>(null)
  const [pendingTrust, setPendingTrust] = createSignal<{
    server: string
    mintPubkey: string
    info: PayRequestInfo
  } | null>(null)
  const [busy, setBusy] = createSignal(false)

  const [invoice, setInvoice] = createSignal<string | null>(null)
  const [verifyUrl, setVerifyUrl] = createSignal<string | null>(null)
  // The wallet-chosen destination k1. It is null before an invoice exists;
  // current transfer creation refuses an unnamed destination quote.
  const [mintSecret, setMintSecret] = createSignal<string | null>(null)
  const [claimed, setClaimed] = createSignal(false)
  const [sourceConfirmed, setSourceConfirmed] = createSignal(false)

  const [secondsLeft, setSecondsLeft] = createSignal(TRANSFER_POLL_SECONDS)
  const [checking, setChecking] = createSignal(false)
  let pollTimer: ReturnType<typeof setInterval> | null = null

  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
  }

  const sourceK1 = () => requireNoteK1(props.sourceBearer.url)

  const lookup = async () => {
    const url = resolveMintInput(mintInput())
    if (!url) {
      notify('Enter a mint LNURL or Lightning Address.', NotifyKind.ERROR)
      return
    }
    setPendingTrust(null)
    setBusy(true)
    try {
      const info = await fetchPayRequest(url)
      if (!info.withdrawLink) {
        notify(
          'This payRequest does not advertise lnurlcash minting (no withdrawLink).',
          NotifyKind.ERROR
        )
        return
      }
      const server = serverOf(info.withdrawLink)
      const origin = serviceOriginOf(info.withdrawLink)
      if (origin === serviceOriginOf(props.sourceBearer.url)) {
        notify("That's the mint this note is already on.", NotifyKind.ERROR)
        return
      }
      if (
        props.sourceBearer.amount < info.minSendable ||
        props.sourceBearer.amount > info.maxSendable
      ) {
        notify(
          `${server} only accepts ${msatToSats(info.minSendable)}-${msatToSats(info.maxSendable)} sats - this note is ${msatToSats(props.sourceBearer.amount)}.`,
          NotifyKind.ERROR
        )
        return
      }
      if (
        serviceOriginOf(url) === origin &&
        info.mintPubkey &&
        !isMintTrusted(origin)
      ) {
        setPendingTrust({server: origin, mintPubkey: info.mintPubkey, info})
        return
      }
      setPayRequest(info)
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  const selectMint = (address: string) => {
    setMintInput(address)
    lookup()
  }

  const confirmTrust = () => {
    const pending = pendingTrust()
    if (!pending) return
    addTrustedMint(pending.server, pending.mintPubkey)
    setPendingTrust(null)
    setPayRequest(pending.info)
  }

  const cancelTrust = () => {
    setPendingTrust(null)
    notify('Mint not trusted - lookup cancelled.', NotifyKind.ERROR)
  }

  // `payRequest() && !pendingTrust()` would return the boolean from the
  // `&&`, not the PayRequestInfo - this narrows properly so the Show below
  // can hand its children the actual object
  const readyPayRequest = createMemo(() =>
    !pendingTrust() ? payRequest() : null
  )

  // meltNote pays `pr` of exactly the note's value, so unlike Mint.tsx
  // there's no invoice amount to gross up here - the destination is always
  // invoiced for the full source amount. What its mint fee (if any) does
  // instead is shrink the note that comes out the other end, which this
  // estimates so the payer isn't surprised (the authoritative value is
  // whatever the destination's informational GET reports once claimed).
  // Floored to a whole sat, same as every other fee-adjusted estimate (see
  // helpers.ts's floorMsatToSat) - a mint fee's percentage cut can leave
  // sub-sat precision, and rounding that up here would display a note
  // value bigger than what actually comes out the other end
  const expectedNet = createMemo(() => {
    const info = payRequest()
    return info?.mintFee
      ? floorMsatToSat(applyMintFee(props.sourceBearer.amount, info.mintFee))
      : props.sourceBearer.amount
  })

  // fires the transfer: get an invoice for exactly the note's value, then
  // melt the note to pay it - the source is locked as spent immediately,
  // same as any other melt, and confirmed (or restored) by polling below
  const startTransfer = async () => {
    const info = payRequest()
    if (!info?.withdrawLink) return
    setBusy(true)
    try {
      // Refuse before requesting the destination invoice or spending the
      // source note unless the output can be bound to our own secret.
      requireMintComment(info)
      const {result, secret} = await requestMintInvoice(
        info.callback,
        props.sourceBearer.amount,
        serverOf(info.withdrawLink || info.callback)
      )
      setMintSecret(secret)
      if (props.sourceBearer.deviceId) {
        await deviceMeltRequest(
          requireDeviceClient(deviceClient()),
          props.sourceBearer.deviceId,
          props.sourceBearer.callback,
          result.pr
        )
      } else {
        await meltNote(props.sourceBearer.callback, sourceK1(), result.pr)
      }
      await updateBearer(props.sourceBearer.id, {spent: true})
      setInvoice(result.pr)
      if (result.verify) setVerifyUrl(result.verify)
      notify(
        'Melting the note to fund the transfer - confirming...',
        NotifyKind.LOADING
      )
      startPolling()
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  // Claims the destination note with the wallet-generated secret from
  // startTransfer. Same claim sequence as Mint.tsx:
  // verify (also settling the k1), rotate to close the exposure that GET
  // just created, then store it. If a vault is connected, that fresh secret
  // is generated and held there instead of in this browser (deviceMint -
  // import then rotate).
  const claimDestination = async (noteSecret: string) => {
    const info = payRequest()
    if (!info?.withdrawLink) return
    if (!isPreimage(noteSecret) && !isCk1(noteSecret)) return
    try {
      const declaredUrl = buildNoteUrl(
        info.withdrawLink,
        noteSecret,
        props.sourceBearer.amount
      )
      const noteInfo = await fetchNoteInfo(declaredUrl)

      // LUD-25 Part 2: same reasoning as Mint.tsx's claim() - this note's
      // bearer secret already proves key ownership (no rotate-for-a-
      // certificate needed, and rotating would silently downgrade it back
      // to a legacy secret), and the hardware vault has not been migrated
      // to pubkey-based notes yet, so this always stays browser-only.
      if (isCk1(noteSecret)) {
        const url = buildNoteUrl(
          info.withdrawLink,
          noteSecret,
          noteInfo.maxWithdrawable
        )
        await addBearer({
          url,
          callback: noteInfo.callback,
          amount: noteInfo.maxWithdrawable,
          verified: true,
          mintPubkey: noteInfo.mintPubkey
        })
        setClaimed(true)
        stopPolling()
        if (props.sourceBearer.deviceId) {
          await markDeviceNoteSpent(deviceClient(), props.sourceBearer.deviceId)
        }
        logActivity(
          'transfer',
          `Transferred ${msatToSats(noteInfo.maxWithdrawable)} sats from ${serverOf(props.sourceBearer.url)} to ${serverOf(url)}.`,
          props.sourceBearer.label
        )
        notify(
          `Transferred ${msatToSats(noteInfo.maxWithdrawable)} sats to ${serverOf(url)}.`,
          NotifyKind.SUCCESS
        )
        navigate('/wallet')
        props.onClose()
        return
      }

      const client = deviceClient()
      if (client) {
        const result = await deviceMint(
          client,
          info.withdrawLink,
          noteInfo.callback,
          noteEndpointOf(info.withdrawLink),
          noteSecret,
          noteInfo.maxWithdrawable
        )
        await addBearer({
          url: result.url,
          callback: result.callback,
          amount: result.amountMsat,
          verified: true,
          mintPubkey: noteInfo.mintPubkey,
          deviceId: result.deviceId,
          deviceHash: result.deviceHash
        })
        setClaimed(true)
        stopPolling()
        // the source note's melt is what paid for this claim - retire its
        // device copy at the same moment (queued for the next connect if
        // the vault isn't attached right now)
        if (props.sourceBearer.deviceId) {
          await markDeviceNoteSpent(deviceClient(), props.sourceBearer.deviceId)
        }
        logActivity(
          'transfer',
          `Transferred ${msatToSats(result.amountMsat)} sats from ${serverOf(props.sourceBearer.url)} to ${serverOf(result.url)}.`,
          props.sourceBearer.label
        )
        notify(
          `Transferred ${msatToSats(result.amountMsat)} sats to ${serverOf(result.url)}.`,
          NotifyKind.SUCCESS
        )
        navigate('/wallet')
        props.onClose()
        return
      }

      const mintPubkey = noteInfo.mintPubkey
      let url = withNewK1(declaredUrl, noteInfo.k1, noteInfo.maxWithdrawable)
      let rotationError: string | null = null
      try {
        const rotated = await rotateNote(noteInfo.callback, noteInfo.k1)
        url = withNewK1(
          declaredUrl,
          rotated.k1,
          noteInfo.maxWithdrawable,
          rotated.signature
        )
      } catch (err) {
        if (err instanceof AmbiguousMutationError) {
          // the rotate request may have landed despite the failure - the
          // fresh secret it carried is then the only copy of this note
          const outcome = await probeBurnedNote(url)
          if (outcome === 'gone') {
            // the burn landed - adopt the fresh secret as the note
            url = withNewK1(
              declaredUrl,
              err.newSecrets[0],
              noteInfo.maxWithdrawable
            )
          } else if (outcome === 'unknown') {
            // can't tell: the original note is stored below either way -
            // track the possible rotated copy alongside it
            await addBearer({
              url: withNewK1(
                declaredUrl,
                err.newSecrets[0],
                noteInfo.maxWithdrawable
              ),
              callback: noteInfo.callback,
              amount: noteInfo.maxWithdrawable,
              verified: false,
              mintPubkey
            })
            rotationError = `${(err as Error).message} The rotation may still have gone through - the possible rotated copy is stored unverified alongside this one; refresh both to reconcile.`
          } else {
            rotationError = (err as Error).message
          }
        } else {
          rotationError = (err as Error).message
        }
      }
      await addBearer({
        url,
        callback: noteInfo.callback,
        amount: noteInfo.maxWithdrawable,
        verified: true,
        mintPubkey
      })
      setClaimed(true)
      stopPolling()
      // the source note's melt is what paid for this claim - retire its
      // device copy at the same moment (queued for the next connect if the
      // vault isn't attached right now)
      if (props.sourceBearer.deviceId) {
        await markDeviceNoteSpent(deviceClient(), props.sourceBearer.deviceId)
      }
      logActivity(
        'transfer',
        `Transferred ${msatToSats(noteInfo.maxWithdrawable)} sats from ${serverOf(props.sourceBearer.url)} to ${serverOf(url)}.`,
        props.sourceBearer.label
      )
      // one toast, not two - the note landed either way, so a failed
      // rotate is folded into the same message rather than shown
      // separately from the transfer it's actually part of
      if (rotationError) {
        notify(
          `Transferred ${msatToSats(noteInfo.maxWithdrawable)} sats to ${serverOf(url)}, but could not rotate (${rotationError}) - the note secret was just transmitted, treat this note as exposed.`,
          NotifyKind.ERROR
        )
      } else {
        notify(
          `Transferred ${msatToSats(noteInfo.maxWithdrawable)} sats to ${serverOf(url)}.`,
          NotifyKind.SUCCESS
        )
      }
      navigate('/wallet')
      props.onClose()
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    }
  }

  // once claimed, or once there's neither a destination verify endpoint to
  // poll NOR an unconfirmed source left to rotate-probe, a tick of
  // checkTransfer has nothing left it can do - the destination side is
  // either resolved or waiting for a manual claim with the wallet-held
  // secret, and the source side already got its answer.
  // Without this, the button/timer kept "checking" forever with literally
  // no HTTP request going out - looked alive (spinner flips on and off)
  // while silently doing nothing, which is exactly the bug this guards
  const canCheckTransfer = createMemo(
    () => !claimed() && (verifyUrl() !== null || !sourceConfirmed())
  )

  // one tick checks both sides: whether the destination invoice settled
  // (then claiming the bound note) and - independently - whether
  // the source note actually burned. Rotating it succeeding means it was
  // still there (the transfer failed, restore it); any other failure means
  // it's gone, which just leaves the destination claim (auto or manual) as
  // the remaining step
  const checkTransfer = async () => {
    if (checking()) return
    if (!canCheckTransfer()) {
      stopPolling()
      return
    }
    setChecking(true)
    try {
      if (!claimed()) {
        const url = verifyUrl()
        if (url) {
          try {
            const result = await fetchInvoiceVerification(url)
            // a settled report only proves THIS transfer's funding if it's
            // for the invoice this wallet actually requested
            const requested = invoice()
            if (
              result.settled &&
              requested &&
              !sameInvoice(result.pr, requested)
            ) {
              stopPolling()
              notify(
                "The destination mint's verify response is for a different invoice than requested - this transfer's state is uncertain; check both notes before retrying.",
                NotifyKind.ERROR
              )
              return
            }
            if (result.settled) {
              // The note's real k1 is the wallet-held secret, not whatever
              // settlement preimage the destination discloses here.
              const secret = mintSecret()
              if (secret) {
                await claimDestination(secret)
              }
            }
          } catch {
            // a single failed check isn't fatal - the next tick tries again
          }
        }
      }
      // no equivalent probe exists for a device-backed source: the
      // browser-only rotate above is free (k1 already in hand) and tests
      // the MINT's own state directly - a failed rotate means the mint no
      // longer considers the note spendable, i.e. the melt went through.
      // Doing the same against a device-backed note would demand a
      // physical button press every 5-second tick just to check, which
      // isn't worth the cost - list_notes only reflects this wallet's own
      // prior commands, not the mint's truth, so it can't substitute. The
      // destination's own settlement check (above) is what actually
      // confirms success for a device-backed transfer; if the melt failed,
      // "Unspend anyway" on the source note's card remains the manual way
      // back, same as any other melt failure.
      if (!claimed() && !sourceConfirmed() && !props.sourceBearer.deviceId) {
        try {
          const rotated = await rotateNote(
            props.sourceBearer.callback,
            sourceK1()
          )
          stopPolling()
          await updateBearer(props.sourceBearer.id, {
            url: withNewK1(
              props.sourceBearer.url,
              rotated.k1,
              props.sourceBearer.amount,
              rotated.signature
            ),
            spent: false
          })
          notify(
            'Transfer failed - the note is still yours (freshly rotated). You can try again.',
            NotifyKind.ERROR
          )
          props.onClose()
          return
        } catch (err) {
          if (err instanceof AmbiguousMutationError) {
            // the rotate may have landed despite the failure - the carried
            // secret is then the only copy of the still-unmelted source.
            // Track it unverified and stop probing the source: retrying
            // would gamble (and have to store) another fresh secret every
            // tick, and between this copy and the unchanged source record
            // the sats are accounted for either way - a refresh reconciles
            // which one is real once the service is reachable again
            await addBearer({
              url: withNewK1(
                props.sourceBearer.url,
                err.newSecrets[0],
                props.sourceBearer.amount
              ),
              callback: props.sourceBearer.callback,
              amount: props.sourceBearer.amount,
              verified: false,
              mintPubkey: props.sourceBearer.mintPubkey
            })
            setSourceConfirmed(true)
            notify(
              "The source note's state is uncertain - a possible rotated copy is stored unverified; refresh your notes to reconcile.",
              NotifyKind.ERROR
            )
          } else if (!(err instanceof PendingNoteError)) {
            setSourceConfirmed(true)
          }
        }
      }
    } finally {
      setChecking(false)
    }
  }

  const startPolling = () => {
    stopPolling()
    setSecondsLeft(TRANSFER_POLL_SECONDS)
    pollTimer = setInterval(() => {
      setSecondsLeft(s => {
        if (s <= 1) {
          checkTransfer()
          return TRANSFER_POLL_SECONDS
        }
        return s - 1
      })
    }, 1000)
  }

  const manualCheck = () => {
    if (checking()) return
    checkTransfer()
    startPolling()
  }

  onCleanup(stopPolling)

  return (
    <Dialog onClose={props.onClose}>
      <>
        <h4>
          Transfer {msatToSats(props.sourceBearer.amount)} sats
          <FiatValue msat={props.sourceBearer.amount} /> to another mint
        </h4>
        <Show when={!invoice()}>
          <label>Destination mint (LNURL or Lightning Address)</label>
          <input
            type="text"
            placeholder="lnurl1... or mint@example.com"
            value={mintInput()}
            onInput={e => setMintInput(e.currentTarget.value)}
            onKeyDown={e => e.key === 'Enter' && lookup()}
          />
          <div class="btns">
            <button disabled={busy() || offlineMode()} onClick={lookup}>
              <Show when={busy()}>
                <IoRefreshSharp class="spin" />
                &nbsp;
              </Show>
              Look up mint
            </button>
            <button onClick={props.onClose}>Cancel</button>
          </div>
          <Show when={trustedMints().length > 0}>
            <div class="mint-picker">
              <For each={trustedMints()}>
                {mint => (
                  <button
                    disabled={busy() || offlineMode()}
                    onClick={() => selectMint(`mint@${serverOf(mint.server)}`)}
                  >
                    {serverOf(mint.server)}
                  </button>
                )}
              </For>
            </div>
          </Show>
          <Show when={pendingTrust()}>
            {pending => (
              <>
                <p>
                  First time seeing a signing key from{' '}
                  <strong>{pending().server}</strong>. Trusting it lets its
                  notes show as offline-verified against this key.
                </p>
                <pre>{pending().mintPubkey}</pre>
                <div class="btns">
                  <button onClick={confirmTrust}>Trust this mint</button>
                  <button onClick={cancelTrust}>Cancel</button>
                </div>
              </>
            )}
          </Show>
          <Show when={readyPayRequest()}>
            {info => (
              <>
                <Show when={info().mintFee}>
                  {fee => (
                    <p class="warning">
                      {serverOf(info().callback)} withholds a fee on minting:{' '}
                      {describeMintFee(fee())}. The note you end up holding
                      there will be worth less than the one you're melting.
                    </p>
                  )}
                </Show>
                <p class="bearer-hint">
                  Transfer exactly {msatToSats(props.sourceBearer.amount)} sats
                  to {serverOf(info().callback)}? The source note is melted to
                  fund it - this can't be undone.
                  <Show when={info().mintFee}>
                    {' '}
                    You'll end up with ~{msatToSats(expectedNet())} sats there.
                  </Show>
                </p>
                <div class="btns">
                  <button
                    disabled={busy() || offlineMode()}
                    onClick={startTransfer}
                  >
                    <Show when={busy()}>
                      <IoRefreshSharp class="spin" />
                      &nbsp;
                    </Show>
                    Confirm transfer
                  </button>
                </div>
              </>
            )}
          </Show>
        </Show>
        <Show when={invoice()}>
          <p class="bearer-hint">
            Melting the source note to fund this invoice at the destination mint
            - it's locked as spent until this confirms.
          </p>
          <Qr value={invoice()!.toUpperCase()} />
          <div class="btns">
            <button onClick={() => copyToClipboard(invoice()!)}>
              Copy invoice
            </button>
            <Show when={canCheckTransfer()}>
              <button
                disabled={checking() || offlineMode()}
                onClick={manualCheck}
              >
                <Show when={checking()}>
                  <IoRefreshSharp class="spin" />
                  &nbsp;
                </Show>
                {checking()
                  ? 'Checking...'
                  : `Check transfer (${secondsLeft()}s)`}
              </button>
            </Show>
          </div>
          {/* unlike Mint.tsx, this wallet pays the invoice itself
          (meltNote above) rather than a human paying an external one - so
          there's no "I know I've paid" moment for a holder to act on early.
          This manual claim button must stay gated behind !verifyUrl(): with
          verify available, the automatic poll (checkTransfer) is the only
          thing that should ever trigger a claim, since it's the only thing
          that actually confirms the destination settled - offering an
          always-on button here would invite claiming (and rotating)
          against a melt that's still only "in flight", not confirmed. */}
          <Show when={!verifyUrl()}>
            <Show when={mintSecret()}>
              {secret => (
                <>
                  <label>
                    This mint doesn't support checking automatically. This
                    destination is bound to this wallet's secret - nothing to
                    paste. Claim it below once the transfer has settled.
                  </label>
                  <div class="btns">
                    <button
                      disabled={checking() || offlineMode()}
                      onClick={() => claimDestination(secret())}
                    >
                      Claim at destination
                    </button>
                  </div>
                </>
              )}
            </Show>
          </Show>
        </Show>
      </>
    </Dialog>
  )
}
export default TransferDialog
