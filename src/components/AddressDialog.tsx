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
import {notify, NotifyKind, copyToClipboard, msatToSats} from '../helpers'
import Qr from './Qr'
import {
  serverOf,
  registerUsername,
  updateUsername,
  unregisterUsername,
  decodeBolt11AmountMsat,
  ServiceError
} from '../lnurlcash'
import {
  hasCashRoot,
  addressShareCx1,
  addressShareKey,
  legacyAddressProofKey
} from '../cashSecrets'
import {
  registeredAddresses,
  addRegisteredAddress,
  nextAddressShare,
  skipAddressShare,
  moveRegisteredAddress,
  addressKeyOf,
  removeRegisteredAddress,
  forgetRegisteredAddress,
  forgottenAddresses,
  dismissForgottenAddress,
  type AddressKey,
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
    "The mint has this name registered to a different key than this wallet's seed derives - claimed under another seed, or re-claimed by someone else. This wallet can't unclaim it, and can't find notes paid to it.",
  unregistered:
    'The mint no longer knows this name at all - it was already freed (or the mint was reset).'
}

export type AddressDialogProps = {
  server: string
  // the registered address to manage - omitted to claim a new one
  username?: string
  onClose: () => void
}

const NO_SEED =
  'No seed-derived key is loaded for this wallet - restore or re-enter your seed first.'

// the key a registration's proofs are signed with - see cashSecrets.ts
const proofKeyOf = (host: string, key: AddressKey): Uint8Array | null =>
  key.kind === 'share'
    ? addressShareKey(host, key.share)
    : legacyAddressProofKey(host, key.slot)

// how many shares a claim moves past when the mint says one was used
// already (from another device on the same seed)
const SHARE_ATTEMPTS = 20

