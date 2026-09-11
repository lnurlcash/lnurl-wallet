import type {Component} from 'solid-js'
import {For, Show, createSignal} from 'solid-js'
import {
  IoBanSharp,
  IoDownloadSharp,
  IoPencilSharp,
  IoRefreshSharp,
  IoTrashSharp
} from 'solid-icons/io'

import {useDevice} from '../DeviceContext'
import {useWallet} from '../WalletContext'
import {adoptDeviceNote} from '../deviceOrchestration'
import type {DeviceNote, DeviceStorageState} from '../device'
import {
  approvalInstruction,
  inputWarning,
  canShowQrHandoff,
  gatedCommandsUnavailable
} from '../deviceGuidance'
import {identityWarning} from '../devicePinning'
import {msatToSats, notify, NotifyKind} from '../helpers'

// get_info's `storage` (docs/PROTOCOL.md) - only 'ok' (or absent, meaning
// this build has no persistent storage to worry about) means note_count
// can be trusted. Anything else means the device couldn't fully read its
// own notes this boot, and note_count === 0 must not be read as "empty".
const storageWarning = (
  storage: DeviceStorageState | undefined
): string | null => {
  switch (storage) {
    case 'index_unreadable':
      return "This device's note index couldn't be read this boot - its notes are still on flash, but hidden until you reboot the device. Do not wipe it: that would destroy exactly what this state exists to protect."
    case 'full':
      return "This device is out of storage - it can't create or update notes until you free some room (spend or delete existing ones)."
    case 'version_unsupported':
      return "This device's storage was written by newer firmware than it's currently running - update its firmware to read it again."
    case 'unavailable':
      return "This device's storage could not be brought up at all - its note count and note list below may be wrong or empty."
    default:
      return null
  }
}

