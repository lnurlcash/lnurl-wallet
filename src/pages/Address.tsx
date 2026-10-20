import type {Component} from 'solid-js'
import {Show, For, createSignal} from 'solid-js'
import {A} from '@solidjs/router'
import {IoAtCircleSharp, IoSearchSharp} from 'solid-icons/io'

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

// LUD-25 username@mint addresses, one card per trusted mint: claiming/
// managing one (AddressDialog) and checking it for notes paid to it
// (AddressScanDialog, auto-check included). Split out of the Mint page,
// which keeps only the plain wallet/change rescan (RescanDialog) - an
// address is something a holder hands out and checks on, not part of
// managing which mints to trust.
const Address: Component = () => {
  // which mint's card opened which dialog - at most one at a time, same
  // single-flow-at-a-time convention the Mint page's own cards follow
  const [manageFor, setManageFor] = createSignal<string | null>(null)
  const [scanFor, setScanFor] = createSignal<string | null>(null)

  return (
    <RequireWallet>
      <div id="address" class="page">
        <h2>Addresses</h2>
        <Show when={manageFor()}>
          {server => (
            <AddressDialog
              server={server()}
              onClose={() => setManageFor(null)}
            />
          )}
        </Show>
        <Show when={scanFor()}>
          {server => (
            <AddressScanDialog
              server={server()}
              onClose={() => setScanFor(null)}
            />
          )}
        </Show>
        <p>
          Claim a username@mint Lightning Address at any of your trusted mints -
          payments to it land as notes only this wallet's seed can spend. Check
          an address to pick up notes paid to it; each one found is tagged with
          the address and index it was found at.
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
                // at most one registered address per mint server - a
                // device's LUD-25 registration is scoped to one seed-derived
                // branch per server (see cashSecrets.ts's cashAddressBranch)
                const registered = () =>
                  registeredAddresses().find(a => a.server === mint.server)
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
                    <Show
                      when={registered()}
                      fallback={
                        <>
                          <p class="mint-date">No address claimed here.</p>
                          <div class="btns">
                            <button
                              title="Claim a username@mint address here (LUD-25)"
                              onClick={() => setManageFor(mint.server)}
                            >
                              <IoAtCircleSharp />
                              &nbsp;Claim
                            </button>
                          </div>
                        </>
                      }
                    >
                      {addr => (
                        <>
                          <p class="mint-pubkey">
                            {addr().username}@{serverOf(addr().server)}
                          </p>
                          <p class="mint-date">
                            registered{' '}
                            {new Date(addr().registeredAt).toLocaleDateString()}
                            <br />
                            Checked up to index {addr().nextScanIndex ??
                              0} ·{' '}
                            {addr().autoScanMinutes
                              ? `auto-check every ${ADDRESS_SCAN_LABEL[addr().autoScanMinutes as AddressScanMinutes]}`
                              : 'auto-check off'}
                          </p>
                          <div class="btns">
                            <button
                              title={`Check ${addr().username}@${serverOf(addr().server)} for notes paid to it (LUD-25)`}
                              onClick={() => setScanFor(mint.server)}
                            >
                              <IoSearchSharp />
                              &nbsp;Check notes
                            </button>
                            <button
                              title={`Manage ${addr().username}@${serverOf(addr().server)} - npub, unclaim`}
                              onClick={() => setManageFor(mint.server)}
                            >
                              <IoAtCircleSharp />
                              &nbsp;Manage
                            </button>
                          </div>
                        </>
                      )}
                    </Show>
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
