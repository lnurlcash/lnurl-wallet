import type {Component} from 'solid-js'
import {Show, createMemo, createSignal} from 'solid-js'
import {IoKeySharp, IoRefreshSharp} from 'solid-icons/io'

import type {Bearer} from '../storage'
import {useWallet} from '../WalletContext'
import {
  serverOf,
  requireNoteK1,
  withNewK1,
  settleNote,
  probeBurnedNote,
  mergeNotesWithHash,
  splitNoteWithHash,
  generateOutputSecret,
  disclosedValue,
  isCp1,
  isCk1,
  AmbiguousMintError
} from '../lnurlcash'
import {notify, NotifyKind, msatToSats} from '../helpers'
import {offlineMode} from '../offlineMode'
import Dialog from './Dialog'
import FiatValue from './FiatValue'

export type SendToPubkeyDialogProps = {
  // every selected, eligible, non-device-backed note - already guaranteed
  // to share one issuing mint by Wallet.tsx's own selection rules (see its
  // toggleSelect/selectedServer), same precondition Combine/Combine & split
  // rely on
  bearers: Bearer[]
  onClose: () => void
}

// LUD-25's own p1/p2 mechanism (request.ts's outputFieldName/
// mutationSignature), pointed at a cp1 pasted in by hand instead of one this
// wallet derived from a registered cx1 branch the way internalTransfer.ts's
// payInternalTransfer does. Whoever holds the matching private key can prove
// ownership later with a ck1 signature over the fixed "LNURLcash" message
// (see the musig2 addon's own worked example) - this dialog never asks for
// or sees that key, only its public cp1 commitment.
//
// One or many input notes, naming the pasted cp1 as either the WHOLE output
// (amount left blank - a combine, or a plain send if there's only one input)
// or the first of a two-output split (an amount typed in, with a fresh
// wallet-held secret coming back as change) - covers "combine to a pubkey",
// "split to a pubkey" and "combine, then split to a pubkey" with the same
// two mint primitives Combine/Combine & split already use.
const SendToPubkeyDialog: Component<SendToPubkeyDialogProps> = props => {
  const {addBearer, updateBearer, removeBearer, logActivity} = useWallet()

  const [pubkeyInput, setPubkeyInput] = createSignal('')
  const [amountSats, setAmountSats] = createSignal('')
  const [busy, setBusy] = createSignal(false)

  const totalMsat = createMemo(() =>
    props.bearers.reduce((sum, b) => sum + b.amount, 0)
  )

  const send = async () => {
    const picked = props.bearers
    if (picked.length === 0) return
    const cp1 = pubkeyInput().trim().toLowerCase()
    if (!isCp1(cp1)) {
      notify(
        'Enter a valid cp1 key (the recipient’s pubkey commitment).',
        NotifyKind.ERROR
      )
      return
    }
    const sum = totalMsat()
    let amountMsat = sum
    const rawAmount = amountSats().trim()
    if (rawAmount !== '') {
      // whole sats only - same reasoning as the existing Split/Combine &
      // split inputs (splitSingleSats/splitSats above): a fractional sat
      // would otherwise round to a sub-sat, unspendable output
      const sats = Math.trunc(Number(rawAmount))
      if (!Number.isFinite(sats) || sats <= 0) {
        notify(
          'Enter a whole number of sats, or leave it blank to send everything.',
          NotifyKind.ERROR
        )
        return
      }
      amountMsat = sats * 1000
      if (amountMsat > sum) {
        notify(
          "Amount can't exceed the selected notes' combined value.",
          NotifyKind.ERROR
        )
        return
      }
    }
    setBusy(true)
    try {
      const [base] = picked
      const server = serverOf(base.url)
      const k1s = picked.map(b => requireNoteK1(b.url))
      if (amountMsat === sum) {
        // combine (or, for a single input, a plain rotate-away) fully into
        // the recipient's pubkey - nothing comes back to this wallet
        try {
          await mergeNotesWithHash(base.callback, k1s, cp1)
        } catch (err) {
          if (!(err instanceof AmbiguousMintError)) throw err
          const outcome = await probeBurnedNote(base.url)
          if (outcome === 'live') throw err
          if (outcome === 'unknown') {
            throw new Error(
              'The send may have gone through but could not be confirmed - check with the recipient, then refresh your remaining notes before retrying.'
            )
          }
          // 'gone': the burn landed despite the ambiguous response - the
          // output was never this wallet's to track either way
        }
        for (const bearer of picked) removeBearer(bearer.id)
        logActivity(
          'transfer',
          `Sent ${msatToSats(sum)} sats from ${server} to pubkey ${cp1}.`,
          base.label
        )
        notify(`Sent ${msatToSats(sum)} sats to ${cp1}.`, NotifyKind.SUCCESS)
      } else {
        // split: the recipient's cp1 is the first output, a fresh
        // wallet-held secret is the change - same shape as Combine & split,
        // just naming an outside pubkey instead of another note of our own
        const preferPubkey = k1s.every(isCk1)
        const changeK1 = generateOutputSecret(server, preferPubkey)
        const changeMsat = sum - amountMsat
        let changeSignature: string | undefined
        try {
          const result = await splitNoteWithHash(
            base.callback,
            k1s,
            amountMsat,
            cp1,
            disclosedValue(changeK1)
          )
          changeSignature = result.changeSignature
        } catch (err) {
          if (!(err instanceof AmbiguousMintError)) throw err
          const outcome = await probeBurnedNote(base.url)
          if (outcome === 'live') throw err
          if (outcome === 'unknown') {
            // unlike splitNote's own equivalent catch, the recipient's
            // output is never this wallet's to lose - only the change
            // secret is, so only that one rides out as a stored-unverified
            // note (same reasoning as internalTransfer.ts's payInternalTransfer)
            await addBearer({
              url: withNewK1(base.url, changeK1, changeMsat),
              callback: base.callback,
              amount: changeMsat,
              verified: false,
              mintPubkey: base.mintPubkey
            })
            throw new Error(
              'The send may have gone through but could not be confirmed - a possible change note is stored unverified alongside your originals; refresh it to reconcile.'
            )
          }
          // 'gone': the burn landed - changeK1 is the only change left,
          // unsigned for now (a refresh/settle below recovers it)
        }
        const change = await addBearer({
          url: withNewK1(base.url, changeK1, changeMsat, changeSignature),
          callback: base.callback,
          amount: changeMsat,
          verified: false,
          mintPubkey: base.mintPubkey
        })
        for (const bearer of picked) removeBearer(bearer.id)
        // a mint MAY withhold a split fee from the change - settleNote
        // reads back the actual value rather than assuming the naive one,
        // same as Combine & split's own combineAndSplit
        let settledAmount = changeMsat
        try {
          const settled = await settleNote(
            base.url,
            changeK1,
            changeMsat,
            changeSignature
          )
          settledAmount = settled.amountMsat
          await updateBearer(change.id, {
            url: withNewK1(
              base.url,
              settled.k1,
              settled.amountMsat,
              settled.signature
            ),
            callback: settled.callback,
            amount: settled.amountMsat,
            verified: true
          })
        } catch (err) {
          notify(
            `Sent, but settling your change note didn't complete (${(err as Error).message}) - it's tracked unverified; refresh it to repair.`,
            NotifyKind.ERROR
          )
        }
        logActivity(
          'transfer',
          `Sent ${msatToSats(amountMsat)} sats from ${server} to pubkey ${cp1}, kept ${msatToSats(settledAmount)} sats change.`,
          base.label
        )
        notify(
          `Sent ${msatToSats(amountMsat)} sats to ${cp1} - kept ${msatToSats(settledAmount)} sats change.`,
          NotifyKind.SUCCESS
        )
      }
      props.onClose()
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog onClose={props.onClose}>
      <h4>
        <IoKeySharp />
        &nbsp;Send {msatToSats(totalMsat())} sats
        <FiatValue msat={totalMsat()} /> to a pubkey
      </h4>
      <p class="bearer-hint">
        Burns the {props.bearers.length} selected note
        {props.bearers.length === 1 ? '' : 's'} and mints a note owned by the
        cp1 pubkey below - only whoever holds its matching private key can later
        prove ownership (a ck1 signature) and redeem it. This can't be undone,
        and this wallet never asks for or sees that private key.
      </p>
      <label>Recipient cp1 key</label>
      <input
        type="text"
        placeholder="cp1..."
        value={pubkeyInput()}
        onInput={e => setPubkeyInput(e.currentTarget.value)}
      />
      <label>Amount to send (sats) - leave blank to send everything</label>
      <input
        type="number"
        placeholder={msatToSats(totalMsat())}
        value={amountSats()}
        onInput={e => setAmountSats(e.currentTarget.value)}
        onKeyDown={e => e.key === 'Enter' && send()}
      />
      <Show when={amountSats().trim() !== ''}>
        {(() => {
          const sats = Math.trunc(Number(amountSats()))
          const changeMsat = totalMsat() - sats * 1000
          return (
            <Show when={Number.isFinite(sats) && sats > 0 && changeMsat > 0}>
              <p class="bearer-hint">
                You'll keep ~{msatToSats(changeMsat)} sats change back in this
                wallet.
              </p>
            </Show>
          )
        })()}
      </Show>
      <div class="btns">
        <button disabled={busy() || offlineMode()} onClick={send}>
          <Show when={busy()}>
            <IoRefreshSharp class="spin" />
            &nbsp;
          </Show>
          Send
        </button>
        <button disabled={busy()} onClick={props.onClose}>
          Cancel
        </button>
      </div>
    </Dialog>
  )
}
export default SendToPubkeyDialog