// LUD-26 Lightning Address registration AND managing an already-claimed
// one - npub, moving, unclaiming - scoped to one mint at a time and opened
// from that mint's card on the Address page. A mint can hold many
// addresses: each claim registers a fresh share S/0'/2/n'
// (cashSecrets.ts's addressShareCx1), so they never share keys or a note
// counter. A name registered before LUD-26 keeps working the old way until
// it is moved to a share ("Move to a new key").
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

  // LUD-26 address fee: the invoice a registration answered with. The name
  // is held for this wallet's share and starts working once it is paid.
  const [feeInvoice, setFeeInvoice] = createSignal<string | null>(null)

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
    const host = serverOf(props.server)
    if (!hasCashRoot()) {
      notify(NO_SEED, NotifyKind.ERROR)
      return
    }
    setClaiming(true)
    try {
      // a name this device recorded the key of (forgotten here) is just
      // added back locally when the mint still has it - no request that
      // could touch it. A new npub moves it to a fresh share (a PUT
      // carrying the npub), since a POST never overwrites a registration.
      const {ownership, key} = await resolveAddressOwnership(props.server, name)
      if (ownership === 'ours' && key) {
        if (npubValue) {
          await moveTo(name, key, npubValue)
        } else {
          addRegisteredAddress(
            props.server,
            name,
            undefined,
            key.kind === 'share' ? key.share : undefined,
            key.kind === 'legacy' ? key.slot : undefined
          )
        }
        setClaimedName(name)
        notify(
          `Reclaimed ${name}@${serverOf(props.server)} - the mint still has it registered to this wallet.`,
          NotifyKind.SUCCESS
        )
        return
      }
      // a fresh claim takes the next unused share - moving past any the
      // mint has seen already (claimed from another device on this seed)
      let share = nextAddressShare(props.server)
      for (let attempt = 0; ; attempt++) {
        const cx1 = addressShareCx1(host, share)
        const shareKey = addressShareKey(host, share)
        if (!cx1 || !shareKey) throw new Error(NO_SEED)
        try {
          const {pr} = await registerUsername(
            props.server,
            name,
            cx1,
            shareKey,
            npubValue || undefined
          )
          // a mint charging an address fee holds the name for this share
          // until its invoice is paid - shown below, once recorded
          if (pr) setFeeInvoice(pr)
          break
        } catch (err) {
          skipAddressShare(props.server, share)
          if (
            attempt < SHARE_ATTEMPTS &&
            err instanceof ServiceError &&
            /cx1 already used/i.test(err.reason)
          ) {
            share++
            continue
          }
          throw err
        }
      }
      addRegisteredAddress(props.server, name, npubValue || undefined, share)
      setClaimedName(name)
      notify(
        feeInvoice()
          ? `${name}@${serverOf(props.server)} is held for you - pay the registration fee to activate it.`
          : `Registered ${name}@${serverOf(props.server)}.`,
        NotifyKind.SUCCESS
      )
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setClaiming(false)
    }
  }

  // LUD-26's PUT: moves `name` from the key on file to a fresh share,
  // never freeing it - how a pre-LUD-26 registration gets onto a share, and
  // how a new npub is sent. Notes credited to the old key stay there; a
  // full rescan sweeps them (addressRecovery.ts's runAddressScan).
  const moveTo = async (name: string, current: AddressKey, npub?: string) => {
    const host = serverOf(props.server)
    const currentKey = proofKeyOf(host, current)
    if (!currentKey) throw new Error(NO_SEED)
    let share = nextAddressShare(props.server)
    for (let attempt = 0; ; attempt++) {
      const cx1 = addressShareCx1(host, share)
      const shareKey = addressShareKey(host, share)
      if (!cx1 || !shareKey) throw new Error(NO_SEED)
      try {
        await updateUsername(
          props.server,
          name,
          currentKey,
          cx1,
          shareKey,
          npub
        )
        break
      } catch (err) {
        skipAddressShare(props.server, share)
        if (
          attempt < SHARE_ATTEMPTS &&
          err instanceof ServiceError &&
          /cx1 already used/i.test(err.reason)
        ) {
          share++
          continue
        }
        throw err
      }
    }
    if (
      !registeredAddresses().some(
        a => a.server === props.server && a.username === name
      )
    ) {
      addRegisteredAddress(
        props.server,
        name,
        undefined,
        current.kind === 'share' ? current.share : undefined,
        current.kind === 'legacy' ? current.slot : undefined
      )
    }
    moveRegisteredAddress(props.server, name, share)
    if (npub) addRegisteredAddress(props.server, name, npub, share)
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

  const move = async (addr: RegisteredAddress) => {
    setBusy(true)
    try {
      await moveTo(addr.username, addressKeyOf(addr), addr.npub)
      notify(
        `Moved ${addr.username}@${serverOf(addr.server)} to a new key. Run a full rescan to sweep notes paid to the old one.`,
        NotifyKind.SUCCESS
      )
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  const unclaim = async (addr: RegisteredAddress) => {
    const proofKey = proofKeyOf(serverOf(addr.server), addressKeyOf(addr))
    if (!proofKey) {
      notify(NO_SEED, NotifyKind.ERROR)
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
            <Show when={feeInvoice()}>
              {pr => (
                <div class="warning">
                  <p>
                    This mint charges a fee to register an address
                    <Show when={decodeBolt11AmountMsat(pr())}>
                      {msat => <> ({msatToSats(msat())} sats)</>}
                    </Show>
                    . The name is held for you; it starts receiving once this
                    invoice is paid - from your wallet's Send, or any Lightning
                    wallet.
                  </p>
                  <Qr value={pr().toUpperCase()} />
                  <div class="btns">
                    <button onClick={() => copyToClipboard(pr())}>
                      <IoCopySharp />
                      &nbsp;Copy invoice
                    </button>
                  </div>
                </div>
              )}
            </Show>
            <Show when={addr().share === undefined}>
              <p class="warning">
                Registered before LUD-26: the mint keeps paying this address the
                old way until you move it to a new key. Moving keeps the name;
                notes already paid to it stay yours.
              </p>
            </Show>
            <Show when={confirm() === null}>
              <div class="btns">
                <Show when={addr().share === undefined}>
                  <button
                    disabled={busy() || offlineMode() || state() !== 'unlocked'}
                    onClick={() => move(addr())}
                  >
                    <Show when={busy()} fallback={<IoRefreshSharp />}>
                      <IoRefreshSharp class="spin" />
                    </Show>
                    &nbsp;Move to a new key
                  </button>
                </Show>
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
