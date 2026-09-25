import type {Component} from 'solid-js'
import {Show, createMemo, createSignal} from 'solid-js'
import {
  IoAtCircleSharp,
  IoRefreshSharp,
  IoTrashSharp,
  IoCopySharp
} from 'solid-icons/io'

import Dialog from './Dialog'
import {useWallet} from '../WalletContext'
import {offlineMode} from '../offlineMode'
import {notify, NotifyKind, copyToClipboard} from '../helpers'
import {
  serverOf,
  encodeCx1,
  registerUsername,
  unregisterUsername
} from '../lnurlcash'
import {cashAddressBranch, cashAddressSecretAtIndex} from '../cashSecrets'
import {
  registeredAddresses,
  addRegisteredAddress,
  removeRegisteredAddress,
  type RegisteredAddress
} from '../addressRegistry'
import {isValidNpub} from '../nostrAddress'

export type AddressDialogProps = {
  server: string
  onClose: () => void
}

// LUD-25's cx1 registration (see 25.md's Seed & derivation) AND
// managing an already-claimed one - npub, unclaiming - scoped to one mint
// at a time and opened from that mint's own "@" button on the Mint page.
// Address IDENTITY only: checking for new notes, and the auto-check
// scheduler that triggers that automatically, both live in the sibling
// RescanDialog now, opened from its own button - the two used to be
// crammed into this one dialog, which made "is there anything to scan
// here" depend on whether this wallet happened to have claimed a
// username, when in truth a rescan is exactly as meaningful (and exactly
// the same seed-derived branch, see cashSecrets.ts's cashAddressBranch)
// with or without one.
const AddressDialog: Component<AddressDialogProps> = props => {
  const {state} = useWallet()
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
    // cashAddressBranch/cashAddressSecretAtIndex derive under the bare
    // host (serverOf), never props.server's own full origin directly - see
    // src/lib/urls.ts's serverOf for why a seed-derived branch must not
    // fragment across schemes/ports the way a signing-key pin legitimately
    // does
    const branch = cashAddressBranch(serverOf(props.server))
    // this branch's own index-0 note secret - required as this request's
    // ownership proof (see lib/signature.ts's signAddressProof), even for
    // a fresh claim: SERVICE only checks it against whatever's already on
    // file, so it's harmless to always send
    const proofKey = cashAddressSecretAtIndex(serverOf(props.server), 0)
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

  const unclaim = async (addr: RegisteredAddress) => {
    const proofKey = cashAddressSecretAtIndex(serverOf(addr.server), 0)
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
