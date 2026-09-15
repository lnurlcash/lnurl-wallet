import type {Component} from 'solid-js'
import {Show, createMemo, createSignal} from 'solid-js'
import {For} from 'solid-js'
import {
  IoAtCircleSharp,
  IoRefreshSharp,
  IoSearchSharp,
  IoTrashSharp,
  IoTimeSharp,
  IoCopySharp
} from 'solid-icons/io'

import Dialog from './Dialog'
import {useWallet} from '../WalletContext'
import {offlineMode} from '../offlineMode'
import {notify, NotifyKind, copyToClipboard, msatToSats} from '../helpers'
import {
  serverOf,
  encodeCx1,
  registerUsername,
  unregisterUsername
} from '../lnurlcash'
import {
  cashAddressBranch,
  cashAddressSecretAtIndex,
  hasCashRoot
} from '../cashSecrets'
import {
  registeredAddresses,
  addRegisteredAddress,
  removeRegisteredAddress,
  setAddressAutoScan,
  ADDRESS_SCAN_OPTIONS,
  ADDRESS_SCAN_LABEL,
  type RegisteredAddress,
  type AddressScanMinutes
} from '../addressRegistry'
import {runAddressScan} from '../addressRecovery'
import {requestNotificationPermission} from '../notifications'
import {isValidNpub} from '../nostrAddress'

export type AddressDialogProps = {
  server: string
  onClose: () => void
}

