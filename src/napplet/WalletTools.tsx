import {createEffect, createSignal, For, Show, onCleanup} from 'solid-js'
import type {Vault, Note, CashState} from './vault'
import type {Wallet, HistoryEntry} from './wallet'
import {exportWebBackup, importWebBackup} from './backup'
import {readShellFile, saveShellFile} from './files'
import type {Preferences} from './preferences'
import {fetchServiceResponse} from '../serviceTransport'
import {
  fetchPayRequest,
  resolveMintInput,
  resolveLnurlInput,
  describeMintFee,
  parseMintFee
} from '../lnurlcash'
import type {MintPin} from './mints'
import {observeMint, reviewMintKey, discoverMint} from './mints'
import HardwareTools from './HardwareTools'

export type WalletToolsProps = {
  tab: string
  vault: Vault
  wallet: Wallet
  notes: Note[]
  busy: boolean
  revision: number
  preferences: Preferences
  onPreferences(value: Preferences): Promise<void>
  run(action: () => Promise<void>): Promise<void>
}

/** Secondary wallet functions reuse the same encrypted vault and serialized action boundary. */
export default function WalletTools(props: WalletToolsProps) {
  const [text, setText] = createSignal(''),
    [password, setPassword] = createSignal('')
  const [seed, setSeed] = createSignal(''),
    [trusted, setTrusted] = createSignal(false)
  const [exported, setExported] = createSignal(''),
    [message, setMessage] = createSignal('')
  const [mint, setMint] = createSignal(''),
    [source, setSource] = createSignal('')
  const [start, setStart] = createSignal('0'),
    [progress, setProgress] = createSignal<number | null>(null)
  const [importedRoot, setImportedRoot] = createSignal(-1),
    [rootCount, setRootCount] = createSignal(0)
  const [pins, setPins] = createSignal<MintPin[]>([]),
    [history, setHistory] = createSignal<HistoryEntry[]>([])
  const [price, setPrice] = createSignal(''),
    [fee, setFee] = createSignal('')
  let scan: AbortController | undefined
  let live = true
  createEffect(() => {
    props.tab
    setMessage('')
    setPassword('')
    setSeed('')
    setExported('')
  })
  createEffect(() => {
    props.revision
    void Promise.all([
      props.vault.meta<MintPin[]>('mints'),
      props.vault.meta<HistoryEntry[]>('history'),
      props.vault.meta<CashState[]>('cash-imports')
    ])
      .then(([mints, events, roots]) => {
        if (live) {
          setPins(mints ?? [])
          setHistory(events ?? [])
          setRootCount(roots?.length ?? 0)
        }
      })
      .catch(error => {
        if (live) setMessage((error as Error).message)
      })
  })
  onCleanup(() => {
    live = false
    scan?.abort()
  })
  const run = (action: () => Promise<void>) =>
    void props.run(async () => {
      setMessage('')
      await action()
    })
  const update = (change: Partial<Preferences>) =>
    run(() => props.onPreferences({...props.preferences, ...change}))
  const lookupMint = async (): Promise<void> => {
    const url = resolveMintInput(mint()) ?? resolveLnurlInput(mint())
    if (!url) throw new Error('Enter a mint URL or Lightning address.')
    const info = await fetchPayRequest(url)
    if (info.mintPubkey) await observeMint(props.vault, url, info.mintPubkey)
    if (props.tab === 'mints') {
      try {
        await discoverMint(props.vault, url)
      } catch {
        /* Older mints may omit address discovery. */
      }
    }
    const advertisedFee = parseMintFee(info.metadata)
    setFee(
      advertisedFee ? describeMintFee(advertisedFee) : 'No mint fee advertised.'
    )
    setMessage(
      `Mint accepts ${info.minSendable / 1000}–${info.maxSendable / 1000} sats.`
    )
  }
  return (
    <>
      <HardwareTools {...props} />
      <Show when={props.tab === 'backup'}>
        <section class="panel">
          <h2>Use a webwallet backup</h2>
          <p>
            Import notes from dni’s wallet or export a compatible encrypted
            file. Device-held notes need the original device. Imported keys
            never replace this wallet’s key.
          </p>
          <label>
            Webwallet backup password
            <input
              type="password"
              autocomplete="off"
              value={password()}
              onInput={e => setPassword(e.currentTarget.value)}
            />
          </label>
          <label>
            Original seed, only for a backup without its key
            <textarea
              autocomplete="off"
              spellcheck={false}
              value={seed()}
              onInput={e => setSeed(e.currentTarget.value)}
            />
          </label>
          <label>
            Original webwallet backup JSON
            <textarea
              value={text()}
              onInput={e => setText(e.currentTarget.value)}
            />
          </label>
          <label>
            Choose backup file
            <input
              type="file"
              accept="application/json,.json"
              disabled={props.busy}
              onChange={e => {
                const file = e.currentTarget.files?.[0]
                if (file)
                  run(async () => {
                    if (file.size > 10 * 1024 * 1024)
                      throw new Error('Backup exceeds 10 MB.')
                    setText(await file.text())
                  })
              }}
            />
          </label>
          <Show when={window.napplet?.fs}>
            <button
              disabled={props.busy}
              onClick={() =>
                run(async () => {
                  setText(await readShellFile())
                })
              }
            >
              Open backup from shell
            </button>
          </Show>
          <label>
            <input
              type="checkbox"
              checked={trusted()}
              onChange={e => setTrusted(e.currentTarget.checked)}
            />{' '}
            I trust the source of this backup
          </label>
          <button
            disabled={props.busy || !trusted() || !text()}
            onClick={() =>
              run(async () => {
                const result = await importWebBackup(
                  props.vault,
                  text(),
                  password(),
                  seed()
                )
                setText('')
                setPassword('')
                setSeed('')
                setTrusted(false)
                setMessage(
                  `Imported ${result.added} notes. ${result.deviceMirrors} device mirrors need the original vault.`
                )
              })
            }
          >
            Import webwallet backup
          </button>
          <button
            disabled={props.busy || !password()}
            onClick={() =>
              run(async () => {
                setExported(await exportWebBackup(props.vault, password()))
                setPassword('')
              })
            }
          >
            Export for webwallet
          </button>
          <Show when={exported()}>
            <label>
              Compatible encrypted backup
              <textarea
                class="backup"
                readonly
                value={exported()}
                onFocus={e => e.currentTarget.select()}
              />
            </label>
            <Show when={window.napplet?.fs}>
              <button
                onClick={() =>
                  run(() =>
                    saveShellFile('lnurlwallet-backup.json', exported())
                  )
                }
              >
                Save webwallet backup file
              </button>
            </Show>
          </Show>
          <Show when={window.napplet?.fs}>
            <button
              disabled={props.busy}
              onClick={() =>
                run(async () =>
                  saveShellFile(
                    'lnurlcash-napplet-backup.json',
                    await props.vault.backup()
                  )
                )
              }
            >
              Save full napplet backup file
            </button>
          </Show>
        </section>
      </Show>
      <Show when={props.tab === 'recovery'}>
        <section class="panel">
          <h2>Recover notes from your seed</h2>
          <p>
            Scan each mint you used. The scan checks deterministic hashes,
            retains discovered notes and stops after 20 unused indices. It never
            sends a payment.
          </p>
          <label>
            Recovery mint
            <input
              value={mint()}
              onInput={e => setMint(e.currentTarget.value)}
              placeholder="Mint URL or Lightning address"
            />
          </label>
          <label>
            Start index
            <input
              type="number"
              min="0"
              value={start()}
              onInput={e => setStart(e.currentTarget.value)}
            />
          </label>
          <Show when={rootCount()}>
            <label>
              Recovery key
              <select
                aria-label="Recovery key"
                value={importedRoot()}
                onChange={e => setImportedRoot(Number(e.currentTarget.value))}
              >
                <option value="-1">This wallet’s seed</option>
                <For each={Array.from({length: rootCount()}, (_, i) => i)}>
                  {i => <option value={i}>Imported backup key {i + 1}</option>}
                </For>
              </select>
            </label>
          </Show>
          <button
            disabled={props.busy || !mint()}
            onClick={() =>
              run(async () => {
                scan = new AbortController()
                try {
                  setMessage(
                    `Recovered ${await props.wallet.recover(mint(), setProgress, scan.signal, Number(start()), importedRoot())} notes.`
                  )
                } finally {
                  scan = undefined
                }
              })
            }
          >
            Scan mint for notes
          </button>
          <Show when={props.busy && progress() !== null}>
            <button onClick={() => scan?.abort()}>Stop recovery scan</button>
          </Show>
          <Show when={progress() !== null}>
            <p>Checking index {progress()}.</p>
          </Show>
          <hr />
          <h3>Recover a legacy payment preimage</h3>
          <p>Only for old notes minted with the preimage as their secret.</p>
          <label>
            Withdraw endpoint
            <input
              value={text()}
              onInput={e => setText(e.currentTarget.value)}
            />
          </label>
          <label>
            Legacy preimage
            <input
              autocomplete="off"
              value={seed()}
              onInput={e => setSeed(e.currentTarget.value)}
            />
          </label>
          <button
            disabled={props.busy || !text() || !seed()}
            onClick={() =>
              run(async () => {
                await props.wallet.recoverPreimage(text(), seed())
                setSeed('')
                setMessage('Legacy note received and rotated.')
              })
            }
          >
            Recover legacy note
          </button>
        </section>
      </Show>
      <Show when={props.tab === 'transfer'}>
        <section class="panel">
          <h2>Transfer to another mint</h2>
          <p>
            The selected note pays a funding invoice at the destination mint.
            Both sides remain stored while settlement is pending.
          </p>
          <label>
            Source note
            <select
              aria-label="Source note"
              value={source()}
              onChange={e => setSource(e.currentTarget.value)}
            >
              <option value="">Choose a note</option>
              <For each={props.notes.filter(n => n.status === 'ready')}>
                {note => (
                  <option value={note.id}>
                    {note.amount / 1000} sats · {new URL(note.url).host}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label>
            Destination mint
            <input
              value={mint()}
              onInput={e => {
                setMint(e.currentTarget.value)
                setFee('')
              }}
            />
          </label>
          <button
            disabled={props.busy || !mint()}
            onClick={() => run(lookupMint)}
          >
            Check destination and fees
          </button>
          <Show when={fee()}>
            <p>{fee()}</p>
            <button
              class="primary"
              disabled={props.busy || !source()}
              onClick={() =>
                run(async () => {
                  await props.wallet.transfer(source(), mint())
                  setSource('')
                  setFee('')
                  setMessage(
                    'Transfer requested. Check the pending source and destination notes.'
                  )
                })
              }
            >
              Confirm transfer
            </button>
          </Show>
        </section>
      </Show>
      <Show when={props.tab === 'mints'}>
        <section class="panel">
          <h2>Mints and signing keys</h2>
          <label>
            Mint address
            <input
              value={mint()}
              onInput={e => setMint(e.currentTarget.value)}
            />
          </label>
          <button
            disabled={props.busy || !mint()}
            onClick={() => run(lookupMint)}
          >
            Look up mint
          </button>
          <p>{fee()}</p>
          <For each={pins()}>
            {pin => (
              <article class="mint-pin">
                <h3>{pin.origin}</h3>
                <Show when={pin.alias}>
                  <p>{pin.alias}</p>
                </Show>
                <Show when={pin.sunset}>
                  <p>Mint announces shutdown: {pin.sunset}</p>
                </Show>
                <p>
                  {pin.confirmed
                    ? 'Pinned issuer key'
                    : 'Imported key; awaiting live confirmation'}
                </p>
                <code>{pin.key}</code>
                <Show when={pin.pending}>
                  <p>New signing key requires review:</p>
                  <code>{pin.pending}</code>
                  <button
                    disabled={props.busy}
                    onClick={() =>
                      run(() => reviewMintKey(props.vault, pin.origin, true))
                    }
                  >
                    Accept signing key change
                  </button>
                  <button
                    disabled={props.busy}
                    onClick={() =>
                      run(() => reviewMintKey(props.vault, pin.origin, false))
                    }
                  >
                    Keep pinned key
                  </button>
                </Show>
              </article>
            )}
          </For>
        </section>
      </Show>
      <Show when={props.tab === 'activity'}>
        <section class="panel">
          <h2>Activity</h2>
          <p>Your encrypted local action history.</p>
          <For each={[...history()].reverse()}>
            {event => (
              <article class="activity-entry">
                <time>{new Date(event.time).toLocaleString()}</time>
                <p>{event.message}</p>
              </article>
            )}
          </For>
        </section>
      </Show>
      <Show when={props.tab === 'settings'}>
        <section class="panel">
          <h2>Wallet settings</h2>
          <label>
            <input
              type="checkbox"
              checked={props.preferences.offline}
              disabled={props.busy}
              onChange={e => update({offline: e.currentTarget.checked})}
            />{' '}
            Offline mode
          </label>
          <label>
            Auto-lock
            <select
              aria-label="Auto-lock"
              value={props.preferences.autoLock}
              disabled={props.busy}
              onChange={e =>
                update({
                  autoLock: Number(
                    e.currentTarget.value
                  ) as Preferences['autoLock']
                })
              }
            >
              <For each={[1, 5, 15, 30, 0]}>
                {minutes => (
                  <option value={minutes}>
                    {minutes
                      ? `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
                      : 'Never'}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label>
            Currency estimate
            <select
              aria-label="Currency estimate"
              value={props.preferences.currency}
              disabled={props.busy}
              onChange={e =>
                update({
                  currency: e.currentTarget.value as Preferences['currency']
                })
              }
            >
              <For each={['none', 'eur', 'gbp', 'usd']}>
                {currency => (
                  <option value={currency}>
                    {currency === 'none' ? 'Disabled' : currency.toUpperCase()}
                  </option>
                )}
              </For>
            </select>
          </label>
          <Show when={props.preferences.currency !== 'none'}>
            <button
              disabled={props.busy || props.preferences.offline}
              onClick={() =>
                run(async () => {
                  const response = await fetchServiceResponse(
                    'https://price.lnurlcash.com/rates',
                    AbortSignal.timeout(10000)
                  )
                  const data = await response.json(),
                    rate =
                      data.rates?.[props.preferences.currency.toUpperCase()]
                        ?.median
                  if (!Number.isFinite(rate) || rate <= 0)
                    throw new Error('Price service returned no valid rate.')
                  const balance = props.notes
                    .filter(n => n.status === 'ready')
                    .reduce((sum, n) => sum + n.amount, 0)
                  setPrice(
                    new Intl.NumberFormat(undefined, {
                      style: 'currency',
                      currency: props.preferences.currency
                    }).format((balance / 100000000000) * rate)
                  )
                })
              }
            >
              Refresh estimate
            </button>
            <p>{price()}</p>
          </Show>
          <label>
            Sort notes
            <select
              aria-label="Sort notes"
              value={props.preferences.sort}
              disabled={props.busy}
              onChange={e =>
                update({sort: e.currentTarget.value as Preferences['sort']})
              }
            >
              <option value="updated">Last updated</option>
              <option value="amount">Amount</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={props.preferences.descending}
              disabled={props.busy}
              onChange={e => update({descending: e.currentTarget.checked})}
            />{' '}
            Descending order
          </label>
          <label>
            <input
              type="checkbox"
              checked={props.preferences.groupByMint}
              disabled={props.busy}
              onChange={e => update({groupByMint: e.currentTarget.checked})}
            />{' '}
            Group by mint
          </label>
          <p>Use the webwallet for camera scanning and NFC.</p>
          <Show when={window.napplet?.link}>
            <button
              disabled={props.busy}
              onClick={() =>
                run(async () => {
                  const result = await window.napplet!.link!.open(
                    'https://wallet.lnurlcash.com',
                    {label: 'Open LNURLcash webwallet'}
                  )
                  if (result.status !== 'opened')
                    throw new Error('The shell did not open the webwallet.')
                })
              }
            >
              Open webwallet
            </button>
          </Show>
        </section>
      </Show>
      <Show when={message() && !props.busy}>
        <p class="notice" role="status">
          {message()}
        </p>
      </Show>
    </>
  )
}
