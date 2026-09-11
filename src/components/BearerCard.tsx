import type {Component} from 'solid-js'
import {Show, For, createMemo, createSignal} from 'solid-js'
import {
  IoTrashSharp,
  IoShieldCheckmarkSharp,
  IoBanSharp,
  IoArrowUndoSharp,
  IoHardwareChipSharp,
  IoEyeSharp,
  IoCopySharp,
  IoRefreshSharp,
  IoCheckmarkSharp,
  IoWarningSharp
} from 'solid-icons/io'

import type {Bearer} from '../storage'
import {useWallet} from '../WalletContext'
import {useDevice} from '../DeviceContext'
import {
  noteK1,
  noteSignature,
  serverOf,
  serviceOriginOf,
  toBech32Lnurl,
  verifyNoteSignature,
  verifyNoteSignatureHash,
  withoutSignature,
  isCk1
} from '../lnurlcash'
import {
  deviceExportForHandoff,
  markDeviceNoteSpent,
  requireDeviceClient
} from '../deviceOrchestration'
import {
  msatToSats,
  formatDate,
  formatRelativeTime,
  copyToClipboard,
  notify,
  NotifyKind
} from '../helpers'
import {
  getTrustedMintPubkey,
  getTrustedMintNodeColor,
  getTrustedMintSunsetDate,
  isMintUnconfirmed
} from '../trustedMints'
import Qr from './Qr'
import FiatValue from './FiatValue'
import Dialog from './Dialog'
import {decodeTag, parseLabelTags} from '../noteTags'

export type BearerCardProps = {
  bearer: Bearer
  selected: boolean
  onSelect: (selected: boolean) => void
  // Wallet.tsx's own refreshOneBearer - lives there since it already
  // encapsulates the full device/rotate-on-refresh flow shared with the
  // selection toolbar's own Refresh action; not worth duplicating here
  onRefresh: (bearer: Bearer) => Promise<void>
}

