import type {Component} from 'solid-js'
import {Show, createMemo, createSignal} from 'solid-js'
import {IoPaperPlaneSharp, IoRefreshSharp} from 'solid-icons/io'

import type {Bearer} from '../storage'
import {useWallet} from '../WalletContext'
import {
  serverOf,
  serviceOriginOf,
  resolveMintInput,
  fetchPayRequest,
  requireNoteK1,
  withNewK1,
  settleNote,
  probeBurnedNote,
  mergeNotesWithHash,
  splitNoteWithHash,
  payInternalTransfer,
  generateOutputSecret,
  disclosedValue,
  isCk1,
  AmbiguousMintError,
  AmbiguousMutationError,
  type InternalTransferHint
} from '../lnurlcash'
import {notify, NotifyKind, msatToSats} from '../helpers'
import {parseRecipient, type Recipient} from '../sendRecipient'
import {offlineMode} from '../offlineMode'
import Dialog from './Dialog'
import FiatValue from './FiatValue'

export type SendToDialogProps = {
  // every selected, eligible, non-device-backed note - already guaranteed
  // to share one issuing mint by Wallet.tsx's own selection rules (see its
  // toggleSelect/selectedServer), same precondition Combine/Combine & split
  // rely on
  bearers: Bearer[]
  onClose: () => void
}

const RECIPIENT_HINT: Record<Recipient['kind'], string> = {
  cp1: 'A single pubkey - only its private key holder can redeem the note.',
  cx1: "An address branch - the note goes to that branch's next unused key, the same place a Lightning payment to its address would land.",
  username:
    "A username at this mint - the note goes to its registered branch's next unused key, no Lightning involved."
}

