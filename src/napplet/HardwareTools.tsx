import {createSignal, For, Show, onCleanup} from 'solid-js'
import {QRCodeSVG, ErrorCorrectionLevel} from 'solid-qr-code'
import type {DeviceNote} from '../device'
import type {WalletToolsProps} from './WalletTools'
import {NappletDeviceTransport} from './device-transport'
import {HardwareWallet} from './hardware'

/** One wallet's optional device custody tools, shown only when requested. */
export default function HardwareTools(props: WalletToolsProps) {
  const hardware = new HardwareWallet(props.vault, props.wallet)
  const [key, setKey] = createSignal(''),
    [review, setReview] = createSignal(false)
  const [connected, setConnected] = createSignal(false),
    [notes, setNotes] = createSignal<DeviceNote[]>([])
  const [selected, setSelected] = createSignal<string[]>([]),
    [mintAddress, setMintAddress] = createSignal('')
  const [invoice, setInvoice] = createSignal('')
  const [label, setLabel] = createSignal('')
  const [amount, setAmount] = createSignal(''),
    [source, setSource] = createSignal('')
  const [output, setOutput] = createSignal(''),
    [invoices, setInvoices] = createSignal<string[]>([])
  const refresh = async () => {
    setNotes(await hardware.notes())
    setInvoices(
      (await hardware.funding())
        .filter(entry => !entry.confirmed)
        .map(entry => entry.quote.pr)
    )
  }
  const run = (action: () => Promise<void>) =>
    void props.run(async () => {
      try {
        await action()
      } finally {
        if (connected()) await refresh()
      }
    })
  const connect = (kind: 'serial' | 'ble') =>
    run(async () => {
      setConnected(false)
      setReview(false)
      setOutput('')
      setNotes([])
      const result = await hardware.connect(
        await NappletDeviceTransport.open(kind, window.napplet ?? {})
      )
      setKey(result.key)
      setReview(result.changed)
      setConnected(!result.changed)
    })
  onCleanup(() => {
    void hardware.disconnect().catch(() => {})
  })
  return (
    <Show when={props.tab === 'device'}>
      <section class="panel">
        <h2>Physical vault</h2>
        <p>
          USB or Bluetooth through your shell. Keep the device connected and
          approve requested actions on its physical buttons.
        </p>
        <Show when={window.napplet?.serial}>
          <button disabled={props.busy} onClick={() => connect('serial')}>
            Connect USB vault
          </button>
        </Show>
        <Show when={window.napplet?.ble}>
          <button disabled={props.busy} onClick={() => connect('ble')}>
            Connect Bluetooth vault
          </button>
        </Show>
        <Show when={!window.napplet?.serial && !window.napplet?.ble}>
          <p>
            This shell does not expose USB or Bluetooth. Use the normal
            webwallet for your physical vault.
          </p>
        </Show>
        <Show when={key()}>
          <p>Device identity</p>
          <code>{key()}</code>
        </Show>
        <Show when={review()}>
          <p>
            This is a new or changed device identity. Verify that this is the
            physical vault you intend to use.
          </p>
          <button
            disabled={props.busy}
            onClick={() =>
              run(async () => {
                await hardware.acceptIdentity()
                setReview(false)
                setConnected(true)
              })
            }
          >
            Trust this physical vault
          </button>
        </Show>
        <Show when={connected()}>
          <div class="actions">
            <button disabled={props.busy} onClick={() => run(refresh)}>
              Reload device notes
            </button>
            <button
              disabled={props.busy}
              onClick={() =>
                run(async () => {
                  await hardware.settleFunding()
                  await hardware.settlePayments()
                })
              }
            >
              Verify device invoices
            </button>
            <button
              disabled={props.busy}
              onClick={() =>
                run(async () => {
                  await hardware.disconnect()
                  setConnected(false)
                  setKey('')
                  setOutput('')
                  setNotes([])
                })
              }
            >
              Disconnect vault
            </button>
          </div>
          <For each={notes()}>
            {note => (
              <label>
                <input
                  type="checkbox"
                  disabled={props.busy || note.state === 'spent'}
                  checked={selected().includes(note.id)}
                  onChange={e =>
                    setSelected(ids =>
                      e.currentTarget.checked
                        ? [...ids, note.id]
                        : ids.filter(id => id !== note.id)
                    )
                  }
                />
                {note.amount_msat / 1000} sats · {note.label || note.id} ·{' '}
                {note.state} · {note.host}
              </label>
            )}
          </For>
          <label>
            Amount (sats)
            <input
              inputmode="decimal"
              value={amount()}
              onInput={e => setAmount(e.currentTarget.value)}
            />
          </label>
          <div class="actions">
            <button
              disabled={props.busy || selected().length !== 1}
              onClick={() =>
                run(async () => {
                  await hardware.transform(selected(), 'rotate')
                  setSelected([])
                })
              }
            >
              Rotate device note
            </button>
            <button
              disabled={props.busy || !selected().length}
              onClick={() =>
                run(async () => {
                  await hardware.transform(
                    selected(),
                    'split',
                    Number(amount()) * 1000
                  )
                  setSelected([])
                })
              }
            >
              Split device notes
            </button>
            <button
              disabled={props.busy || selected().length < 2}
              onClick={() =>
                run(async () => {
                  await hardware.transform(selected(), 'combine')
                  setSelected([])
                })
              }
            >
              Combine device notes
            </button>
          </div>
          <label>
            Device mint address
            <input
              value={mintAddress()}
              onInput={e => setMintAddress(e.currentTarget.value)}
            />
          </label>
          <div class="actions">
            <button
              disabled={props.busy || !mintAddress() || !amount()}
              onClick={() =>
                run(async () => {
                  setOutput(
                    await hardware.mint(mintAddress(), Number(amount()) * 1000)
                  )
                })
              }
            >
              Create device funding invoice
            </button>
          </div>
          <label>
            Device payment invoice
            <textarea
              value={invoice()}
              onInput={e => setInvoice(e.currentTarget.value)}
            />
          </label>
          <div class="actions">
            <button
              disabled={props.busy || selected().length !== 1 || !invoice()}
              onClick={() =>
                run(async () => {
                  await hardware.pay(selected()[0], invoice())
                  setSelected([])
                })
              }
            >
              Confirm device payment
            </button>
            <button
              disabled={props.busy || selected().length !== 1 || !mintAddress()}
              onClick={() =>
                run(async () => {
                  await hardware.transfer(selected()[0], mintAddress())
                  setSelected([])
                })
              }
            >
              Confirm device mint transfer
            </button>
          </div>
          <label>
            Device note label
            <input
              maxlength="200"
              value={label()}
              onInput={e => setLabel(e.currentTarget.value)}
            />
          </label>
          <div class="actions">
            <button
              disabled={props.busy || selected().length !== 1}
              onClick={() => run(() => hardware.rename(selected()[0], label()))}
            >
              Rename device note
            </button>
            <button
              disabled={props.busy || selected().length !== 1}
              onClick={() =>
                run(async () => {
                  setOutput(await hardware.share(selected()[0]))
                  setSelected([])
                })
              }
            >
              Hand over device note
            </button>
          </div>
          <h3>Move custody</h3>
          <p>
            Moving rotates the note so only its replacement remains spendable.
          </p>
          <label>
            Wallet note
            <select
              value={source()}
              onChange={e => setSource(e.currentTarget.value)}
            >
              <option value="">Choose a note</option>
              <For each={props.notes.filter(note => note.status === 'ready')}>
                {note => (
                  <option value={note.id}>
                    {note.amount / 1000} sats · {new URL(note.url).host}
                  </option>
                )}
              </For>
            </select>
          </label>
          <button
            disabled={props.busy || !source()}
            onClick={() =>
              run(async () => {
                await hardware.moveToDevice(source())
                setSource('')
              })
            }
          >
            Move wallet note to device
          </button>
          <button
            disabled={props.busy || selected().length !== 1}
            onClick={() =>
              run(async () => {
                await hardware.moveToWallet(selected()[0])
                setSelected([])
              })
            }
          >
            Move device note to wallet
          </button>
          <For each={invoices()}>
            {invoice => (
              <button disabled={props.busy} onClick={() => setOutput(invoice)}>
                Show pending device invoice
              </button>
            )}
          </For>
          <Show when={output()}>
            <div class="reveal">
              <QRCodeSVG
                value={output()}
                level={ErrorCorrectionLevel.LOW}
                width={180}
                height={180}
                backgroundColor="white"
                backgroundAlpha={1}
                foregroundColor="black"
                foregroundAlpha={1}
              />
              <textarea
                aria-label="Device invoice or handed-over note"
                readonly
                value={output()}
              />
              <button onClick={() => setOutput('')}>Hide device output</button>
            </div>
          </Show>
        </Show>
      </section>
    </Show>
  )
}