const BearerCard: Component<BearerCardProps> = props => {
  const {updateBearer, removeBearer, logActivity} = useWallet()
  const {client: deviceClient} = useDevice()
  const [confirmDelete, setConfirmDelete] = createSignal(false)
  const [confirmUnspend, setConfirmUnspend] = createSignal(false)
  const [refreshing, setRefreshing] = createSignal(false)
  // whether the "hand this note over" panel is open at all - separate from
  // revealedUrl below, since a device-backed note opens the panel before
  // its secret is actually known (see revealDeviceNote)
  const [unveiling, setUnveiling] = createSignal(false)
  // this note's real, secret-bearing url - null until revealed. For a
  // browser-only note this is available the instant the panel opens (see
  // startUnveil); a device-backed one needs an explicit export (physical
  // button press) first - see revealDeviceNote. Never persisted, only ever
  // held here in memory.
  const [revealedUrl, setRevealedUrl] = createSignal<string | null>(null)
  const [revealing, setRevealing] = createSignal(false)
  // tap-to-reveal on the QR itself - a shoulder-surfing guard, so the note's
  // actual secret never sits bare on screen just because the panel is open
  const [qrRevealed, setQrRevealed] = createSignal(false)
  // opt out of handing over this note's offline-verification sig (see
  // withoutSignature) - off by default, so the QR/copy keep behaving
  // exactly as before unless the holder deliberately strips it
  const [stripSignature, setStripSignature] = createSignal(false)

  const k1 = () => noteK1(props.bearer.url) || ''
  const isSpent = () => !!props.bearer.spent

  // a leading run of [tag] brackets on the label (see noteTags.ts) reads as
  // this note's tags; whatever's left after them is the free-text label
  const parsedLabel = createMemo(() => parseLabelTags(props.bearer.label || ''))

  // this note's issuing mint's self-reported node color (cached via the
  // mint-address lookup, see trustedMints.ts) - tints the card's own
  // background gradient (see the .tinted rule in style.scss) instead of
  // the app's default accent, purely cosmetic. Absent whenever no lookup
  // has ever cached one for this server, same fallback story as
  // offlineVerified's mintPubkey below.
  const noteColor = createMemo(() =>
    getTrustedMintNodeColor(serviceOriginOf(props.bearer.url))
  )
  // this note's issuing mint's self-reported planned shutdown date (see
  // trustedMints.ts's getTrustedMintSunsetDate) - a spent note doesn't need
  // the warning, there's nothing left to move away from this mint
  const sunsetDate = createMemo(() =>
    isSpent()
      ? null
      : getTrustedMintSunsetDate(serviceOriginOf(props.bearer.url))
  )
  const cardStyle = createMemo(() =>
    noteColor() ? {'--note-tint': noteColor()!} : {}
  )
  const toggleSelect = () => {
    if (!isSpent()) props.onSelect(!props.selected)
  }

  // the whole card is the click target for select-to-combine - except any
  // interactive control inside it (a spent note's own Unspend/Clear
  // buttons), which should do their own thing rather than also flip
  // selection - and except while the hand-over panel is open, where a
  // stray click on the revealed QR itself (not a button) shouldn't also
  // toggle selection underneath it
  const onCardClick = (e: MouseEvent) => {
    if (unveiling()) return
    if ((e.target as HTMLElement).closest('button, input, textarea, a')) return
    toggleSelect()
  }
  const onCardKeyDown = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggleSelect()
    }
  }

  // Offline-verifiable iff the note carries a signature and this wallet has
  // accepted the issuing SERVICE's pinned key.  A freshly minted note, or
  // one recovered after a lost mutation response, may not have its
  // certificate yet; nor does one signed under a key this mint has since
  // rotated away from, which a single rotate re-issues under the new key.
  // The trusted-mints registry is authoritative; the bearer's own field is
  // only a fallback for the edge case of a restored record whose server
  // isn't in the registry yet - and withheld entirely when the registry's
  // pin is unconfirmed (file-sourced): then the bearer's cached claim is
  // just as uncorroborated
  const offlineVerified = createMemo(() => {
    const sig = noteSignature(props.bearer.url)
    const origin = serviceOriginOf(props.bearer.url)
    const mintPubkey =
      getTrustedMintPubkey(origin) ??
      (isMintUnconfirmed(origin) ? null : (props.bearer.mintPubkey ?? null))
    if (!sig || !mintPubkey) return false
    // verifyNoteSignature itself dispatches on k1's own shape (legacy
    // preimage vs LUD-25 Part 2 ck1 signature) - see signature.ts
    return props.bearer.deviceHash
      ? verifyNoteSignatureHash(
          props.bearer.deviceHash,
          props.bearer.amount,
          sig,
          mintPubkey
        )
      : verifyNoteSignature(k1(), props.bearer.amount, sig, mintPubkey)
  })

  // a quick, direct refresh right from the card - same
  // fetch-value-then-rotate flow Wallet.tsx's own toolbar Refresh runs on a
  // selection, just for this one note without needing to select it first
  const refreshThisNote = async () => {
    if (refreshing()) return
    setRefreshing(true)
    try {
      await props.onRefresh(props.bearer)
    } finally {
      setRefreshing(false)
    }
  }

  const unspend = () => {
    updateBearer(props.bearer.id, {spent: false})
    setConfirmUnspend(false)
    logActivity(
      'unspent',
      `Unspent ${msatToSats(props.bearer.amount)} sats from ${serverOf(props.bearer.url)}.`,
      props.bearer.label
    )
    notify('Unspent - actions are available again.', NotifyKind.SUCCESS)
  }

  // opens the hand-over panel - browser-only notes reveal immediately
  // (their url already carries the real secret); device-backed ones wait
  // for an explicit reveal action (see revealDeviceNote)
  const startUnveil = () => {
    setUnveiling(true)
    setRevealedUrl(props.bearer.deviceId ? null : props.bearer.url)
    setQrRevealed(false)
  }

  const cancelUnveil = () => {
    setUnveiling(false)
    setRevealedUrl(null)
    setQrRevealed(false)
    setStripSignature(false)
  }

  const revealDeviceNote = async () => {
    if (!props.bearer.deviceId) return
    setRevealing(true)
    try {
      const client = requireDeviceClient(deviceClient())
      const {url} = await deviceExportForHandoff(
        client,
        props.bearer.deviceId,
        props.bearer.url,
        props.bearer.amount
      )
      setRevealedUrl(url)
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setRevealing(false)
    }
  }

  const markHandedOver = async () => {
    updateBearer(props.bearer.id, {spent: true})
    if (props.bearer.deviceId) {
      await markDeviceNoteSpent(deviceClient(), props.bearer.deviceId)
    }
    cancelUnveil()
    logActivity(
      'transfer',
      `Handed over ${msatToSats(props.bearer.amount)} sats from ${serverOf(props.bearer.url)}.`,
      props.bearer.label
    )
    notify('Marked as handed over and spent.', NotifyKind.SUCCESS)
  }

  return (
    <figure
      class="bearer-card"
      classList={{
        tinted: !!noteColor(),
        selected: props.selected,
        selectable: !isSpent()
      }}
      style={cardStyle()}
      tabIndex={isSpent() ? undefined : 0}
      title={
        isSpent() ? undefined : 'Click to select for combine/split/transfer'
      }
      onClick={onCardClick}
      onKeyDown={onCardKeyDown}
    >
      <div class="bearer-head">
        <div class="bearer-title">
          <span class="bearer-amount">
            {msatToSats(props.bearer.amount)} sats
            <FiatValue msat={props.bearer.amount} />
          </span>
          <Show when={props.bearer.label && !isSpent()}>
            <div class="bearer-tags-row">
              <For each={parsedLabel().tags}>
                {tag => <span class="bearer-tag">{decodeTag(tag)}</span>}
              </For>
              <Show when={parsedLabel().text}>
                <span class="bearer-label">{parsedLabel().text}</span>
              </Show>
            </div>
          </Show>
          <div class="bearer-badges">
            <Show when={sunsetDate()}>
              {date => (
                <span
                  class="bearer-sunset"
                  title={`This mint plans to sunset on ${new Date(date()).toLocaleDateString()} - rotate, transfer, or melt this note before then.`}
                >
                  <IoWarningSharp />
                  &nbsp;sunsetting
                </span>
              )}
            </Show>
            <Show when={!props.bearer.verified}>
              <span class="bearer-pending">unverified</span>
            </Show>
            <Show when={offlineVerified()}>
              <span
                class="bearer-signed"
                title="Signature checks out against this mint's published pubkey"
              >
                <IoShieldCheckmarkSharp />
                &nbsp;signed
              </span>
            </Show>
            {/* LUD-25 Part 1's legacy hash preimage, as opposed to Part 2's
            pubkey/signature-bound k1 (see cashAddressBranch/the Address
            page) - k1() is '' for a device-backed bearer (no raw k1 kept
            in browser storage), which isCk1('') correctly reads as false;
            gated on a non-empty k1 too so a device note doesn't wrongly
            claim a scheme this wallet can't actually see from here */}
            <Show when={k1() && !isCk1(k1())}>
              <span
                class="bearer-plain"
                title="This note's own secret is a legacy hash preimage (LUD-25 Part 1), not a Part 2 pubkey/signature"
              >
                plain secret
              </span>
            </Show>
            <Show when={props.bearer.deviceId}>
              <span
                class="bearer-device"
                title="This note's secret lives on your paired vault, not this browser"
              >
                <IoHardwareChipSharp />
                &nbsp;on device
              </span>
            </Show>
            <Show when={isSpent()}>
              <span
                class="bearer-spent"
                title="Locked as spent - rotate and split (in the toolbar above) are disabled so this copy can't be reused by accident."
              >
                <IoBanSharp />
                &nbsp;spent
              </span>
            </Show>
          </div>
          <span class="bearer-server">{serverOf(props.bearer.url)}</span>
        </div>
      </div>
      <Show when={isSpent()}>
        <div class="btns">
          <div class="bearer-actions">
            <button
              class="icon-btn"
              title="Unspend - unlock this note again"
              onClick={() => setConfirmUnspend(true)}
            >
              <IoArrowUndoSharp />
            </button>
            <button
              class="icon-btn"
              title="Clear spent note from wallet"
              onClick={() => setConfirmDelete(true)}
            >
              <IoTrashSharp />
            </button>
          </div>
        </div>
      </Show>
      <Show when={!isSpent()}>
        <Show
          when={unveiling()}
          fallback={
            <div class="btns">
              <div class="bearer-actions">
                <button
                  class="icon-btn"
                  title="Unveil to hand over"
                  onClick={startUnveil}
                >
                  <IoEyeSharp />
                </button>
                <button
                  class="icon-btn"
                  title="Copy this note to clipboard"
                  onClick={() =>
                    copyToClipboard(toBech32Lnurl(props.bearer.url))
                  }
                >
                  <IoCopySharp />
                </button>
                <button
                  class="icon-btn bearer-action-right"
                  disabled={refreshing()}
                  title="Rotate - fetches the current value by note hash first"
                  onClick={e => {
                    // refreshThisNote flips refreshing() synchronously,
                    // which swaps this button's own icon (see the Show
                    // below) and detaches the clicked <svg> from the DOM
                    // mid-bubble - onCardClick's closest('button, ...')
                    // check then finds no ancestor button on a detached
                    // node and mistakes this for a click-to-select. Stop
                    // it from ever reaching the card instead of relying on
                    // DOM structure that's about to change out from under it
                    e.stopPropagation()
                    refreshThisNote()
                  }}
                >
                  <Show when={refreshing()} fallback={<IoRefreshSharp />}>
                    <IoRefreshSharp class="spin" />
                  </Show>
                </button>
              </div>
            </div>
          }
        >
          <Dialog onClose={cancelUnveil}>
            <div class="dialog-title-row">
              <h4>Hand over {msatToSats(props.bearer.amount)} sats</h4>
              <label
                class="strip-sig-toggle"
                title="Unchecking this strips the sig from the QR/copied note before handing it over, so it can no longer be checked offline against the issuing mint's pinned key"
              >
                <input
                  type="checkbox"
                  checked={!stripSignature()}
                  onChange={e => setStripSignature(!e.currentTarget.checked)}
                />
                &nbsp;Offline verified
              </label>
            </div>
            <Show
              when={revealedUrl()}
              fallback={
                <div class="btns">
                  <button disabled={revealing()} onClick={revealDeviceNote}>
                    <Show when={revealing()}>
                      <IoRefreshSharp class="spin" />
                      &nbsp;
                    </Show>
                    {revealing()
                      ? 'Waiting for the vault...'
                      : 'Reveal to hand over'}
                  </button>
                </div>
              }
            >
              {url => {
                const handoverUrl = () =>
                  stripSignature() ? withoutSignature(url()) : url()
                return (
                  <>
                    <div class="qr-wrapper">
                      <Qr value={toBech32Lnurl(handoverUrl())} />
                      <Show when={!qrRevealed()}>
                        <button
                          class="qr-overlay"
                          title="Show QR code - it IS the bearer note, anyone who scans it can spend it"
                          onClick={() => setQrRevealed(true)}
                        >
                          <IoEyeSharp />
                        </button>
                      </Show>
                    </div>
                    <div class="btns">
                      <button
                        onClick={() =>
                          copyToClipboard(toBech32Lnurl(handoverUrl()))
                        }
                      >
                        <IoCopySharp />
                        &nbsp;Copy note
                      </button>
                      <button onClick={markHandedOver}>
                        <IoCheckmarkSharp />
                        &nbsp;Mark done
                      </button>
                    </div>
                  </>
                )
              }}
            </Show>
          </Dialog>
        </Show>
      </Show>
      <Show when={confirmUnspend()}>
        <p class="warning">
          This note may already be gone for good - if it was melted, or handed
          to someone who's since redeemed it, unspending it here won't bring it
          back (this is a local flag, not a check with the service). And if you
          handed it over and this wallet spends or rotates it again before the
          recipient does, their copy gets invalidated instead of yours. Unspend
          anyway?
        </p>
        <div class="btns">
          <button onClick={unspend}>Unspend anyway</button>
          <button onClick={() => setConfirmUnspend(false)}>Cancel</button>
        </div>
      </Show>
      <Show when={confirmDelete()}>
        <p class="warning">
          Clear this spent note from the wallet? If it turns out it wasn't
          actually spent, the sats are gone unless you saved the note elsewhere.
        </p>
        <div class="btns">
          <button
            onClick={() => {
              removeBearer(props.bearer.id)
              logActivity(
                'deleted',
                `Cleared a spent ${msatToSats(props.bearer.amount)} sat note from ${serverOf(props.bearer.url)}.`,
                props.bearer.label
              )
              notify('Spent note cleared.', NotifyKind.SUCCESS)
            }}
          >
            Clear
          </button>
          <button onClick={() => setConfirmDelete(false)}>Cancel</button>
        </div>
      </Show>
      <p class="bearer-dates" title={formatDate(props.bearer.updatedAt)}>
        updated {formatRelativeTime(props.bearer.updatedAt)}
      </p>
    </figure>
  )
}
export default BearerCard