// Burns the selected notes at their own mint and names someone else's key
// as the output - LUD-25's own p1/p2 mechanism (request.ts's
// outputFieldName/mutationSignature). The recipient is one of:
// - a cp1 pasted in by hand: that exact pubkey. Whoever holds its private
//   key proves ownership later with a ck1 signature (see the musig2 addon's
//   own worked example) - this wallet never sees that key.
// - a cx1 branch export: its next unused purpose-2 (Lightning Address) key,
//   via internalTransfer.ts's payInternalTransfer.
// - a username@this-mint: same as a cx1, but the branch and its hinted next
//   index come from that address's own payRequest (LUD-25's "Internal
//   transfer", text/cpub) - pays a registered address without Lightning.
// The latter two land where the recipient's own address check
// (addressRecovery.ts) finds them.
//
// One or many input notes, naming the recipient as either the WHOLE output
// (amount left blank - a combine, or a plain send if there's only one input)
// or the first of a two-output split (an amount typed in, with a fresh
// wallet-held secret coming back as change) - the same two mint primitives
// Combine/Combine & split already use.
const SendToDialog: Component<SendToDialogProps> = props => {
  const {addBearer, updateBearer, removeBearer, logActivity} = useWallet()

  const [recipientInput, setRecipientInput] = createSignal('')
  const [amountSats, setAmountSats] = createSignal('')
  const [busy, setBusy] = createSignal(false)

  const host = () => serverOf(props.bearers[0]!.url)
  const totalMsat = createMemo(() =>
    props.bearers.reduce((sum, b) => sum + b.amount, 0)
  )
  const recipient = createMemo(() => parseRecipient(recipientInput(), host()))

  // a username's branch + hinted next index, from its payRequest - which
  // must be minted by this same mint, or it's not an internal send at all
  const lookupUsername = async (
    username: string
  ): Promise<InternalTransferHint> => {
    const address = `${username}@${host()}`
    const url = resolveMintInput(address)
    if (!url) throw new Error(`${address} is not a valid address.`)
    const info = await fetchPayRequest(url)
    if (
      !info.withdrawLink ||
      serviceOriginOf(info.withdrawLink) !==
        serviceOriginOf(props.bearers[0]!.url)
    ) {
      throw new Error(
        `${address} isn't minted by the same mint as these notes.`
      )
    }
    if (!info.internalTransfer) {
      throw new Error(
        `${address} doesn't accept internal sends (no registered key advertised).`
      )
    }
    return info.internalTransfer
  }

  const send = async () => {
    const picked = props.bearers
    if (picked.length === 0) return
    const target = recipient()
    if (!target) {
      notify(
        `Enter a cp1 pubkey, a cx1 branch, or a username at ${host()}.`,
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
    const changeMsat = sum - amountMsat
    setBusy(true)
    try {
      const [base] = picked
      const k1s = picked.map(b => requireNoteK1(b.url))
      const label =
        target.kind === 'cp1'
          ? `pubkey ${target.cp1}`
          : target.kind === 'username'
            ? `${target.username}@${host()}`
            : 'cx1 branch'
      // resolved before anything is burned - a bad username fails here
      const hint =
        target.kind === 'cx1'
          ? target.hint
          : target.kind === 'username'
            ? await lookupUsername(target.username)
            : null
      const cp1 = target.kind === 'cp1' ? target.cp1 : ''

      let index: number | null = null
      let change: {k1: string; signature?: string} | null = null
      try {
        if (hint) {
          const result = await payInternalTransfer(
            base.callback,
            k1s,
            amountMsat,
            sum,
            hint
          )
          index = result.index
          if (result.kind === 'split') {
            change = {k1: result.change, signature: result.changeSignature}
          }
        } else if (changeMsat === 0) {
          // combine (or, for a single input, a plain rotate-away) fully into
          // the recipient's pubkey - nothing comes back to this wallet
          await mergeNotesWithHash(base.callback, k1s, cp1)
        } else {
          // split: the recipient's cp1 is the first output, a fresh
          // wallet-held secret is the change - same shape as Combine &
          // split, just naming an outside pubkey instead of another note of
          // our own
          const changeK1 = generateOutputSecret(host(), k1s.every(isCk1))
          try {
            const result = await splitNoteWithHash(
              base.callback,
              k1s,
              amountMsat,
              cp1,
              disclosedValue(changeK1)
            )
            change = {k1: changeK1, signature: result.changeSignature}
          } catch (err) {
            // carry the change secret out, same as payInternalTransfer does
            if (err instanceof AmbiguousMintError) {
              throw new AmbiguousMutationError((err as Error).message, [
                changeK1
              ])
            }
            throw err
          }
        }
      } catch (err) {
        if (!(err instanceof AmbiguousMintError)) throw err
        const outcome = await probeBurnedNote(base.url)
        if (outcome === 'live') throw err
        // the recipient's output is never this wallet's to lose - only a
        // split's change secret is
        const changeK1 =
          changeMsat > 0 && err instanceof AmbiguousMutationError
            ? err.newSecrets[0]
            : undefined
        if (outcome === 'unknown') {
          if (changeK1) {
            await addBearer({
              url: withNewK1(base.url, changeK1, changeMsat),
              callback: base.callback,
              amount: changeMsat,
              verified: false,
              mintPubkey: base.mintPubkey
            })
          }
          throw new Error(
            changeK1
              ? 'The send may have gone through but could not be confirmed - a possible change note is stored unverified alongside your originals; refresh it to reconcile.'
              : 'The send may have gone through but could not be confirmed - check with the recipient, then refresh your remaining notes before retrying.'
          )
        }
        // 'gone': the burn landed despite the ambiguous response - the
        // change (if any) is unsigned for now, settled below
        if (changeK1) change = {k1: changeK1}
      }

      for (const bearer of picked) removeBearer(bearer.id)

      let keptMsat = 0
      if (change) {
        const stored = await addBearer({
          url: withNewK1(base.url, change.k1, changeMsat, change.signature),
          callback: base.callback,
          amount: changeMsat,
          verified: false,
          mintPubkey: base.mintPubkey
        })
        keptMsat = changeMsat
        // a mint MAY withhold a split fee from the change - settleNote
        // reads back the actual value rather than assuming the naive one,
        // same as Combine & split's own combineAndSplit
        try {
          const settled = await settleNote(
            base.url,
            change.k1,
            changeMsat,
            change.signature
          )
          keptMsat = settled.amountMsat
          await updateBearer(stored.id, {
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
      }

      const at = index !== null ? ` (index ${index})` : ''
      const kept =
        keptMsat > 0 ? `, kept ${msatToSats(keptMsat)} sats change` : ''
      logActivity(
        'transfer',
        `Sent ${msatToSats(amountMsat)} sats from ${host()} to ${label}${at}${kept}.`,
        base.label
      )
      notify(
        `Sent ${msatToSats(amountMsat)} sats to ${label}${kept}.`,
        NotifyKind.SUCCESS
      )
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
        <IoPaperPlaneSharp />
        &nbsp;Send {msatToSats(totalMsat())} sats
        <FiatValue msat={totalMsat()} /> at {host()}
      </h4>
      <p class="bearer-hint">
        Burns the {props.bearers.length} selected note
        {props.bearers.length === 1 ? '' : 's'} at {host()} and mints a note
        owned by the recipient below instead - no Lightning involved. This can't
        be undone.
      </p>
      <label for="send-to-recipient">
        Recipient - cp1 pubkey, cx1 branch, or username
      </label>
      <input
        id="send-to-recipient"
        type="text"
        placeholder={`cp1..., cx1... or alice@${host()}`}
        value={recipientInput()}
        disabled={busy()}
        onInput={e => setRecipientInput(e.currentTarget.value)}
      />
      <Show when={recipient()}>
        {r => <p class="bearer-hint">{RECIPIENT_HINT[r().kind]}</p>}
      </Show>
      <label for="send-to-amount">
        Amount to send (sats) - leave blank to send everything
      </label>
      <input
        id="send-to-amount"
        type="number"
        placeholder={msatToSats(totalMsat())}
        value={amountSats()}
        disabled={busy()}
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
export default SendToDialog
