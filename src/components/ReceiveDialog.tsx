import type {Component} from 'solid-js'
import {Show, createMemo, createSignal} from 'solid-js'
import {useNavigate} from '@solidjs/router'
import {
  IoClipboardSharp,
  IoCloseSharp,
  IoReturnDownForwardSharp,
  IoRefreshSharp
} from 'solid-icons/io'
import {MdSharpKeyboard} from 'solid-icons/md'

import {useWallet} from '../WalletContext'
import {useDevice} from '../DeviceContext'
import {isValidNoteInput, isBolt11Invoice} from '../lnurlcash'
import {receiveIntoWallet as doReceiveIntoWallet} from '../receive'
import {handoffMeltInvoice} from '../meltHandoff'
import {notify, NotifyKind, pasteFromClipboard} from '../helpers'
import {offlineMode} from '../offlineMode'
import ScanToggle from './ScanToggle'
import NfcToggle from './NfcToggle'
import Dialog from './Dialog'

export type ReceiveDialogProps = {
  onClose: () => void
  // prefilled when the dialog was reached by opening a vault's handoff link
  // (pages/Claim.tsx). Deliberately prefilled and not auto-accepted: the
  // person should see what they are taking, and from which mint, first.
  initialValue?: string
  // present only when this dialog is rendered from the Wallet page itself -
  // opens MeltDialog directly in place, skipping the meltHandoff.ts/navigate
  // round trip below (which would be a same-route no-op there: SolidJS
  // Router doesn't remount on a navigate to the page already showing, so
  // nothing would ever pick the handoff back up). Claim.tsx has no such
  // dialog to open, so it always falls back to the handoff instead.
  onMelt?: (pr: string) => void
}

// bringing a note into this wallet, scanned or pasted - same destination
// either way, so one dialog covers both instead of picking an input method
// up front
const ReceiveDialog: Component<ReceiveDialogProps> = props => {
  const {addBearer, updateBearer, bearers, logActivity} = useWallet()
  const {client: deviceClient} = useDevice()
  const navigate = useNavigate()
  let pasteRef: HTMLInputElement | null = null
  // writable derived: seeded from (and reset by) props.initialValue, but
  // freely editable in between
  const [value, setValue] = createSignal(() => props.initialValue ?? '')
  const [busy, setBusy] = createSignal(false)
  // the paste field is hidden behind a keyboard icon on mobile (see
  // .paste-keyboard-btn) - desktop ignores this, CSS only hides the field
  // under the mobile breakpoint. Starts open when a value arrived prefilled
  // (a vault handoff link, see props.initialValue) so there's something to
  // actually look at
  const [showKeyboard, setShowKeyboard] = createSignal(!!props.initialValue)

  const isValid = createMemo(
    () =>
      value() === '' || isValidNoteInput(value()) || isBolt11Invoice(value())
  )

  // shared by both the scanner and the paste field once they've settled on
  // a valid bearer note. Re-entrancy-guarded: Enter-key and confirm-click
  // landing together (or a scanner double-fire) must not run two receives
  // for the same k1 - both would pass receiveNote's duplicate check before
  // either addBearer landed, leaving a dead duplicate behind. The actual
  // orchestration lives in receive.ts, shared with Wallet.tsx's hero widget.
  const receiveIntoWallet = async (noteValue: string) => {
    if (busy()) return
    setBusy(true)
    try {
      await doReceiveIntoWallet(noteValue, {
        bearers: bearers(),
        addBearer,
        updateBearer,
        logActivity,
        deviceClient: deviceClient()
      })
      setValue('')
      props.onClose()
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  // this wallet has no Lightning node of its own - paying an invoice is its
  // own dialog on the Wallet page (MeltDialog). Reached from the wallet
  // page itself, props.onMelt opens it directly. Reached from Claim.tsx
  // instead, there's no such dialog to open here - the invoice travels via
  // an in-memory handoff (meltHandoff.ts) rather than a URL param (with the
  // hash router a ?pr= would land in location.hash, hence in browser
  // history and bookmarks), and Wallet.tsx picks it back up once actually
  // mounted there
  const goToMelt = (pr: string) => {
    props.onClose()
    if (props.onMelt) {
      props.onMelt(pr)
      return
    }
    handoffMeltInvoice(pr)
    navigate('/wallet')
  }

  // scanning stays bearer-notes-only (a camera pointed at someone else's
  // invoice to pay is an unlikely scenario anyway) - pasting is the one
  // that also takes a bolt11, since that's realistically typed/pasted in
  const onScan = (scanned: string) => receiveIntoWallet(scanned)

  // takes the text explicitly when it was only just set - paste() writes
  // value and submits in the same tick, before that write is readable
  const submit = async (input: string) => {
    if (input === '') return
    if (isBolt11Invoice(input)) {
      goToMelt(input)
      setValue('')
      return
    }
    if (!isValidNoteInput(input)) {
      notify(
        'Not a valid LNURLcash bearer note or bolt11 invoice.',
        NotifyKind.ERROR
      )
      return
    }
    await receiveIntoWallet(input)
  }
  const handlePaste = () => submit(value())

  const paste = async () => {
    const text = await pasteFromClipboard()
    if (text !== null) {
      setValue(text)
      setShowKeyboard(true)
      pasteRef?.focus()
      void submit(text)
    }
  }

  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handlePaste()
    }
  }

  return (
    <Dialog onClose={props.onClose}>
      <>
        <h4>Bring in a bearer note</h4>
        <div class="paste-input-row">
          <ScanToggle onScan={onScan} accept={isValidNoteInput} />
          <NfcToggle onScan={onScan} accept={isValidNoteInput} />
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
          <div class={['paste-input-wrapper', {'mobile-open': showKeyboard()}]}>
            <input
              ref={pasteRef}
              type="text"
              class={['paste-input', {invalid: value() !== '' && !isValid()}]}

              placeholder="lnurl1... / lnurlw://...?k1=... / lnbc1..."
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
            title={offlineMode() ? 'Offline mode is on' : 'Add to wallet'}
            disabled={busy() || value() === '' || !isValid() || offlineMode()}
            onClick={handlePaste}
          >
            <Show when={busy()} fallback={<IoReturnDownForwardSharp />}>
              <IoRefreshSharp class="spin" />
            </Show>
          </button>
        </div>
        <Show when={value() !== '' && !isValid()}>
          <p class="warning">
            Not a valid LNURLcash bearer note (an LNURL-withdraw link carrying a
            k1) or bolt11 invoice.
          </p>
        </Show>
      </>
    </Dialog>
  )
}
export default ReceiveDialog
