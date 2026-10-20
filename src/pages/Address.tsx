import type {Component} from 'solid-js'
import {Show, For, createSignal} from 'solid-js'
import {A} from '@solidjs/router'
import {IoAtCircleSharp, IoSearchSharp, IoAddSharp} from 'solid-icons/io'

import {serverOf} from '../lnurlcash'
import {trustedMints} from '../trustedMints'
import {
  registeredAddresses,
  ADDRESS_SCAN_LABEL,
  type AddressScanMinutes
} from '../addressRegistry'
import RequireWallet from '../components/RequireWallet'
import AddressDialog from '../components/AddressDialog'
import AddressScanDialog from '../components/AddressScanDialog'

// which address a dialog is open for - `username` omitted means claiming a
// new one at `server`
type DialogTarget = {server: string; username?: string}

// LUD-25 username@mint addresses, one card per trusted mint listing every
// address this wallet holds there: claiming/managing one (AddressDialog)
// and checking it for notes paid to it (AddressScanDialog, auto-check
// included). A mint can hold any number - each registers its own branch
// (see cashSecrets.ts's FIRST_ADDRESS_SLOT). Split out of the Mint page,
// which keeps only the plain wallet/change rescan (RescanDialog) - an
// address is something a holder hands out and checks on, not part of
// managing which mints to trust.
const Address: Component = () => {
  // at most one dialog at a time, same single-flow-at-a-time convention
  // the Mint page's own cards follow
  const [manageFor, setManageFor] = createSignal<DialogTarget | null>(null)
  const [scanFor, setScanFor] = createSignal<Required<DialogTarget> | null>(
    null
  )

  return (
    <RequireWallet>
      <div id="address" class="page">
        <h2>Addresses</h2>
        <Show when={manageFor()}>
          {target => (
            <AddressDialog
              server={target().server}
              username={target().username}
              onClose={() => setManageFor(null)}
            />
          )}
        </Show>
        <Show when={scanFor()}>
          {target => (
            <AddressScanDialog
              server={target().server}
              username={target().username}
              onClose={() => setScanFor(null)}
            />
          )}
        </Show>
        <p>
          Claim username@mint Lightning Addresses at any of your trusted mints -
          as many per mint as you like, each on its own keys. Payments to them
          land as notes only this wallet's seed can spend. Check an address to
          pick up notes paid to it; each one found is tagged with the address
          and index it was found at.
        </p>
        <Show
          when={trustedMints().length > 0}
          fallback={
            <p>
              No trusted mints yet - add one on the <A href="/mint">Mint</A>{' '}
              page first.
            </p>
          }
        >
          <div class="mint-list">
            <For each={trustedMints()}>
              {mint => {
                const addresses = () =>
                  registeredAddresses().filter(a => a.server === mint.server)
                return (
                  <figure class="mint-card">
                    <h4>
                      <Show when={mint.nodeColor}>
                        <span
                          class="mint-color-dot"
                          style={{'background-color': mint.nodeColor!}}
                        />
                      </Show>
                      {mint.nodeAlias || serverOf(mint.server)}
                    </h4>
                    <Show when={addresses().length === 0}>
                      <p class="mint-date">No address claimed here.</p>
                    </Show>
                    <For each={addresses()}>
                      {addr => (
                        <>
                          <p class="mint-pubkey">
                            {addr.username}@{serverOf(addr.server)}
                          </p>
                          <p class="mint-date">
                            registered{' '}
                            {new Date(addr.registeredAt).toLocaleDateString()}
                            <br />
                            Checked up to index {addr.nextScanIndex ?? 0} ·{' '}
                            {addr.autoScanMinutes
                              ? `auto-check every ${ADDRESS_SCAN_LABEL[addr.autoScanMinutes as AddressScanMinutes]}`
                              : 'auto-check off'}
                          </p>
                          <div class="btns">
                            <button
                              title={`Check ${addr.username}@${serverOf(addr.server)} for notes paid to it (LUD-25)`}
                              onClick={() =>
                                setScanFor({
                                  server: addr.server,
                                  username: addr.username
                                })
                              }
                            >
                              <IoSearchSharp />
                              &nbsp;Check notes
                            </button>
                            <button
                              title={`Manage ${addr.username}@${serverOf(addr.server)} - npub, unclaim`}
                              onClick={() =>
                                setManageFor({
                                  server: addr.server,
                                  username: addr.username
                                })
                              }
                            >
                              <IoAtCircleSharp />
                              &nbsp;Manage
                            </button>
                          </div>
                        </>
                      )}
                    </For>
                    <div class="btns">
                      <button
                        title="Claim a username@mint address here (LUD-25)"
                        onClick={() => setManageFor({server: mint.server})}
                      >
                        <IoAddSharp />
                        &nbsp;
                        {addresses().length === 0
                          ? 'Claim address'
                          : 'Claim another'}
                      </button>
                    </div>
                  </figure>
                )
              }}
            </For>
          </div>
        </Show>
      </div>
    </RequireWallet>
  )
}
export default Address