// Pairing + read-only visibility for an LNURLvault hardware device (see
// ../../lnurl-vault) - connect over USB or Bluetooth, see its firmware
// version and the notes it holds. Routing this wallet's own rotate/split/
// merge/melt through the device instead of generating secrets in-browser
// lives in deviceOrchestration.ts, driven from Mint.tsx/BearerCard.tsx/
// MintGroupCard.tsx/Wallet.tsx/MeltDialog.tsx - this page itself stays scoped
// to pairing and read-only visibility, not those flows.
const Vault: Component = () => {
  const {
    connectionState,
    info,
    notes,
    serialSupported,
    bleSupported,
    connectSerial,
    connectBle,
    disconnect,
    reconnecting,
    identity,
    trustCurrentIdentity,
    refresh,
    rename,
    deleteNote,
    pruneSpent,
    client
  } = useDevice()
  const {bearers, addBearer, logActivity} = useWallet()

  // A note the vault holds that this browser has no record of: paired to a
  // different browser, storage cleared, a restore that predates it. Without
  // a bearer it has no card anywhere else in the wallet, so this page is the
  // only place it can be acted on at all.
  const isOrphan = (note: DeviceNote) =>
    note.state === 'confirmed' && !bearers().some(b => b.deviceId === note.id)

  const adopt = async (note: DeviceNote) => {
    const current = client()
    if (!current) return
    const adopted = await adoptDeviceNote(current, {
      id: note.id,
      h: note.h,
      host: note.host,
      amountMsat: note.amount_msat,
      signature: note.sig
    })
    await addBearer({
      url: adopted.url,
      callback: adopted.callback,
      amount: adopted.amountMsat,
      verified: true,
      mintPubkey: adopted.mintPubkey,
      deviceId: adopted.deviceId,
      deviceHash: adopted.deviceHash
    })
    logActivity(
      'transfer',
      `Adopted ${msatToSats(adopted.amountMsat)} sats from the vault into this wallet.`
    )
    notify(
      `Adopted ${msatToSats(adopted.amountMsat)} sats - it has a card on the wallet page now.`,
      NotifyKind.SUCCESS
    )
    await refresh()
  }

  const [busy, setBusy] = createSignal(false)
  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [labelInput, setLabelInput] = createSignal('')

  const spentCount = () => notes().filter(n => n.state === 'spent').length

  // one press for the lot, against one per note through the trash icons.
  // A rotate leaves its parent behind as a spent record by design, so these
  // pile up fast on a vault in use
  const clearSpent = async () => {
    const removed = await pruneSpent()
    notify(
      `Cleared ${removed} spent note${removed === 1 ? '' : 's'} from the device.`,
      NotifyKind.SUCCESS
    )
  }

  const withBusy = async (action: () => Promise<void>) => {
    setBusy(true)
    try {
      await action()
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  const startRename = (note: DeviceNote) => {
    setEditingId(note.id)
    setLabelInput(note.label)
  }

  const saveRename = (id: string) =>
    withBusy(async () => {
      await rename(id, labelInput().trim())
      setEditingId(null)
    })

  // raw command console (see DeviceClient.sendRaw in device.ts) - a
  // scrolling request/response log, oldest first, same shape a serial
  // terminal would show. Every other action on this page is a typed
  // wrapper around one hardcoded command; this is the one place a holder
  // can send anything, including commands this client has no button for
  // (e.g. `wipe`/`ota_begin`) - still queued/timed-out/validated the same
  // way every other command is (see sendRaw's own comment), only the
  // request shape itself is unchecked
  const [consoleInput, setConsoleInput] = createSignal('{"cmd": "get_info"}')
  const [consoleBusy, setConsoleBusy] = createSignal(false)
  const [consoleLog, setConsoleLog] = createSignal<
    {id: number; request: string; response: string; ok: boolean}[]
  >([])
  let nextConsoleLogId = 0

  const sendConsoleCommand = async () => {
    const current = client()
    if (!current) return
    let parsed: object
    try {
      parsed = JSON.parse(consoleInput())
    } catch {
      notify('Not valid JSON.', NotifyKind.ERROR)
      return
    }
    setConsoleBusy(true)
    try {
      const response = await current.sendRaw(parsed)
      setConsoleLog(log => [
        ...log,
        {
          id: nextConsoleLogId++,
          request: JSON.stringify(parsed),
          response: JSON.stringify(response, null, 2),
          ok: true
        }
      ])
    } catch (err) {
      setConsoleLog(log => [
        ...log,
        {
          id: nextConsoleLogId++,
          request: JSON.stringify(parsed),
          response: (err as Error).message,
          ok: false
        }
      ])
    } finally {
      setConsoleBusy(false)
    }
  }

  return (
    <div id="vault" class="page">
      <h2>LNURLvault</h2>
      {/* LUD-25 Part 2 (recoverable-signature/pubkey-keyed notes - see
      src/lib/recoverableNotes.ts) is deliberately browser-only for now: it
      needs the device firmware to derive a note's own keypair and sign the
      fixed ck1 ownership message itself, which no vault firmware does yet.
      A device-backed note's own secret never even reaches the browser, so
      this can't be bridged from this side - shown regardless of connection
      state, since it's true whether or not one is currently paired. */}
      <p class="warning">
        This vault has not been migrated to LUD-25 Part 2's pubkey-based notes
        yet - it only generates and holds legacy hash-keyed secrets. Addresses
        page registrations and any other pubkey-keyed notes stay browser-only
        for now; keep using this device for its existing note types.
      </p>
      {/* the pairing call to action has to go once a vault is paired -
          left standing next to "No notes on this device yet" it reads as
          "you still have not paired", on a page that just did */}
      <Show
        when={connectionState() === 'connected'}
        fallback={
          <>
            <p>
              Pair an LNURLvault hardware device over USB or Bluetooth. The
              device generates and holds note secrets itself - this page only
              reads its state, it never sees a plaintext secret unless you
              explicitly export one on the device (which requires a physical
              button press there).
            </p>
            <p>
              Don't have a vault yet? See{' '}
              <a
                href="https://vault.lnurlcash.com"
                target="_blank"
                rel="noreferrer"
              >
                vault.lnurlcash.com
              </a>{' '}
              for setup instructions and supported hardware.
            </p>
          </>
        }
      >
        <p>
          This vault generates and holds its note secrets itself. This page only
          reads its state, and never sees a plaintext secret unless you export
          one on the device, which requires a physical button press there.
        </p>
      </Show>
      <div class="two-columns">
        <div class="two-col">
          <Show
            when={connectionState() === 'connected'}
            fallback={
              <div class="setup-card">
                <Show
                  when={serialSupported || bleSupported}
                  fallback={
                    <p class="warning">
                      This browser supports neither WebSerial nor Web Bluetooth
                      - try Chrome or Edge on desktop or Android.
                    </p>
                  }
                >
                  <Show
                    when={!reconnecting()}
                    fallback={
                      <p class="bearer-hint">Looking for your vault...</p>
                    }
                  >
                    <div class="btns">
                      <Show when={serialSupported}>
                        <button
                          disabled={connectionState() === 'connecting'}
                          onClick={() => withBusy(connectSerial)}
                        >
                          Connect vault over USB
                        </button>
                      </Show>
                      <Show when={bleSupported}>
                        <button
                          disabled={connectionState() === 'connecting'}
                          onClick={() => withBusy(connectBle)}
                        >
                          Connect vault over Bluetooth
                        </button>
                      </Show>
                    </div>
                  </Show>
                </Show>
              </div>
            }
          >
            <div class="setup-card">
              <h4>
                {info()
                  ? `Vault ${info()!.fw_version}${info()!.board ? ` (${info()!.board})` : ''}`
                  : 'Connected'}
              </h4>
              <Show when={identity() && identityWarning(identity()!)}>
                {message => (
                  <>
                    <p class="warning">{message()}</p>
                    <div class="btns">
                      <Show when={identity()?.kind === 'changed'}>
                        <button
                          disabled={busy()}
                          onClick={trustCurrentIdentity}
                        >
                          Trust this vault from now on
                        </button>
                      </Show>
                      <button
                        disabled={busy()}
                        onClick={() => withBusy(disconnect)}
                      >
                        Disconnect
                      </button>
                    </div>
                  </>
                )}
              </Show>
              <Show when={info()}>
                {i => (
                  <>
                    <Show when={storageWarning(i().storage)}>
                      {message => <p class="warning">{message()}</p>}
                    </Show>
                    <Show when={inputWarning(i())}>
                      {message => <p class="warning">{message()}</p>}
                    </Show>
                    <p class="bearer-hint">
                      {i().note_count} note{i().note_count === 1 ? '' : 's'} on
                      device, {i().pending_count} pending.
                    </p>
                    <p class="bearer-hint">{approvalInstruction(i())}</p>
                    <Show when={i().capabilities && !canShowQrHandoff(i())}>
                      <p class="bearer-hint">
                        This vault's screen is too small to show a note as a QR
                        code, so notes on it can't be handed over in person.
                      </p>
                    </Show>
                  </>
                )}
              </Show>
              <div class="btns">
                <button disabled={busy()} onClick={() => withBusy(refresh)}>
                  Refresh
                </button>
                <Show
                  when={spentCount() > 0 && !gatedCommandsUnavailable(info())}
                >
                  <button
                    disabled={busy()}
                    onClick={() => withBusy(clearSpent)}
                  >
                    Clear {spentCount()} spent
                  </button>
                </Show>
                <button disabled={busy()} onClick={() => withBusy(disconnect)}>
                  Disconnect
                </button>
              </div>
            </div>
            <Show
              when={notes().length > 0}
              fallback={
                <p>
                  {storageWarning(info()?.storage)
                    ? "Can't reliably read this device's notes right now - see the warning above."
                    : 'No notes on this device yet.'}
                </p>
              }
            >
              <div class="bearer-list">
                <For each={notes()}>
                  {note => (
                    <figure class="bearer-card">
                      <div class="bearer-head">
                        <div class="bearer-title">
                          <span class="bearer-amount">
                            {msatToSats(note.amount_msat)} sats
                          </span>
                          <Show when={note.label}>
                            <span class="bearer-label">{note.label}</span>
                          </Show>
                          <Show when={note.state === 'pending'}>
                            <span class="bearer-pending">pending</span>
                          </Show>
                          <Show when={note.state === 'spent'}>
                            <span class="bearer-spent">
                              <IoBanSharp />
                              &nbsp;spent
                            </span>
                          </Show>
                          <span class="bearer-server">{note.host}</span>
                        </div>
                      </div>
                      <Show
                        when={editingId() === note.id}
                        fallback={
                          <div class="btns">
                            <button
                              class="icon-btn"
                              title="Rename"
                              onClick={() => startRename(note)}
                            >
                              <IoPencilSharp />
                            </button>
                            <Show when={isOrphan(note)}>
                              <button
                                class="icon-btn"
                                title="Adopt into this wallet - this browser has no record of this note, so it has no card on the wallet page"
                                disabled={busy()}
                                onClick={() => withBusy(() => adopt(note))}
                              >
                                <IoDownloadSharp />
                              </button>
                            </Show>
                            <Show when={note.state === 'spent'}>
                              <button
                                class="icon-btn"
                                title="Delete from device"
                                disabled={busy()}
                                onClick={() =>
                                  withBusy(() => deleteNote(note.id))
                                }
                              >
                                <IoTrashSharp />
                              </button>
                            </Show>
                          </div>
                        }
                      >
                        <div class="form-item">
                          <input
                            type="text"
                            placeholder="label"
                            value={labelInput()}
                            onInput={e => setLabelInput(e.currentTarget.value)}
                            onKeyDown={e =>
                              e.key === 'Enter' && saveRename(note.id)
                            }
                          />
                          <div class="btns">
                            <button
                              disabled={busy()}
                              onClick={() => saveRename(note.id)}
                            >
                              Save
                            </button>
                            <button onClick={() => setEditingId(null)}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      </Show>
                    </figure>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </div>
        <div class="two-col">
          <div class="setup-card">
            <h4>Device console</h4>
            <p>
              Send a raw command straight to the paired vault and see its raw
              response - the same low-level access as the console at{' '}
              <a
                href="https://vault.lnurlcash.com"
                target="_blank"
                rel="noreferrer"
              >
                vault.lnurlcash.com
              </a>
              . For debugging and advanced use only - everything the buttons on
              this page already do is safer and easier.
            </p>
            <Show
              when={client()}
              fallback={
                <p class="bearer-hint">Connect a vault to use the console.</p>
              }
            >
              <div class="btns">
                <button onClick={() => setConsoleInput('{"cmd": "get_info"}')}>
                  get_info
                </button>
                <button
                  onClick={() => setConsoleInput('{"cmd": "list_notes"}')}
                >
                  list_notes
                </button>
              </div>
              <label>Command (raw JSON)</label>
              <textarea
                rows="3"
                spellcheck={false}
                value={consoleInput()}
                onInput={e => setConsoleInput(e.currentTarget.value)}
              />
              <div class="btns">
                <button disabled={consoleBusy()} onClick={sendConsoleCommand}>
                  <Show when={consoleBusy()}>
                    <IoRefreshSharp class="spin" />
                    &nbsp;
                  </Show>
                  Send
                </button>
                <Show when={consoleLog().length > 0}>
                  <button onClick={() => setConsoleLog([])}>Clear log</button>
                </Show>
              </div>
              <Show when={consoleLog().length > 0}>
                <div class="console-log">
                  <For each={consoleLog()}>
                    {entry => (
                      <div
                        class="console-entry"
                        classList={{'console-entry-error': !entry.ok}}
                      >
                        <p class="console-request">&gt; {entry.request}</p>
                        <pre class="console-response">{entry.response}</pre>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}
export default Vault
