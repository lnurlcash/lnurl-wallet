import type {Component} from 'solid-js'
import {Show, For, createMemo, createSignal} from 'solid-js'
import {IoRefreshSharp, IoSearchSharp, IoTimeSharp} from 'solid-icons/io'

import Dialog from './Dialog'
import {useWallet} from '../WalletContext'
import {offlineMode} from '../offlineMode'
import {notify, NotifyKind, msatToSats} from '../helpers'
import {serverOf} from '../lnurlcash'
import {hasCashRoot, mergeCashAddressSecretIndices} from '../cashSecrets'
import {
  registeredAddresses,
  setAddressAutoScan,
  ADDRESS_SCAN_OPTIONS,
  ADDRESS_SCAN_LABEL,
  type RegisteredAddress,
  type AddressScanMinutes
} from '../addressRegistry'
import {runAddressScan} from '../addressRecovery'
import {scanMintForNotes} from '../recovery'
import {requestNotificationPermission} from '../notifications'

export type RescanDialogProps = {
  server: string
  onClose: () => void
}

// LUD-25 recovery, split out of AddressDialog: rescanning is exactly the
// same seed-derived-branch walk (cashSecrets.ts's cashAddressBranch)
// whether or not this wallet has claimed a username@mint address here -
// what differs is only whether SERVICE has a next-index hint to offer
// (LUD-25 Part 2's text/xpub metadata, registered-address-only). So this
// dialog always offers the plain mint-bearer rescan (recovery.ts's
// scanMintForNotes - notes this wallet minted/rotated/split/merged
// directly here), and additionally offers the address-aware one
// (addressRecovery.ts's scanRegisteredAddress, which also consults and
// shows that hint) whenever an address happens to be registered. Opened
// from its own button on the trusted-mint card, independent of the "@"
// address button (AddressDialog) - claiming an address and recovering
// funds are two different jobs that don't need to share a dialog, or a
// disabled state, with each other.
//
// NOTE: today these two scans still walk two DIFFERENT branches for
// historical reasons - the mint-bearer one derives its domain via
// serverOf() (bare host), the address-aware one via the full origin
// (props.server) - see addressRecovery.ts's own cashAddressBranch callers
// vs recovery.ts's. Unifying that key space (so a note minted directly
// here and a registered address's own notes always live on one branch)
// would need src/lib/request.ts's generatePubkeySecret to also switch
// conventions, which is a real, separate, higher-stakes migration - not
// something to fold into a UI split. Until then, both sections here are
// kept and run independently so neither history goes unchecked.
const RescanDialog: Component<RescanDialogProps> = props => {
  const {bearers, addBearer, logActivity} = useWallet()
  const registered = createMemo(() =>
    registeredAddresses().find(a => a.server === props.server)
  )

  // ---- mint-bearer rescan (always available, address or not) ----
  const [mintBusy, setMintBusy] = createSignal(false)
  const [mintIndex, setMintIndex] = createSignal(0)

  const rescanMintBearerNotes = async () => {
    if (mintBusy()) return
    setMintBusy(true)
    setMintIndex(0)
    try {
      // scanMintForNotes resolves input the same narrow way resolveMintInput
      // does (bech32/Lightning Address/bare domain) - props.server is the
      // full https://... origin (see serviceOriginOf), which that parser
      // rejects outright, so this needs the bare host serverOf() strips it
      // down to
      const result = await scanMintForNotes(
        serverOf(props.server),
        index => setMintIndex(index),
        bearers()
      )
      for (const note of result.recovered) {
        await addBearer(note)
        logActivity(
          'recovered',
          `Recovered ${msatToSats(note.amount)} sats from ${result.server} while rescanning.`
        )
      }
      if (result.highestUsedIndex !== null) {
        mergeCashAddressSecretIndices({
          [result.server]: result.highestUsedIndex + 1
        })
      }
      if (result.error) {
        notify(result.error, NotifyKind.ERROR)
      } else {
        notify(
          result.recovered.length > 0
            ? `Recovered ${result.recovered.length} note${result.recovered.length === 1 ? '' : 's'} (${msatToSats(result.recovered.reduce((sum, n) => sum + n.amount, 0))} sats).`
            : 'No missing notes found at this mint.',
          NotifyKind.SUCCESS
        )
      }
    } finally {
      setMintBusy(false)
    }
  }

  // ---- address-aware rescan (only when a username is registered here) ----
  const [addrBusy, setAddrBusy] = createSignal(false)
  const [showAutoCheck, setShowAutoCheck] = createSignal(false)

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
  // "full rescan" always re-walks from 0.
  const checkNotes = async (mode: 'incremental' | 'all') => {
    const addr = registered()
    if (!addr || addrBusy()) return
    setAddrBusy(true)
    try {
      const result = await runAddressScan(
        addr.server,
        addr.username,
        bearers(),
        {addBearer, logActivity},
        {startIndex: mode === 'incremental' ? (addr.nextScanIndex ?? 0) : 0}
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
      setAddrBusy(false)
    }
  }

  return (
    <Dialog onClose={props.onClose}>
      <h4>
        <IoSearchSharp />
        &nbsp;Rescan {serverOf(props.server)}
      </h4>
      <p class="bearer-label">This mint's own bearer notes</p>
      <p class="bearer-hint">
        Notes this wallet minted/rotated/split/merged directly here - lost
        locally on this device, a sync gap, or after a seed restore.
      </p>
      <div class="btns">
        <button
          disabled={offlineMode() || !hasCashRoot() || mintBusy()}
          title={
            offlineMode()
              ? 'Offline mode is on'
              : !hasCashRoot()
                ? 'No seed loaded for this wallet - restore your seed again first'
                : 'Rescan this mint for seed-derived notes missing from this wallet (LUD-25)'
          }
          onClick={rescanMintBearerNotes}
        >
          <Show when={mintBusy()} fallback={<IoSearchSharp />}>
            <IoRefreshSharp class="spin" />
          </Show>
          &nbsp;Rescan
        </button>
      </div>
      <Show when={mintBusy()}>
        <p class="bearer-hint">checking index {mintIndex()}...</p>
      </Show>
      <Show when={registered()}>
        {addr => (
          <>
            <hr />
            <p class="bearer-label">
              {addr().username}@{serverOf(addr().server)}'s registered notes
            </p>
            <p class="bearer-hint">
              Last index this device checked: {addr().nextScanIndex ?? 0}
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
            <div class="btns">
              <button
                disabled={offlineMode() || !hasCashRoot() || addrBusy()}
                title={
                  offlineMode()
                    ? 'Offline mode is on'
                    : `Check ${addr().username}@${serverOf(addr().server)} for new notes, resuming from where the last check left off`
                }
                onClick={() => checkNotes('incremental')}
              >
                <Show when={addrBusy()} fallback={<IoSearchSharp />}>
                  <IoRefreshSharp class="spin" />
                </Show>
                &nbsp;Check notes
              </button>
              <button
                class="icon-btn icon-btn-gap"
                disabled={offlineMode() || !hasCashRoot() || addrBusy()}
                title="Full rescan - re-walk every index from 0, ignoring what's already been checked"
                onClick={() => checkNotes('all')}
              >
                <IoRefreshSharp />
                &nbsp;Full rescan
              </button>
              <button
                class="icon-btn icon-btn-gap"
                classList={{active: showAutoCheck()}}
                disabled={addrBusy()}
                title="Auto-check on a timer"
                onClick={() => setShowAutoCheck(v => !v)}
              >
                <IoTimeSharp />
                &nbsp;Auto-check
              </button>
            </div>
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
export default RescanDialog
