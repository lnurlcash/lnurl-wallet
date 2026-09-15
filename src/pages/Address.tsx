import type {Component} from 'solid-js'
import {For, Show, createSignal} from 'solid-js'
import {A} from '@solidjs/router'
import {IoSearchSharp, IoRefreshSharp, IoTrashSharp} from 'solid-icons/io'

import Dialog from '../components/Dialog'
import {useWallet} from '../WalletContext'
import {offlineMode} from '../offlineMode'
import {notify, NotifyKind} from '../helpers'
import {msatToSats} from '../helpers'
import {serverOf, unregisterUsername} from '../lnurlcash'
import {cashAddressSecretAtIndex, hasCashRoot} from '../cashSecrets'
import {
  registeredAddresses,
  removeRegisteredAddress,
  type RegisteredAddress
} from '../addressRegistry'
import {scanRegisteredAddress} from '../addressRecovery'

// LUD-25 Part 2's cx1 registration (see 25.md's Seed & derivation) - lets a
// holder claim username@mint as an ordinary Lightning Address that mints
// straight onto a key only this wallet can derive, with no invoice
// request or online wallet needed at receive time at all. Registration
// itself is first-come-first-served - proving branch ownership (see
// addresses.ts's own comment on registerUsername) only ever stops a
// stranger from squatting a name pointing at someone ELSE's branch, never
// establishes any claim over funds: cx1 is watch-only, it can never spend,
// so a squatted name only ever costs the real owner a name, never funds.
const Address: Component = () => {
  const {state, bearers, addBearer, logActivity} = useWallet()
  const [scanningServer, setScanningServer] = createSignal<string | null>(null)
  const [confirmDelete, setConfirmDelete] =
    createSignal<RegisteredAddress | null>(null)
  const [unregistering, setUnregistering] = createSignal(false)

  const unregister = async (addr: RegisteredAddress) => {
    const proofKey = cashAddressSecretAtIndex(addr.server, 0)
    if (!proofKey) {
      notify(
        'No seed-derived key is loaded for this wallet - restore or re-enter your seed first.',
        NotifyKind.ERROR
      )
      return
    }
    setUnregistering(true)
    try {
      await unregisterUsername(addr.server, addr.username, proofKey)
      removeRegisteredAddress(addr.server, addr.username)
      setConfirmDelete(null)
      notify(
        `Freed ${addr.username}@${serverOf(addr.server)}.`,
        NotifyKind.SUCCESS
      )
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setUnregistering(false)
    }
  }

  const scan = async (addr: RegisteredAddress) => {
    if (scanningServer()) return
    setScanningServer(addr.server)
    try {
      const result = await scanRegisteredAddress(
        addr.server,
        addr.username,
        bearers()
      )
      for (const note of result.recovered) {
        await addBearer(note)
        logActivity(
          'recovered',
          `Received ${msatToSats(note.amount)} sats at ${addr.username}@${serverOf(addr.server)}.`
        )
      }
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
      setScanningServer(null)
    }
  }

  return (
    <div id="address" class="page">
      <Show when={confirmDelete()}>
        {addr => (
          <Dialog onClose={() => setConfirmDelete(null)}>
            <>
              <h4>Unregister this address</h4>
              <p class="warning">
                Unregister {addr().username}@{serverOf(addr().server)}? This
                frees the username at the mint - since claiming is
                first-come-first-served, anyone else can claim it the moment
                it's free, and you will not be able to reclaim it yourself
                unless you register it again before they do.
              </p>
              <div class="btns">
                <button
                  disabled={
                    unregistering() || offlineMode() || state() !== 'unlocked'
                  }
                  onClick={() => unregister(addr())}
                >
                  <Show when={unregistering()} fallback={<IoTrashSharp />}>
                    <IoRefreshSharp class="spin" />
                  </Show>
                  &nbsp;Unregister
                </button>
                <button
                  disabled={unregistering()}
                  onClick={() => setConfirmDelete(null)}
                >
                  Cancel
                </button>
              </div>
            </>
          </Dialog>
        )}
      </Show>
      <h2>Address</h2>
      <p>
        A claimed username at a trusted mint can be paid directly as{' '}
        <code>username@mint</code>, with no note attached on the payer's end -
        the mint mints a fresh note straight onto a key only this wallet can
        derive, and this page is where you come back to check for what arrived.
        Claim one from a mint's own card on the <A href="/mint">Mint page</A>.
      </p>
      <h3>Your addresses</h3>
      <Show
        when={registeredAddresses().length > 0}
        fallback={<p>Nothing claimed yet.</p>}
      >
        <div class="mint-list">
          <For each={registeredAddresses()}>
            {addr => (
              <figure class="mint-card">
                <h4>
                  {addr.username}@{serverOf(addr.server)}
                </h4>
                <p class="mint-date">
                  registered {new Date(addr.registeredAt).toLocaleDateString()}
                </p>
                <div class="btns">
                  <button
                    disabled={
                      offlineMode() ||
                      state() !== 'unlocked' ||
                      !hasCashRoot() ||
                      scanningServer() !== null
                    }
                    onClick={() => scan(addr)}
                  >
                    <Show
                      when={scanningServer() === addr.server}
                      fallback={<IoSearchSharp />}
                    >
                      <IoRefreshSharp class="spin" />
                    </Show>
                    &nbsp;Check for new notes
                  </button>
                  <button
                    class="icon-btn icon-btn-gap"
                    title="Unregister this address - frees the username at the mint"
                    onClick={() => setConfirmDelete(addr)}
                  >
                    <IoTrashSharp />
                  </button>
                </div>
              </figure>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
export default Address
