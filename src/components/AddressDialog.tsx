import type {Component} from 'solid-js'
import {For, Show, createMemo, createSignal} from 'solid-js'
import {
  IoAtCircleSharp,
  IoRefreshSharp,
  IoTrashSharp,
  IoCopySharp,
  IoEyeOffSharp,
  IoCloseSharp
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
import {addressBranch, addressProofKey} from '../cashSecrets'
import {
  registeredAddresses,
  addRegisteredAddress,
  nextAddressSlot,
  removeRegisteredAddress,
  forgetRegisteredAddress,
  forgottenAddresses,
  dismissForgottenAddress,
  type RegisteredAddress
} from '../addressRegistry'
import {isValidNpub} from '../nostrAddress'
import {
  checkAddressOwnership,
  resolveAddressOwnership,
  type AddressOwnership
} from '../addressRecovery'

// why an unclaim failed, once checkAddressOwnership has looked - 'ours'
// and 'unknown' get no extra text (the mint's own error already says it)
const OWNERSHIP_PROBLEM: Partial<Record<AddressOwnership, string>> = {
  'not-ours':
    "The mint has this name registered to a different key than this wallet's seed derives - claimed under another seed or an older wallet version, or re-claimed by someone else. This wallet can't unclaim it, and can't find notes paid to it.",
  unregistered:
    'The mint no longer knows this name at all - it was already freed (or the mint was reset).'
}

export type AddressDialogProps = {
  server: string
  // the registered address to manage - omitted to claim a new one
  username?: string
  onClose: () => void
}

// LUD-25's cx1 registration (see 25.md's Seed & derivation) AND
// managing an already-claimed one - npub, unclaiming - scoped to one mint
// at a time and opened from that mint's card on the Address page. A mint
// can hold many addresses: each new claim registers its own HD-child
// branch (cashSecrets.ts's FIRST_ADDRESS_SLOT/addressBranch), so they never
// share keys or a note counter.
// Address IDENTITY only: checking for new notes, and the auto-check
// scheduler that triggers that automatically, live in the sibling
// AddressScanDialog, opened from its own button on the same card.
const AddressDialog: Component<AddressDialogProps> = props => {
  const {state} = useWallet()
  // set once a claim from this dialog succeeds, so it re-renders straight
  // into the manage view for that address instead of closing
  const [claimedName, setClaimedName] = createSignal<string | null>(null)
  const registered = createMemo(() => {
    const name = props.username ?? claimedName()
    return registeredAddresses().find(
      a => a.server === props.server && a.username === name
    )
  })

  // ---- claim (no registration yet) ----
  const [username, setUsername] = createSignal('')
  const [npub, setNpub] = createSignal('')
  const [claiming, setClaiming] = createSignal(false)
  const forgottenHere = createMemo(() =>
    forgottenAddresses().filter(a => a.server === props.server)
  )

  // `reclaimName`: one of forgottenHere()'s names, claimed straight from
  // its own button instead of the username field
  const claim = async (reclaimName?: string) => {
    const name = (reclaimName ?? username()).trim().toLowerCase()
    if (!name) {
      notify('Enter a username.', NotifyKind.ERROR)
      return
    }
    const npubValue = reclaimName ? '' : npub().trim()
    if (npubValue && !isValidNpub(npubValue)) {
      notify('Not a valid npub.', NotifyKind.ERROR)
      return
    }
    // addressBranch/addressProofKey derive under the bare host (serverOf),
    // never props.server's own full origin directly - see src/lib/urls.ts's
    // serverOf for why a seed-derived branch must not fragment across
    // schemes/ports the way a signing-key pin legitimately does
    const host = serverOf(props.server)
    if (!addressBranch(host)) {
      notify(
        'No seed-derived key is loaded for this wallet - restore or re-enter your seed first.',
        NotifyKind.ERROR
      )
      return
    }
    setClaiming(true)
    try {
      // a name the mint already has on THIS wallet's branch (forgotten on
      // this device, or claimed from another device on the same seed) is
      // just added back locally - no POST, which would otherwise also
      // replace whatever npub is registered with it there. Only a new npub
      // still needs the round trip. A name on someone else's branch is
      // refused here with a clearer reason than the mint's own "Invalid
      // ownership signature."
      const {ownership, slot: ownedSlot} = await resolveAddressOwnership(
        props.server,
        name
      )
      if (ownership === 'not-ours') {
        throw new Error(
          `${name}@${serverOf(props.server)} is registered at this mint to a different key than this wallet's seed - it can't be reclaimed from here.`
        )
      }
      if (ownership === 'ours' && !npubValue) {
        addRegisteredAddress(props.server, name, undefined, ownedSlot)
        setClaimedName(name)
        notify(
          `Reclaimed ${name}@${serverOf(props.server)} - the mint still has it registered to this wallet.`,
          NotifyKind.SUCCESS
        )
        return
      }
      // re-registering one of ours (to change its npub) keeps its own
      // branch - SERVICE checks the proof against the cx1 already on file.
      // A fresh claim takes the next unused slot
      const slot =
        ownership === 'ours' ? ownedSlot : nextAddressSlot(props.server)
      const branch = addressBranch(host, slot)
      // this branch's own index-0 wallet note secret - required as this
      // request's ownership proof (see lib/signature.ts's
      // signAddressProof), even for a fresh claim: SERVICE checks it
      // against whatever's on file, or the submitted cx1 if nothing is
      const proofKey = addressProofKey(host, slot)
      if (!branch || !proofKey) {
        throw new Error(
          'No seed-derived key is loaded for this wallet - restore or re-enter your seed first.'
        )
      }
      await registerUsername(
        props.server,
        name,
        encodeCx1(branch.pubkeyXOnly, branch.chainCode),
        proofKey,
        npubValue || undefined
      )
      addRegisteredAddress(props.server, name, npubValue || undefined, slot)
      setClaimedName(name)
      notify(
        `Registered ${name}@${serverOf(props.server)}.`,
        NotifyKind.SUCCESS
      )
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setClaiming(false)
    }
  }

  // ---- manage (already registered) ----
  const [busy, setBusy] = createSignal(false)
  const [confirm, setConfirm] = createSignal<'unclaim' | 'forget' | null>(null)
  const [problem, setProblem] = createSignal<string | null>(null)

  // local bookkeeping only - nothing is sent to the mint (see
  // addressRegistry.ts's forgetRegisteredAddress). The way out when the
  // mint refuses an unclaim this wallet can never satisfy
  const forget = (addr: RegisteredAddress) => {
    forgetRegisteredAddress(addr.server, addr.username)
    notify(
      `Forgot ${addr.username}@${serverOf(addr.server)} on this device.`,
      NotifyKind.SUCCESS
    )
    props.onClose()
  }

  const unclaim = async (addr: RegisteredAddress) => {
    const proofKey = addressProofKey(serverOf(addr.server), addr.slot)
    if (!proofKey) {
      notify(
        'No seed-derived key is loaded for this wallet - restore or re-enter your seed first.',
        NotifyKind.ERROR
      )
      return
    }
    setBusy(true)
    setProblem(null)
    try {
      await unregisterUsername(addr.server, addr.username, proofKey)
      removeRegisteredAddress(addr.server, addr.username)
      setConfirm(null)
      notify(
        `Freed ${addr.username}@${serverOf(addr.server)}.`,
        NotifyKind.SUCCESS
      )
      props.onClose()
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
      const explained =
        OWNERSHIP_PROBLEM[
          await checkAddressOwnership(addr.server, addr.username)
        ]
      if (explained) {
        setProblem(explained)
        setConfirm('forget')
      }
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
            <Show when={forgottenHere().length > 0}>
              <p class="bearer-label">Forgotten on this device</p>
              <For each={forgottenHere()}>
                {f => (
                  <div class="btns">
                    <button
                      disabled={
                        claiming() || offlineMode() || state() !== 'unlocked'
                      }
                      title="Add back if the mint still has it registered to this wallet"
                      onClick={() => claim(f.username)}
                    >
                      <IoAtCircleSharp />
                      &nbsp;Reclaim {f.username}@{serverOf(f.server)}
                    </button>
                    <button
                      class="icon-btn icon-btn-gap"
                      disabled={claiming()}
                      title="Stop offering this name"
                      onClick={() =>
                        dismissForgottenAddress(f.server, f.username)
                      }
                    >
                      <IoCloseSharp />
                    </button>
                  </div>
                )}
              </For>
              <hr />
            </Show>
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
                onClick={() => claim()}
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
            <Show when={confirm() === null}>
              <div class="btns">
                <button
                  class="icon-btn"
                  disabled={busy()}
                  onClick={() => setConfirm('unclaim')}
                >
                  <IoTrashSharp />
                  &nbsp;Unclaim
                </button>
                <button
                  class="icon-btn icon-btn-gap"
                  disabled={busy()}
                  title="Remove this address from this wallet only, without contacting the mint"
                  onClick={() => setConfirm('forget')}
                >
                  <IoEyeOffSharp />
                  &nbsp;Forget on this device
                </button>
              </div>
            </Show>
            <Show when={confirm() === 'unclaim'}>
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
                <button disabled={busy()} onClick={() => setConfirm(null)}>
                  Cancel
                </button>
              </div>
            </Show>
            <Show when={confirm() === 'forget'}>
              <Show when={problem()}>
                {text => <p class="warning">{text()}</p>}
              </Show>
              <p class="warning">
                Forget {addr().username}@{serverOf(addr().server)} on this
                device? Nothing is sent to the mint - if the name is still
                registered to this wallet there, payments to it keep landing as
                notes, but this wallet stops checking for them (Rescan, and
                auto-check) until you claim it again. Notes already in your
                wallet are not affected.
              </p>
              <div class="btns">
                <button onClick={() => forget(addr())}>Yes, forget it</button>
                <button
                  onClick={() => {
                    setConfirm(null)
                    setProblem(null)
                  }}
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
