import type {Component} from 'solid-js'
import {For, Show, createSignal} from 'solid-js'
import {Dynamic} from '@solidjs/web'
import {
  IoCashSharp,
  IoGitBranchSharp,
  IoGitMergeSharp,
  IoFlameSharp,
  IoSwapHorizontalSharp,
  IoArrowDownCircleSharp,
  IoRefreshSharp,
  IoBanSharp,
  IoArrowUndoSharp,
  IoTrashSharp,
  IoReceiptSharp,
  IoArrowBackSharp,
  IoOpenSharp,
  IoSearchSharp,
  IoCheckmarkCircleSharp,
  IoCopySharp
} from 'solid-icons/io'

import {useWallet} from '../WalletContext'
import type {ActivityKind} from '../storage'
import {
  fetchInvoiceVerification,
  verifyMeltPreimage,
  type VerifyResult
} from '../lnurlcash'
import {formatDate, formatRelativeTime, copyToClipboard} from '../helpers'
import RequireWallet from '../components/RequireWallet'
import Dialog from '../components/Dialog'
import Link from '../components/Link'

// one icon per ActivityKind, reusing the same icon each action already
// shows elsewhere in the app (Mint's cash, BearerCard's split/refresh/
// spent/unspent, MintGroupCard's combine, Melt's flame, Transfer's swap/
// receive) so a log entry reads as the same action, not a new vocabulary
const KIND_ICON: Record<ActivityKind, Component> = {
  mint: IoCashSharp,
  split: IoGitBranchSharp,
  combine: IoGitMergeSharp,
  melt: IoFlameSharp,
  transfer: IoSwapHorizontalSharp,
  receive: IoArrowDownCircleSharp,
  refresh: IoRefreshSharp,
  recovered: IoSearchSharp,
  spent: IoBanSharp,
  unspent: IoArrowUndoSharp,
  deleted: IoTrashSharp
}

// mint/melt messages end with a raw " Verify: <url>." (see Mint.tsx and
// MeltDialog.tsx's own logActivity calls) - pulled back out here rather
// than adding a structured field to ActivityEvent, so the message itself
// stays the simple opaque sentence storage.ts's own comment describes.
// Non-greedy up to the final literal '.' so it captures the full url, not
// the sentence-ending period after it
const VERIFY_SUFFIX = / Verify: (\S+?)\.$/

const splitVerifyUrl = (
  message: string
): {text: string; verifyUrl: string | null} => {
  const match = message.match(VERIFY_SUFFIX)
  if (!match) return {text: message, verifyUrl: null}
  return {text: message.slice(0, match.index), verifyUrl: match[1]}
}

