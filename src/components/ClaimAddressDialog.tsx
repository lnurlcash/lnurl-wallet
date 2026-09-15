import type {Component} from 'solid-js'
import {Show, createSignal} from 'solid-js'
import {IoAtCircleSharp, IoRefreshSharp} from 'solid-icons/io'

import Dialog from './Dialog'
import {useWallet} from '../WalletContext'
import {offlineMode} from '../offlineMode'
import {notify, NotifyKind} from '../helpers'
import {serverOf, encodeCx1, registerUsername} from '../lnurlcash'
import {cashAddressBranch, cashAddressSecretAtIndex} from '../cashSecrets'
import {addRegisteredAddress} from '../addressRegistry'
import {isValidNpub} from '../nostrAddress'

export type ClaimAddressDialogProps = {
  server: string
  onClose: () => void
}

// LUD-25 Part 2's cx1 registration (see 25.md's Seed & derivation),
// scoped to one mint at a time - opened from that mint's own "Claim
// address" button on the Mint page, so there's no mint-picker here, the
// trigger already named which one.
const ClaimAddressDialog: Component<ClaimAddressDialogProps> = props => {
  const {state} = useWallet()
  const [username, setUsername] = createSignal('')
  const [npub, setNpub] = createSignal('')
  const [busy, setBusy] = createSignal(false)

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
    setBusy(true)
    try {
      const cx1 = encodeCx1(branch.pubkeyXOnly, branch.chainCode)
      await registerUsername(
        props.server,
        name,
        cx1,
        proofKey,
        npubValue || undefined
      )
      addRegisteredAddress(props.server, name)
      notify(
        `Registered ${name}@${serverOf(props.server)}.`,
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
      <>
        <h4>
          <IoAtCircleSharp />
          &nbsp;Claim an address at {serverOf(props.server)}
        </h4>
        <p>
          First-come-first-served - claiming proves nothing about who you are,
          and costs nothing but the name if someone else claims it first. Your
          funds are never at risk either way: only this wallet's own seed can
          ever derive spendable notes from it.
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
          <code>.well-known/nostr.json</code>) - anyone can look up that npub by
          this same address.
        </p>
        <div class="btns">
          <button
            disabled={busy() || offlineMode() || state() !== 'unlocked'}
            onClick={claim}
          >
            <Show when={busy()} fallback={<IoAtCircleSharp />}>
              <IoRefreshSharp class="spin" />
            </Show>
            &nbsp;Claim
          </button>
          <button disabled={busy()} onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </>
    </Dialog>
  )
}
export default ClaimAddressDialog
