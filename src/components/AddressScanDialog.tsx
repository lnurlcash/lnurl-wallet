import type {Component} from 'solid-js'
import {Show, For, createMemo, createSignal} from 'solid-js'
import {IoRefreshSharp, IoSearchSharp, IoTimeSharp} from 'solid-icons/io'

import Dialog from './Dialog'
import IndexMap, {type IndexMapCells} from './IndexMap'
import {useWallet} from '../WalletContext'
import {offlineMode} from '../offlineMode'
import {notify, NotifyKind, msatToSats} from '../helpers'
import {serverOf} from '../lnurlcash'
import {hasCashRoot} from '../cashSecrets'
import {
  registeredAddresses,
  setAddressAutoScan,
  ADDRESS_SCAN_OPTIONS,
  ADDRESS_SCAN_LABEL,
  type RegisteredAddress,
  type AddressScanMinutes
} from '../addressRegistry'
import {runAddressScan} from '../addressRecovery'
import type {IndexStatus} from '../recovery'
import {requestNotificationPermission} from '../notifications'

export type AddressScanDialogProps = {
  server: string
  onClose: () => void
}

// LUD-25 address-aware rescan (addressRecovery.ts's scanRegisteredAddress,
// which also consults and shows SERVICE's next-index hint) plus its
// auto-check scheduler - opened from the Address page, only for a mint
// this wallet has a registered username at. The plain mint-bearer rescan
// (wallet + change notes) stays on the Mint page's RescanDialog. Each
// note found here is labelled with the address and index it was scanned
// from (see addressRecovery.ts's addressNoteLabel).
const AddressScanDialog: Component<AddressScanDialogProps> = props => {
  const {bearers, addBearer, logActivity} = useWallet()
  const registered = createMemo(() =>
    registeredAddresses().find(a => a.server === props.server)
  )

  const [busy, setBusy] = createSignal(false)
  const [index, setIndex] = createSignal<number | null>(null)
  const [cells, setCells] = createSignal<IndexMapCells>({})
  const [showAutoCheck, setShowAutoCheck] = createSignal(false)
  // "Check notes" start index: blank resumes from this device's own floor
  // (and lets SERVICE's hint move it forward, see resolveScanStartIndex);
  // a typed number is walked from exactly as given
  const [startInput, setStartInput] = createSignal('')

  // enabling auto-check is the one user gesture this feature has to hang
  // a Notification permission prompt off of (TODO.md) - most browsers
  // silently drop a request made outside a direct gesture, so this can't
  // wait until the first scan actually finds something
  const setAutoCheck = (
    addr: RegisteredAddress,
    minutes: AddressScanMinutes
  ) => {
    setAddressAutoScan(addr.server, addr.username, minutes)
    if (minutes > 0) void requestNotificationPermission()
  }

  // what the most recent Check notes/Full rescan pass (this dialog
  // session only - not persisted) actually saw: where it started walking
  // forward from, and SERVICE's own advertised next-index hint at that
  // moment. Shown alongside addr.nextScanIndex (this device's own
  // persisted floor, always available with no scan needed) so a holder can
  // see all three numbers - SERVICE's, this device's, and where the last
  // pass actually started - side by side rather than having to trust any
  // one of them blindly (see resolveScanStartIndex's own doc comment for
  // why the SERVICE hint alone is never enough).
  const [lastCheck, setLastCheck] = createSignal<{
    checkedFrom: number
    serviceHint: number | null
  } | null>(null)

  // "Check notes"/"Full rescan" - "check notes" resumes from wherever this
  // address's own nextScanIndex (or SERVICE's own metadata hint) left off,
  // or from the start index typed in; "full rescan" always re-walks from 0.
  const checkNotes = async (mode: 'incremental' | 'all') => {
    const addr = registered()
    if (!addr || busy()) return
    const typed = startInput().trim()
    const exactStart = mode === 'incremental' && typed !== ''
    const startIndex = Number(typed)
    if (exactStart && !(Number.isInteger(startIndex) && startIndex >= 0)) {
      notify('Start index must be a whole number, 0 or more.', NotifyKind.ERROR)
      return
    }
    setBusy(true)
    setIndex(null)
    setCells({})
    try {
      const result = await runAddressScan(
        addr.server,
        addr.username,
        bearers(),
        {addBearer, logActivity},
        {
          startIndex: exactStart
            ? startIndex
            : mode === 'incremental'
              ? (addr.nextScanIndex ?? 0)
              : 0,
          exactStart,
          onProgress: setIndex,
          onIndex: (i: number, status: IndexStatus) =>
            setCells(prev => ({...prev, [i]: status}))
        }
      )
      setLastCheck({
        checkedFrom: result.checkedFrom,
        serviceHint: result.serviceHint
      })
      if (result.error) {
        notify(result.error, NotifyKind.ERROR)
      } else {
        const total = result.recovered.reduce((sum, n) => sum + n.amount, 0)
        notify(
          result.recovered.length > 0
            ? `Found ${result.recovered.length} note${result.recovered.length === 1 ? '' : 's'} (${msatToSats(total)} sats).`
            : 'No new notes found.',
          NotifyKind.SUCCESS
        )
      }
    } finally {
      setBusy(false)
      setIndex(null)
    }
  }

  return (
    <Dialog onClose={props.onClose}>
      <Show
        when={registered()}
        fallback={<p>No address registered at {serverOf(props.server)}.</p>}
      >
        {addr => (
          <>
            <h4>
              <IoSearchSharp />
              &nbsp;Check {addr().username}@{serverOf(addr().server)}
            </h4>
            <p class="bearer-hint">
              Checked up to index: {addr().nextScanIndex ?? 0}
              <Show when={lastCheck()}>
                {info => (
                  <>
                    {' '}
                    · started this pass from {info().checkedFrom} · mint's
                    suggested next index:{' '}
                    {info().serviceHint ?? 'not advertised'}
                  </>
                )}
              </Show>
            </p>
            <label for="address-scan-start-index">Start index</label>
            <input
              id="address-scan-start-index"
              type="number"
              min="0"
              step="1"
              placeholder={`${addr().nextScanIndex ?? 0} (resume)`}
              value={startInput()}
              disabled={busy()}
              onInput={e => setStartInput(e.currentTarget.value)}
              onKeyDown={e => e.key === 'Enter' && checkNotes('incremental')}
            />
            <p class="bearer-hint">
              Leave blank to resume where this device left off. Notes are also
              re-checked up to the gap limit below the start index, and the scan
              always walks past the mint's suggested next index. Found notes are
              tagged with this address and the index they were found at.
            </p>
            <div class="btns">
              <button
                disabled={offlineMode() || !hasCashRoot() || busy()}
                title={
                  offlineMode()
                    ? 'Offline mode is on'
                    : `Check ${addr().username}@${serverOf(addr().server)} for new notes, from the start index above (or where the last check left off)`
                }
                onClick={() => checkNotes('incremental')}
              >
                <Show when={busy()} fallback={<IoSearchSharp />}>
                  <IoRefreshSharp class="spin" />
                </Show>
                &nbsp;Check notes
              </button>
              <button
                class="icon-btn icon-btn-gap"
                disabled={offlineMode() || !hasCashRoot() || busy()}
                title="Full rescan - re-walk every index from 0, ignoring what's already been checked"
                onClick={() => checkNotes('all')}
              >
                <IoRefreshSharp />
                &nbsp;Full rescan
              </button>
              <button
                class="icon-btn icon-btn-gap"
                classList={{active: showAutoCheck()}}
                disabled={busy()}
                title="Auto-check on a timer"
                onClick={() => setShowAutoCheck(v => !v)}
              >
                <IoTimeSharp />
                &nbsp;Auto-check
              </button>
            </div>
            <Show when={index() !== null}>
              <p class="scan-progress">
                Checking index <strong>{index()}</strong>
              </p>
            </Show>
            <IndexMap label="Address notes" cells={cells()} current={index()} />
            <Show when={showAutoCheck()}>
              <p class="bearer-label">Auto-check every</p>
              <div class="btns">
                <For each={ADDRESS_SCAN_OPTIONS}>
                  {option => (
                    <button
                      type="button"
                      classList={{
                        active: (addr().autoScanMinutes ?? 0) === option
                      }}
                      onClick={() => setAutoCheck(addr(), option)}
                    >
                      {ADDRESS_SCAN_LABEL[option]}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </>
        )}
      </Show>
    </Dialog>
  )
}
export default AddressScanDialog