const Activity: Component = () => {
  const {activity, clearActivity} = useWallet()
  const [confirmClear, setConfirmClear] = createSignal(false)

  const clear = () => {
    clearActivity()
    setConfirmClear(false)
  }

  // the dialog's own state - null url means closed. Checking is a settled
  // LUD-21 verify response already carries everything needed (the invoice
  // itself, settled, and an optional preimage), so there's nothing to fetch
  // beyond that one request - no separate "fetch the invoice" round trip
  const [verifyDialogUrl, setVerifyDialogUrl] = createSignal<string | null>(
    null
  )
  const [verifying, setVerifying] = createSignal(false)
  const [verifyResult, setVerifyResult] = createSignal<VerifyResult | null>(
    null
  )
  const [verifyError, setVerifyError] = createSignal<string | null>(null)

  const openVerify = async (url: string) => {
    setVerifyDialogUrl(url)
    setVerifyResult(null)
    setVerifyError(null)
    setVerifying(true)
    try {
      setVerifyResult(await fetchInvoiceVerification(url))
    } catch (err) {
      setVerifyError((err as Error).message)
    } finally {
      setVerifying(false)
    }
  }

  const closeVerify = () => {
    setVerifyDialogUrl(null)
    setVerifyResult(null)
    setVerifyError(null)
  }

  return (
    <RequireWallet>
      <div id="activity" class="page">
        <div class="activity-header">
          <Link href="/wallet" class="icon-btn" title="Back to wallet">
            <IoArrowBackSharp />
          </Link>
          <h2>Activity log</h2>
          <Show when={activity().length > 0}>
            <button
              class="icon-btn activity-clear-btn"
              title="Clear the activity log"
              onClick={() => setConfirmClear(true)}
            >
              <IoTrashSharp />
            </button>
          </Show>
        </div>
        <Show when={confirmClear()}>
          <p class="warning">
            Clear the whole activity log? This only removes the log itself -
            your notes and their history with each mint are unaffected.
          </p>
          <div class="btns">
            <button onClick={clear}>Clear log</button>
            <button onClick={() => setConfirmClear(false)}>Cancel</button>
          </div>
        </Show>
        <Show
          when={activity().length > 0}
          fallback={
            <p class="bearer-hint">
              Nothing logged yet - minting, splitting, combining, melting, and
              transferring notes all show up here.
            </p>
          }
        >
          <ul class="activity-list">
            <For each={activity()}>
              {event => {
                const {text, verifyUrl} = splitVerifyUrl(event.message)
                return (
                  <li class="activity-item">
                    <span class="activity-icon">
                      <Dynamic
                        component={KIND_ICON[event.kind] ?? IoReceiptSharp}
                      />
                    </span>
                    <span class="activity-message-group">
                      <span class="activity-message">
                        {text}
                        <Show when={verifyUrl}>
                          {url => (
                            <button
                              type="button"
                              class="activity-verify-link"
                              title="Check whether this payment settled"
                              onClick={() => openVerify(url())}
                            >
                              <IoOpenSharp />
                              &nbsp;Verify
                            </button>
                          )}
                        </Show>
                      </span>
                      <Show when={event.label}>
                        <span class="activity-label">{event.label}</span>
                      </Show>
                    </span>
                    <span
                      class="activity-time"
                      title={formatDate(event.createdAt)}
                    >
                      {formatRelativeTime(event.createdAt)}
                    </span>
                  </li>
                )
              }}
            </For>
          </ul>
        </Show>
      </div>
      <Show when={verifyDialogUrl()}>
        <Dialog onClose={closeVerify}>
          <h4>Payment verification</h4>
          <Show when={verifying()}>
            <p>
              <IoRefreshSharp class="spin" />
              &nbsp;Checking...
            </p>
          </Show>
          <Show when={verifyError()}>
            {err => <p class="warning">{err()}</p>}
          </Show>
          <Show when={verifyResult()}>
            {result => (
              <>
                <p>
                  {result().settled
                    ? 'Settled - the service reports this payment went through.'
                    : 'Not settled yet.'}
                </p>
                <label>Invoice</label>
                <p class="mint-pubkey">{result().pr}</p>
                <div class="btns">
                  <button
                    type="button"
                    onClick={() => copyToClipboard(result().pr)}
                  >
                    <IoCopySharp />
                    &nbsp;Copy invoice
                  </button>
                </div>
                <Show when={result().settled}>
                  <Show
                    when={result().preimage}
                    fallback={
                      <p class="warning">
                        Settled, but the service did not disclose a preimage -
                        this is only the service's own claim, not independently
                        checkable.
                      </p>
                    }
                  >
                    {preimage => (
                      <Show
                        when={verifyMeltPreimage(result().pr, preimage())}
                        fallback={
                          <p class="warning">
                            The disclosed preimage does NOT hash to this
                            invoice's payment hash - this is not valid proof of
                            payment.
                          </p>
                        }
                      >
                        <p>
                          <IoCheckmarkCircleSharp />
                          &nbsp;Preimage verified - it hashes to exactly this
                          invoice's payment hash.
                        </p>
                      </Show>
                    )}
                  </Show>
                </Show>
              </>
            )}
          </Show>
        </Dialog>
      </Show>
    </RequireWallet>
  )
}
export default Activity