// LUD-25 Part 2's cx1 registration (see 25.md's Seed & derivation) AND
// everything that follows from having one - checking for new notes,
// unclaiming, auto-check - scoped to one mint at a time and opened from
// that mint's own "@" button on the Mint page (formerly split across
// several buttons crammed directly onto the trusted-mint card - moved in
// here so the card stays readable regardless of how much a registered
// address grows).
const AddressDialog: Component<AddressDialogProps> = props => {
  const {state, bearers, addBearer, logActivity} = useWallet()
  const registered = createMemo(() =>
    registeredAddresses().find(a => a.server === props.server)
  )

  // ---- claim (no registration yet) ----
  const [username, setUsername] = createSignal('')
  const [npub, setNpub] = createSignal('')
  const [claiming, setClaiming] = createSignal(false)

  const claim = async () => {
    const name = username().trim().toLowerCase()
    if (!name) {
      notify('Enter a username.', NotifyKind.ERROR)
      return
    }
    const npubValue = npub().trim()
    if (npubValue && !isValidNpub(npubValue)) {
      notify('Not a valid npub.', NotifyKind.ERROR)
      return
    }
    const branch = cashAddressBranch(props.server)
    // this branch's own index-0 note secret - required as this request's
    // ownership proof (see lib/signature.ts's signAddressProof), even for
    // a fresh claim: SERVICE only checks it against whatever's already on
    // file, so it's harmless to always send
    const proofKey = cashAddressSecretAtIndex(props.server, 0)
    if (!branch || !proofKey) {
      notify(
        'No seed-derived key is loaded for this wallet - restore or re-enter your seed first.',
        NotifyKind.ERROR
      )
      return
    }
    setClaiming(true)
    try {
      const cx1 = encodeCx1(branch.pubkeyXOnly, branch.chainCode)
      await registerUsername(
        props.server,
        name,
        cx1,
        proofKey,
        npubValue || undefined
      )
      addRegisteredAddress(props.server, name, npubValue || undefined)
      notify(
        `Registered ${name}@${serverOf(props.server)}.`,
        NotifyKind.SUCCESS
      )
      // stays open - registered() flips truthy now, so this same dialog
      // re-renders straight into the manage view below instead of closing
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setClaiming(false)
    }
  }

  // ---- manage (already registered) ----
  const [busy, setBusy] = createSignal(false)
  const [confirmUnclaim, setConfirmUnclaim] = createSignal(false)
  const [showAutoCheck, setShowAutoCheck] = createSignal(false)

  // "Check notes"/"Full rescan" - the same split TODO.md asked for: "check
  // notes" resumes from wherever this address's own nextScanIndex (or
  // SERVICE's own metadata hint) left off, "full rescan" always re-walks
  // from 0. Deliberately NOT called "rescan all" here - that name is
  // already taken by the page-level bulk action above (refresh/rescan
  // every trusted mint at once), and reusing it on a per-address action
  // read as a confusing duplicate of that button.
  const checkNotes = async (mode: 'incremental' | 'all') => {
    const addr = registered()
    if (!addr || busy()) return
    setBusy(true)
    try {
      const result = await runAddressScan(
        addr.server,
        addr.username,
        bearers(),
        {addBearer, logActivity},
        {startIndex: mode === 'incremental' ? (addr.nextScanIndex ?? 0) : 0}
      )
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
    }
  }

  const unclaim = async (addr: RegisteredAddress) => {
    const proofKey = cashAddressSecretAtIndex(addr.server, 0)
    if (!proofKey) {
      notify(
        'No seed-derived key is loaded for this wallet - restore or re-enter your seed first.',
        NotifyKind.ERROR
      )
      return
    }
    setBusy(true)
    try {
      await unregisterUsername(addr.server, addr.username, proofKey)
      removeRegisteredAddress(addr.server, addr.username)
      setConfirmUnclaim(false)
      notify(
        `Freed ${addr.username}@${serverOf(addr.server)}.`,
        NotifyKind.SUCCESS
      )
      props.onClose()
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

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

  return (
    <Dialog onClose={props.onClose}>
      <Show
        when={registered()}
        fallback={
          <>
            <h4>
              <IoAtCircleSharp />
              &nbsp;Claim an address at {serverOf(props.server)}
            </h4>
            <p>
              First-come-first-served - claiming proves nothing about who you
              are, and costs nothing but the name if someone else claims it
              first. Your funds are never at risk either way: only this wallet's
              own seed can ever derive spendable notes from it.
            </p>
            <label>Username</label>
            <input
              type="text"
              placeholder="alice"
              value={username()}
              onInput={e => setUsername(e.currentTarget.value)}
            />
            <label>Nostr npub (optional)</label>
            <input
              type="text"
              placeholder="npub1..."
              value={npub()}
              onInput={e => setNpub(e.currentTarget.value)}
            />
            <p class="bearer-hint">
              If you give an npub, this mint will also serve{' '}
              {username().trim().toLowerCase() || 'username'}@
              {serverOf(props.server)} as a NIP-05 identity for it (
              <code>.well-known/nostr.json</code>) - anyone can look up that
              npub by this same address.
            </p>
            <div class="btns">
              <button
                disabled={claiming() || offlineMode() || state() !== 'unlocked'}
                onClick={claim}
              >
                <Show when={claiming()} fallback={<IoAtCircleSharp />}>
                  <IoRefreshSharp class="spin" />
                </Show>
                &nbsp;Claim
              </button>
              <button disabled={claiming()} onClick={props.onClose}>
                Cancel
              </button>
            </div>
          </>
        }
      >
        {addr => (
          <>
            <h4>
              <IoAtCircleSharp />
              &nbsp;{addr().username}@{serverOf(addr().server)}
            </h4>
            <Show when={addr().npub}>
              {npubValue => (
                <p class="address-npub">
                  Nostr: <code>{npubValue()}</code>
                  <button
                    class="icon-btn icon-btn-gap"
                    title="Copy npub"
                    onClick={() => copyToClipboard(npubValue())}
                  >
                    <IoCopySharp />
                  </button>
                </p>
              )}
            </Show>
            <p class="mint-date">
              registered {new Date(addr().registeredAt).toLocaleDateString()}
            </p>
            <div class="btns">
              <button
                disabled={offlineMode() || !hasCashRoot() || busy()}
                title={
                  offlineMode()
                    ? 'Offline mode is on'
                    : `Check ${addr().username}@${serverOf(addr().server)} for new notes, resuming from where the last check left off`
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
              </button>
              <button
                class="icon-btn icon-btn-gap"
                classList={{active: showAutoCheck()}}
                disabled={busy()}
                title="Auto-check on a timer"
                onClick={() => setShowAutoCheck(v => !v)}
              >
                <IoTimeSharp />
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
            <Show
              when={confirmUnclaim()}
              fallback={
                <div class="btns">
                  <button
                    class="icon-btn"
                    disabled={busy()}
                    onClick={() => setConfirmUnclaim(true)}
                  >
                    <IoTrashSharp />
                    &nbsp;Unclaim
                  </button>
                  <button disabled={busy()} onClick={props.onClose}>
                    Close
                  </button>
                </div>
              }
            >
              <p class="warning">
                Unclaim {addr().username}@{serverOf(addr().server)}? This frees
                the username at the mint - since claiming is
                first-come-first-served, anyone else can claim it the moment
                it's free, and you will not be able to reclaim it yourself
                unless you register it again before they do.
              </p>
              <div class="btns">
                <button disabled={busy()} onClick={() => unclaim(addr())}>
                  <Show when={busy()}>
                    <IoRefreshSharp class="spin" />
                    &nbsp;
                  </Show>
                  Yes, unclaim
                </button>
                <button
                  disabled={busy()}
                  onClick={() => setConfirmUnclaim(false)}
                >
                  Cancel
                </button>
              </div>
            </Show>
          </>
        )}
      </Show>
    </Dialog>
  )
}
export default AddressDialog
