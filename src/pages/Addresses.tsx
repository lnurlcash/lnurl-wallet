import type {Component} from 'solid-js'
import {For, Show, createSignal} from 'solid-js'
import {
  IoAtCircleSharp,
  IoSearchSharp,
  IoRefreshSharp,
  IoTrashSharp
} from 'solid-icons/io'

import {useWallet} from '../WalletContext'
import {offlineMode} from '../offlineMode'
import {notify, NotifyKind} from '../helpers'
import {msatToSats} from '../helpers'
import {serverOf, encodeCx1, registerUsername} from '../lnurlcash'
import {trustedMints} from '../trustedMints'
import {cashAddressBranch, hasCashRoot} from '../cashSecrets'
import {
  registeredAddresses,
  addRegisteredAddress,
  removeRegisteredAddress,
  type RegisteredAddress
} from '../addressRegistry'
import {scanRegisteredAddress} from '../addressRecovery'

// LUD-25 Part 2's cx1 registration (see 25.md's Seed & derivation) - lets a
// holder claim username@mint as an ordinary Lightning Address that mints
// straight onto a key only this wallet can derive, with no invoice
// request or online wallet needed at receive time at all. Registration
// itself is first-come-first-served and proves nothing (cx1 is watch-only -
// it can never spend), so a squatted name only ever costs the real owner a
// name, never funds - see addresses.ts's own comment.
const Addresses: Component = () => {
  const {state, bearers, addBearer, logActivity} = useWallet()
  const [selectedServer, setSelectedServer] = createSignal<string | null>(null)
  const [username, setUsername] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [scanningServer, setScanningServer] = createSignal<string | null>(null)

  const register = async () => {
    const server = selectedServer()
    if (!server) {
      notify('Pick a trusted mint first.', NotifyKind.ERROR)
      return
    }
    const name = username().trim().toLowerCase()
    if (!name) {
      notify('Enter a username.', NotifyKind.ERROR)
      return
    }
    const branch = cashAddressBranch(server)
    if (!branch) {
      notify(
        'No seed-derived key is loaded for this wallet - restore or re-enter your seed first.',
        NotifyKind.ERROR
      )
      return
    }
    setBusy(true)
    try {
      const cx1 = encodeCx1(branch.pubkeyXOnly, branch.chainCode)
      await registerUsername(server, name, cx1)
      addRegisteredAddress(server, name)
      notify(`Registered ${name}@${serverOf(server)}.`, NotifyKind.SUCCESS)
      setUsername('')
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
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
    <div id="addresses" class="page">
      <h2>Addresses</h2>
      <p>
        Claim a username at a trusted mint so it can be paid directly as{' '}
        <code>username@mint</code>. Once claimed, paying it needs no note
        attached on the payer's end - the mint mints a fresh note straight onto
        a key only this wallet can derive, and this page is where you come back
        to check for what arrived.
      </p>
      <div class="two-columns">
        <div class="two-col">
          <div class="setup-card">
            <h4>
              <IoAtCircleSharp />
              &nbsp;Claim a username
            </h4>
            <p>
              First-come-first-served, per mint - claiming proves nothing about
              who you are, and costs nothing but the name if someone else claims
              it first. Your funds are never at risk either way: only this
              wallet's own seed can ever derive spendable notes from it.
            </p>
            <label>Mint</label>
            <div class="mint-picker">
              <For each={trustedMints()}>
                {mint => (
                  <span class="mint-picker-entry">
                    <button
                      type="button"
                      classList={{active: selectedServer() === mint.server}}
                      onClick={() => setSelectedServer(mint.server)}
                    >
                      {serverOf(mint.server)}
                    </button>
                  </span>
                )}
              </For>
            </div>
            <Show when={trustedMints().length === 0}>
              <p class="warning">
                No trusted mints yet - add one on the Mint page first.
              </p>
            </Show>
            <label>Username</label>
            <input
              type="text"
              placeholder="alice"
              value={username()}
              onInput={e => setUsername(e.currentTarget.value)}
            />
            <div class="btns">
              <button
                disabled={busy() || offlineMode() || state() !== 'unlocked'}
                onClick={register}
              >
                <Show when={busy()} fallback={<IoAtCircleSharp />}>
                  <IoRefreshSharp class="spin" />
                </Show>
                &nbsp;Claim
              </button>
            </div>
          </div>
        </div>
        <div class="two-col">
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
                      registered{' '}
                      {new Date(addr.registeredAt).toLocaleDateString()}
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
                        title="Forget this address on this device - does not un-claim it at the mint"
                        onClick={() =>
                          removeRegisteredAddress(addr.server, addr.username)
                        }
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
      </div>
    </div>
  )
}
export default Addresses
