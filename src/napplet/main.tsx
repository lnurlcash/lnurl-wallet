import {createSignal, For, Show, onMount, onCleanup} from 'solid-js'
import {render} from 'solid-js/web'
import {QRCodeSVG, ErrorCorrectionLevel} from 'solid-qr-code'
import {getWalletHost} from './host'
import {Vault} from './vault'
import type {Note} from './vault'
import {Wallet} from './wallet'
import {listenWalletIntents} from './intents'
import type {WalletRequest} from './intents'
import {decodeBolt11AmountMsat, serverOf} from '../lnurlcash'
import Banknote from './Banknote'
import {DEFAULT_DESIGN, parseDesign} from './design'
import type {NoteDesign} from './design'
import './style.css'
import {generateSeedPhrase} from '../keys'
import WalletTools from './WalletTools'
import NoteTools from './NoteTools'
import {
  DEFAULT_PREFERENCES,
  parsePreferences,
  setNappletOffline
} from './preferences'
import type {Preferences} from './preferences'
import {signedNote} from './mints'
import type {MintPin} from './mints'

const sats = (msat: number): string =>
  (msat / 1000).toLocaleString('en-US', {maximumFractionDigits: 3})

function App() {
  const [failure, setFailure] = createSignal('')
  const [initialized, setInitialized] = createSignal(false)
  const [exists, setExists] = createSignal(false)
  const [unlocked, setUnlocked] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [message, setMessage] = createSignal('')
  const [notes, setNotes] = createSignal<Note[]>([])
  const [selected, setSelected] = createSignal<string[]>([])
  const [password, setPassword] = createSignal('')
  const [repeat, setRepeat] = createSignal('')
  const [seed, setSeed] = createSignal(generateSeedPhrase())
  const [seedSaved, setSeedSaved] = createSignal(false)
  const [restoringSeed, setRestoringSeed] = createSignal(false)
  const [resettingPassword, setResettingPassword] = createSignal(false)
  const [preferences, setPreferences] = createSignal<Preferences>({
    ...DEFAULT_PREFERENCES
  })
  const [pins, setPins] = createSignal<MintPin[]>([])
  const [revision, setRevision] = createSignal(0)
  const [lockWarning, setLockWarning] = createSignal(false)
  const [handoverFormat, setHandoverFormat] = createSignal<
    'url' | 'lnurl' | 'lnurlw' | 'claim'
  >('url')
  const [tab, setTab] = createSignal('wallet')
  const [input, setInput] = createSignal('')
  const [invoice, setInvoice] = createSignal('')
  const [paymentAddress, setPaymentAddress] = createSignal('')
  const [paymentAmount, setPaymentAmount] = createSignal('')
  const [savedMintAddresses, setSavedMintAddresses] = createSignal<string[]>([])
  const [savedPaymentAddresses, setSavedPaymentAddresses] = createSignal<
    string[]
  >([])
  const [fundingInvoice, setFundingInvoice] = createSignal('')
  const [mint, setMint] = createSignal('')
  const [amount, setAmount] = createSignal('')
  const [split, setSplit] = createSignal('')
  const [shared, setShared] = createSignal('')
  const [backup, setBackup] = createSignal('')
  const [restoreText, setRestoreText] = createSignal('')
  const [backupPassword, setBackupPassword] = createSignal('')
  const [designs, setDesigns] = createSignal<Record<string, NoteDesign>>({})
  const [designText, setDesignText] = createSignal('')
  const [designOpen, setDesignOpen] = createSignal(false)
  const [showHistory, setShowHistory] = createSignal(false)
  const [request, setRequest] = createSignal<WalletRequest | null>(null)
  const receivedDesign = () => {
    const value = request()
    return value?.action === 'design' ? value.design : null
  }
  let vault: Vault
  let wallet: Wallet
  let lastActivity = Date.now()
  let disconnect: (() => void) | undefined
  let timer: ReturnType<typeof setInterval>
  let polling = false
  let lastPoll = 0

  const lock = (): void => {
    if (busy()) return
    vault?.lock()
    setUnlocked(false)
    setNotes([])
    setSelected([])
    setShared('')
    setPassword('')
    setRepeat('')
    setSeed('')
    setSeedSaved(false)
    setResettingPassword(false)
    setLockWarning(false)
    setPins([])
    setInput('')
    setInvoice('')
    setPaymentAddress('')
    setPaymentAmount('')
    setSavedMintAddresses([])
    setSavedPaymentAddresses([])
    setFundingInvoice('')
    setBackupPassword('')
    setRestoreText('')
    setBackup('')
    setRequest(null)
    setDesigns({})
    setDesignText('')
  }
  const touch = (): void => {
    lastActivity = Date.now()
    setLockWarning(false)
  }
  const loadState = async (): Promise<void> => {
    setNotes(await vault.notes())
    setDesigns(await vault.designs())
    setPins((await vault.meta<MintPin[]>('mints')) ?? [])
    setSavedMintAddresses((await vault.meta<string[]>('mint-addresses')) ?? [])
    setSavedPaymentAddresses(
      (await vault.meta<string[]>('payment-addresses')) ?? []
    )
    const prefs = parsePreferences(await vault.meta('preferences'))
    setPreferences(prefs)
    setNappletOffline(prefs.offline)
    setRevision(value => value + 1)
  }
  const changePreferences = async (value: Preferences): Promise<void> => {
    const checked = parsePreferences(value)
    await vault.setMeta('preferences', checked)
    setPreferences(checked)
    setNappletOffline(checked.offline)
  }
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busy() || polling) return
    setBusy(true)
    setMessage('')
    try {
      await action()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Operation failed.')
    } finally {
      if (unlocked()) {
        try {
          await loadState()
        } catch {
          setMessage(
            'Could not read all notes. Keep your backup and retry when shell storage is available.'
          )
        }
      }
      setBusy(false)
      touch()
    }
  }
  const applyDesign = async (
    design: NoteDesign,
    ids: string[]
  ): Promise<void> => {
    const id = ids.length ? crypto.randomUUID() : 'default'
    await vault.saveDesign(id, design)
    for (const note of await vault.notes()) {
      if (ids.includes(note.id)) await vault.save({...note, designId: id})
    }
  }
  const authenticate = async (): Promise<void> => {
    if (exists() && resettingPassword()) {
      if (password() !== repeat()) throw new Error('Passwords do not match.')
      await vault.resetPassword(seed(), password())
    } else if (exists()) await vault.unlock(password())
    else {
      if (password() !== repeat()) throw new Error('Passwords do not match.')
      if (!seedSaved())
        throw new Error('Confirm that you saved your seed phrase.')
      await vault.create(password(), seed(), restoringSeed())
      setExists(true)
    }
    setPassword('')
    setRepeat('')
    setSeed('')
    setResettingPassword(false)
    const prefs = parsePreferences(await vault.meta('preferences'))
    setPreferences(prefs)
    setNappletOffline(prefs.offline)
    setUnlocked(true)
  }
  onMount(() => {
    try {
      const host = getWalletHost()
      vault = new Vault(host.storage)
      wallet = new Wallet(vault)
      disconnect = listenWalletIntents(
        host,
        incoming => {
          if (incoming.action === 'open') {
            setTab('wallet')
            return
          }
          if (request() || busy()) {
            setMessage(
              'Another request is pending. Ask the sender to retry after review.'
            )
            return
          }
          setRequest(incoming)
        },
        setMessage
      )
      vault
        .exists()
        .then(setExists)
        .then(() => setInitialized(true))
        .catch(() =>
          setFailure(
            'Shell storage is unavailable. Reopen when the shell can persist wallet data.'
          )
        )
      timer = setInterval(() => {
        if (!unlocked() || busy() || polling) return
        const timeout = preferences().autoLock * 60000
        if (timeout && Date.now() - lastActivity >= timeout) {
          lock()
          return
        }
        setLockWarning(
          !!timeout && Date.now() - lastActivity >= timeout - 30000
        )
        if (preferences().offline || Date.now() - lastPoll < 5000) return
        lastPoll = Date.now()
        const pending = notes().filter(
          note => note.status === 'pending' && note.verifyUrl && !note.proof
        )
        if (!pending.length) return
        polling = true
        setBusy(true)
        void (async () => {
          try {
            for (const note of pending) {
              try {
                await wallet.settlement(note.id)
              } catch {
                /* Manual verification displays the detailed error. */
              }
            }
            if (unlocked()) await loadState()
          } finally {
            polling = false
            setBusy(false)
          }
        })()
      }, 1000)
      document.addEventListener('pointerdown', touch)
      document.addEventListener('keydown', touch)
    } catch (error) {
      setFailure((error as Error).message)
    }
  })
  onCleanup(() => {
    disconnect?.()
    clearInterval(timer)
    vault?.lock()
    document.removeEventListener('pointerdown', touch)
    document.removeEventListener('keydown', touch)
  })
  const toggle = (id: string): void => {
    setSelected(current =>
      current.includes(id)
        ? current.filter(value => value !== id)
        : [...current, id]
    )
  }
  const visibleNotes = (): Note[] =>
    notes()
      .filter(
        note =>
          !note.hidden &&
          (showHistory() || !['spent', 'shared'].includes(note.status))
      )
      .sort((a, b) => {
        const mintOrder = preferences().groupByMint
          ? serverOf(a.url).localeCompare(serverOf(b.url))
          : 0
        const field = preferences().sort === 'amount' ? 'amount' : 'updatedAt'
        return (
          mintOrder ||
          (a[field] - b[field]) * (preferences().descending ? -1 : 1)
        )
      })
  const accept = (): void => {
    const value = request()!
    if (value.action === 'receive') {
      setInput(value.value)
      setTab('receive')
    }
    if (value.action === 'pay') {
      setInvoice(value.value)
      setTab('pay')
    }
    if (value.action === 'design') {
      const target = [...selected()]
      void run(async () => {
        await applyDesign(value.design, target)
        setRequest(null)
        setMessage('The received design has been applied.')
      })
      return
    }
    setRequest(null)
    setDesignText('')
  }

  return (
    <div class="app">
      <header>
        <a
          class="wordmark"
          href="#"
          onClick={event => {
            event.preventDefault()
            setTab('wallet')
          }}
        >
          <span class="logo">₿</span>
          <span>
            LNURL<span class="soft">cash</span>
            <small>WALLET NAPPLET</small>
          </span>
        </a>
        <Show when={unlocked()}>
          <button class="quiet" disabled={busy()} onClick={lock}>
            Lock wallet
          </button>
        </Show>
      </header>
      <main>
        <Show
          when={!failure()}
          fallback={
            <section class="panel">
              <h1>A home for your sats.</h1>
              <p role="alert">{failure()}</p>
              <p>
                This build runs inside a NIP-5D shell. Its storage and network
                access come from that shell.
              </p>
            </section>
          }
        >
          <Show
            when={initialized()}
            fallback={<p role="status">Connecting to shell storage…</p>}
          >
            <Show
              when={unlocked()}
              fallback={
                <section class="panel onboarding">
                  <p class="eyebrow">YOUR NOTES. YOUR CONTROL.</p>
                  <h1>
                    {exists() ? 'Welcome back.' : 'A home for your sats.'}
                  </h1>
                  <p>
                    Receive, hold and spend LNURLcash notes across independent
                    mints.
                  </p>
                  <div>
                    <label>
                      Wallet password
                      <input
                        type="password"
                        autocomplete={
                          exists() ? 'current-password' : 'new-password'
                        }
                        value={password()}
                        onInput={e => setPassword(e.currentTarget.value)}
                        required
                        minlength={exists() ? 1 : 12}
                      />
                    </label>
                    <Show when={!exists()}>
                      <label>
                        <input
                          type="checkbox"
                          checked={restoringSeed()}
                          onChange={e => {
                            setRestoringSeed(e.currentTarget.checked)
                            setSeed(
                              e.currentTarget.checked
                                ? ''
                                : generateSeedPhrase()
                            )
                            setSeedSaved(false)
                          }}
                        />{' '}
                        Restore an existing seed
                      </label>
                      <label>
                        BIP39 recovery phrase
                        <textarea
                          readonly={!restoringSeed()}
                          value={seed()}
                          autocomplete="off"
                          spellcheck={false}
                          onInput={e => setSeed(e.currentTarget.value)}
                        />
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={seedSaved()}
                          onChange={e => setSeedSaved(e.currentTarget.checked)}
                        />
                        I have saved my recovery phrase
                      </label>
                      <label>
                        Repeat password
                        <input
                          type="password"
                          autocomplete="new-password"
                          value={repeat()}
                          onInput={e => setRepeat(e.currentTarget.value)}
                          required
                          minlength="12"
                        />
                      </label>
                      <p class="hint">
                        Use 12 or more characters. Save an encrypted backup
                        after setup and whenever notes change. The seed uses the
                        same recovery derivation as the original webwallet. Keep
                        it private; it is not stored. A restored seed must scan
                        each mint before creating more notes there.
                      </p>
                    </Show>
                    <Show when={exists()}>
                      <label>
                        <input
                          type="checkbox"
                          checked={resettingPassword()}
                          onChange={e => {
                            setResettingPassword(e.currentTarget.checked)
                            setSeed('')
                          }}
                        />{' '}
                        Reset password with my seed
                      </label>
                      <Show when={resettingPassword()}>
                        <label>
                          Recovery phrase
                          <textarea
                            value={seed()}
                            autocomplete="off"
                            spellcheck={false}
                            onInput={e => setSeed(e.currentTarget.value)}
                          />
                        </label>
                        <label>
                          Repeat new password
                          <input
                            type="password"
                            autocomplete="new-password"
                            value={repeat()}
                            onInput={e => setRepeat(e.currentTarget.value)}
                          />
                        </label>
                      </Show>
                    </Show>
                    <button
                      class="primary"
                      disabled={busy()}
                      onClick={() => void run(authenticate)}
                    >
                      {busy()
                        ? 'Opening…'
                        : exists()
                          ? resettingPassword()
                            ? 'Reset password and unlock'
                            : 'Unlock wallet'
                          : 'Create wallet'}
                    </button>
                  </div>
                </section>
              }
            >
              <section class="balance">
                <div>
                  <p class="eyebrow">CONFIRMED NOTES</p>
                  <h1>
                    {sats(
                      notes()
                        .filter(n => n.status === 'ready')
                        .reduce((sum, n) => sum + n.amount, 0)
                    )}
                    <span> sats</span>
                  </h1>
                  <p>
                    {notes().filter(n => n.status === 'ready').length} available
                    notes · balances stay separate by mint
                  </p>
                </div>
                <span class="badge">ENCRYPTED IN SHELL STORAGE</span>
              </section>
              <nav aria-label="Wallet sections">
                <For each={['wallet', 'receive', 'pay', 'mint', 'backup']}>
                  {value => (
                    <button
                      classList={{active: tab() === value}}
                      disabled={busy()}
                      onClick={() => {
                        setTab(value)
                        setShared('')
                      }}
                    >
                      {value[0].toUpperCase() + value.slice(1)}
                    </button>
                  )}
                </For>
              </nav>
              <label class="wallet-more">
                More wallet tools
                <select
                  aria-label="More wallet tools"
                  value={
                    [
                      'recovery',
                      'transfer',
                      'mints',
                      'activity',
                      'settings',
                      'device'
                    ].includes(tab())
                      ? tab()
                      : ''
                  }
                  disabled={busy()}
                  onChange={e => {
                    if (e.currentTarget.value) setTab(e.currentTarget.value)
                  }}
                >
                  <option value="">Choose a tool</option>
                  <option value="transfer">Transfer between mints</option>
                  <option value="recovery">Seed recovery</option>
                  <option value="mints">Mints & signing keys</option>
                  <option value="activity">Activity</option>
                  <option value="settings">Settings</option>
                  <option value="device">
                    Physical vault (USB / Bluetooth)
                  </option>
                </select>
              </label>
              <Show when={preferences().offline}>
                <p class="notice">
                  Offline mode · stored notes remain available. Enable network
                  access in Settings to transact.
                </p>
              </Show>
              <Show when={lockWarning()}>
                <p class="notice" role="status">
                  Wallet locks in less than 30 seconds.{' '}
                  <button onClick={touch}>Keep unlocked</button>
                </p>
              </Show>
              <Show when={request()}>
                <section
                  class="request"
                  role="dialog"
                  aria-label="Review wallet request"
                >
                  <p class="eyebrow">REQUEST FROM ANOTHER NAPPLET</p>
                  <h2>
                    {request()?.action === 'design'
                      ? 'A new note design'
                      : request()?.action === 'pay'
                        ? 'Review a payment'
                        : 'Review an incoming note'}
                  </h2>
                  <p>Sender: {request()?.sender}</p>
                  <Show
                    when={receivedDesign()}
                    fallback={
                      <p>
                        Review the details, then confirm the action yourself.
                      </p>
                    }
                  >
                    {draft => (
                      <>
                        <Banknote
                          amount={21000}
                          issuer="design.preview"
                          serial="PREVIEW"
                          design={draft()}
                          specimen
                        />
                        <p>
                          {selected().length
                            ? `Apply to ${selected().length} selected notes.`
                            : 'Apply as your collection’s default design.'}{' '}
                          The amount and issuer of your notes stay unchanged.
                        </p>
                      </>
                    )}
                  </Show>
                  <button class="primary" disabled={busy()} onClick={accept}>
                    {request()?.action === 'design'
                      ? 'Apply received design'
                      : 'Review details'}
                  </button>
                  <button disabled={busy()} onClick={() => setRequest(null)}>
                    Dismiss
                  </button>
                </section>
              </Show>
              <Show when={tab() === 'wallet'}>
                <section class="panel">
                  <div class="section-heading">
                    <h2>Your notes</h2>
                    <div class="section-tools">
                      <button
                        disabled={busy()}
                        onClick={() => setDesignOpen(!designOpen())}
                      >
                        Import design
                      </button>
                      <button
                        disabled={busy()}
                        onClick={() =>
                          void run(async () => {
                            setNotes(await vault.notes())
                          })
                        }
                      >
                        Reload
                      </button>
                    </div>
                  </div>
                  <Show when={designOpen()}>
                    <div class="design-drawer">
                      <h3>Apply a saved design</h3>
                      <p>
                        {selected().length
                          ? `Apply to ${selected().length} selected notes.`
                          : 'Choose a default design for your collection.'}
                      </p>
                      <p class="hint">
                        Paste a saved design below. This changes the artwork;
                        the amount and issuer stay tied to the actual note.
                      </p>
                      <label>
                        Design JSON
                        <textarea
                          value={designText()}
                          onInput={e => setDesignText(e.currentTarget.value)}
                        />
                      </label>
                      <button
                        disabled={busy() || !designText()}
                        onClick={() =>
                          void run(async () => {
                            await applyDesign(
                              parseDesign(JSON.parse(designText())),
                              selected()
                            )
                            setDesignText('')
                            setDesignOpen(false)
                          })
                        }
                      >
                        Apply design
                      </button>
                    </div>
                  </Show>
                  <Show
                    when={notes().length}
                    fallback={
                      <div class="empty">
                        <Banknote
                          amount={21000}
                          issuer="your.mint"
                          serial="PREVIEW"
                          design={DEFAULT_DESIGN}
                          specimen
                        />
                        <h3>Your first note starts here.</h3>
                        <p>
                          Receive a note from someone, or mint one by paying a
                          Lightning invoice.
                        </p>
                        <button
                          class="primary"
                          onClick={() => setTab('receive')}
                        >
                          Receive a note
                        </button>
                      </div>
                    }
                  >
                    <Show when={selected().length}>
                      <div class="actions">
                        <button
                          disabled={busy() || !selected().length}
                          onClick={() =>
                            void run(async () => {
                              for (const id of selected())
                                await wallet.refresh(id)
                              setSelected([])
                            })
                          }
                        >
                          Check selected
                        </button>
                        <button
                          disabled={busy() || selected().length !== 1}
                          onClick={() =>
                            void run(async () => {
                              await wallet.transform(selected(), 'rotate')
                              setSelected([])
                            })
                          }
                        >
                          Rotate
                        </button>
                        <button
                          disabled={busy() || selected().length < 2}
                          onClick={() =>
                            void run(async () => {
                              await wallet.transform(selected(), 'combine')
                              setSelected([])
                            })
                          }
                        >
                          Combine
                        </button>
                        <button
                          disabled={busy() || selected().length !== 1}
                          onClick={() =>
                            void run(async () => {
                              setShared(
                                await wallet.share(
                                  selected()[0],
                                  handoverFormat()
                                )
                              )
                              setSelected([])
                            })
                          }
                        >
                          Hand over
                        </button>
                      </div>
                      <label>
                        Handover format
                        <select
                          value={handoverFormat()}
                          onChange={e =>
                            setHandoverFormat(
                              e.currentTarget.value as ReturnType<
                                typeof handoverFormat
                              >
                            )
                          }
                        >
                          <option value="url">HTTPS note</option>
                          <option value="lnurl">LNURL</option>
                          <option value="lnurlw">LNURLw</option>
                          <option value="claim">Webwallet claim link</option>
                        </select>
                      </label>
                      <label class="split">
                        Split amount (sats)
                        <div class="input-action">
                          <input
                            aria-label="Split amount (sats)"
                            inputmode="decimal"
                            value={split()}
                            onInput={e => setSplit(e.currentTarget.value)}
                          />
                          <button
                            disabled={busy() || !selected().length}
                            onClick={() =>
                              void run(async () => {
                                await wallet.transform(
                                  selected(),
                                  'split',
                                  Number(split()) * 1000
                                )
                                setSelected([])
                              })
                            }
                          >
                            Split selected
                          </button>
                        </div>
                      </label>
                    </Show>
                    <div class="collection-tools">
                      <p class="hint">Tap a note to select it.</p>
                      <button
                        class="quiet"
                        onClick={() => {
                          setShowHistory(!showHistory())
                          setSelected([])
                        }}
                      >
                        {showHistory() ? 'Hide history' : 'Show history'}
                      </button>
                    </div>
                    <div class="note-grid">
                      <For each={visibleNotes()}>
                        {note => (
                          <article
                            class="note"
                            classList={{selected: selected().includes(note.id)}}
                          >
                            <input
                              type="checkbox"
                              aria-label={`Select ${sats(note.amount)} sats ${note.status}`}
                              checked={selected().includes(note.id)}
                              disabled={busy()}
                              onChange={() => toggle(note.id)}
                            />
                            <div class="note-body">
                              <button
                                class="note-art-button"
                                aria-label={`Select note artwork ${sats(note.amount)} sats`}
                                disabled={busy()}
                                onClick={() => toggle(note.id)}
                              >
                                <Banknote
                                  amount={note.amount}
                                  issuer={serverOf(note.url)}
                                  serial={note.id}
                                  design={
                                    designs()[note.designId ?? 'default'] ??
                                    DEFAULT_DESIGN
                                  }
                                />
                              </button>
                              <div class="section-heading">
                                <strong>
                                  {sats(note.amount)}{' '}
                                  <span class="soft">sats</span>
                                </strong>
                                <span class={`status ${note.status}`}>
                                  {note.status === 'spent'
                                    ? 'not outstanding'
                                    : note.status}
                                </span>
                              </div>
                              <p>{serverOf(note.url)}</p>
                              <Show when={note.label}>
                                <p class="note-label">{note.label}</p>
                              </Show>
                              <Show when={signedNote(note, pins())}>
                                <span class="badge">
                                  ISSUER SIGNATURE VERIFIED
                                </span>
                              </Show>
                              <small>{note.reason}</small>
                              <Show when={selected().includes(note.id)}>
                                <NoteTools
                                  note={note}
                                  wallet={wallet}
                                  busy={busy()}
                                  run={run}
                                />
                              </Show>
                              <Show
                                when={
                                  note.invoice && note.invoiceType === 'funding'
                                }
                              >
                                <button
                                  class="quiet"
                                  onClick={() => {
                                    setFundingInvoice(note.invoice!)
                                    setTab('mint')
                                  }}
                                >
                                  Show stored invoice
                                </button>
                              </Show>
                            </div>
                          </article>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Show when={shared()}>
                    <div class="reveal">
                      <h3>Hand this note to its next holder.</h3>
                      <p>
                        Anyone with this link can spend it. It is now excluded
                        from your balance.
                      </p>
                      <QRCodeSVG
                        value={shared()}
                        level={ErrorCorrectionLevel.LOW}
                        width={180}
                        height={180}
                        backgroundColor="white"
                        backgroundAlpha={1}
                        foregroundColor="black"
                        foregroundAlpha={1}
                      />
                      <textarea
                        aria-label="Bearer note for handover"
                        readonly
                        value={shared()}
                        onFocus={e => e.currentTarget.select()}
                      />
                      <button onClick={() => setShared('')}>Hide note</button>
                    </div>
                  </Show>
                </section>
              </Show>
              <Show when={tab() === 'receive'}>
                <section class="panel">
                  <h2>Receive a note</h2>
                  <p>
                    Confirm to store the note and rotate its secret with the
                    issuing mint.
                  </p>
                  <label>
                    LNURLcash note
                    <textarea
                      placeholder="lnurlw://… or LNURL1…"
                      value={input()}
                      onInput={e => setInput(e.currentTarget.value)}
                    />
                  </label>
                  <button
                    class="primary"
                    disabled={busy() || !input().trim()}
                    onClick={() =>
                      void run(async () => {
                        await wallet.receive(input())
                        setInput('')
                        setTab('wallet')
                        setMessage('Note received and rotated.')
                      })
                    }
                  >
                    Confirm receive & rotate
                  </button>
                </section>
              </Show>
              <Show when={tab() === 'pay'}>
                <section class="panel">
                  <details>
                    <summary>Pay a Lightning address</summary>
                    <label>
                      Lightning address or LNURL-pay
                      <input
                        list="payment-addresses"
                        value={paymentAddress()}
                        onInput={e => setPaymentAddress(e.currentTarget.value)}
                      />
                    </label>
                    <datalist id="payment-addresses">
                      <For each={savedPaymentAddresses()}>
                        {address => <option value={address} />}
                      </For>
                    </datalist>
                    <label>
                      Payment amount (sats)
                      <input
                        inputmode="decimal"
                        value={paymentAmount()}
                        onInput={e => setPaymentAmount(e.currentTarget.value)}
                      />
                    </label>
                    <button
                      disabled={busy() || !paymentAddress() || !paymentAmount()}
                      onClick={() =>
                        void run(async () => {
                          setInvoice(
                            await wallet.paymentInvoice(
                              paymentAddress(),
                              Number(paymentAmount()) * 1000
                            )
                          )
                        })
                      }
                    >
                      Get invoice for review
                    </button>
                  </details>
                  <h2>Pay a Lightning invoice</h2>
                  <label>
                    BOLT11 invoice
                    <textarea
                      placeholder="lnbc…"
                      value={invoice()}
                      onInput={e => setInvoice(e.currentTarget.value)}
                    />
                  </label>
                  <p class="amount-review">
                    Invoice amount:{' '}
                    <strong>
                      {sats(decodeBolt11AmountMsat(invoice()) ?? 0)} sats
                    </strong>
                  </p>
                  <label>
                    Note to spend
                    <select
                      aria-label="Note to spend"
                      value={selected()[0] ?? ''}
                      onChange={e =>
                        setSelected(
                          e.currentTarget.value ? [e.currentTarget.value] : []
                        )
                      }
                    >
                      <option value="">Choose a note</option>
                      <For each={notes().filter(n => n.status === 'ready')}>
                        {note => (
                          <option value={note.id}>
                            {sats(note.amount)} sats · {serverOf(note.url)}
                          </option>
                        )}
                      </For>
                    </select>
                  </label>
                  <p class="hint">
                    Select several notes in your collection to combine them, or
                    prepare change from a larger note. Review the final amount
                    before confirming payment. Settlement is checked
                    automatically when the mint supplies a verification URL.
                  </p>
                  <Show when={selected().length && invoice()}>
                    <button
                      disabled={busy()}
                      onClick={() =>
                        void run(async () => {
                          setSelected([
                            await wallet.preparePayment(selected(), invoice())
                          ])
                          setMessage(
                            'Exact payment note prepared. Review and confirm payment.'
                          )
                        })
                      }
                    >
                      Prepare exact payment note
                    </button>
                  </Show>
                  <button
                    class="primary"
                    disabled={
                      busy() || selected().length !== 1 || !invoice().trim()
                    }
                    onClick={() =>
                      void run(async () => {
                        await wallet.pay(selected()[0], invoice())
                        setInvoice('')
                        setSelected([])
                        setTab('wallet')
                        setMessage(
                          'Payment submitted. Settlement is not yet confirmed.'
                        )
                      })
                    }
                  >
                    Confirm payment
                  </button>
                </section>
              </Show>
              <Show when={tab() === 'mint'}>
                <section class="panel">
                  <h2>Mint a new note</h2>
                  <p>
                    Choose a mint, then pay its invoice with your Lightning
                    wallet.
                  </p>
                  <label>
                    Mint URL or Lightning address
                    <input
                      placeholder="you@mint.example"
                      list="mint-addresses"
                      value={mint()}
                      onInput={e => setMint(e.currentTarget.value)}
                    />
                  </label>
                  <datalist id="mint-addresses">
                    <For each={savedMintAddresses()}>
                      {address => <option value={address} />}
                    </For>
                  </datalist>
                  <label>
                    Amount (sats)
                    <input
                      inputmode="decimal"
                      value={amount()}
                      onInput={e => setAmount(e.currentTarget.value)}
                    />
                  </label>
                  <button
                    class="primary"
                    disabled={busy() || !mint() || !amount()}
                    onClick={() =>
                      void run(async () => {
                        setFundingInvoice(
                          await wallet.mint(mint(), Number(amount()) * 1000)
                        )
                      })
                    }
                  >
                    Create funding invoice
                  </button>
                  <Show when={fundingInvoice()}>
                    <div class="reveal">
                      <QRCodeSVG
                        value={fundingInvoice()}
                        level={ErrorCorrectionLevel.LOW}
                        width={180}
                        height={180}
                        backgroundColor="white"
                        backgroundAlpha={1}
                        foregroundColor="black"
                        foregroundAlpha={1}
                      />
                      <textarea
                        aria-label="Funding invoice"
                        readonly
                        value={fundingInvoice()}
                        onFocus={e => e.currentTarget.select()}
                      />
                      <p>
                        After paying, select the pending note under Wallet and
                        choose “Check selected”. Mint fees may reduce its final
                        value.
                      </p>
                    </div>
                  </Show>
                </section>
              </Show>
              <Show when={tab() === 'backup'}>
                <section class="panel">
                  <h2>Keep a recovery copy</h2>
                  <p>
                    Keep the encrypted backup and your password. Shell upgrades
                    may use a new storage scope. Pending notes are included.
                  </p>
                  <button
                    class="primary"
                    disabled={busy()}
                    onClick={() =>
                      void run(async () => {
                        setBackup(await vault.backup())
                      })
                    }
                  >
                    Prepare encrypted backup
                  </button>
                  <Show when={backup()}>
                    <label>
                      Encrypted backup — select and save as a .json file
                      <textarea
                        class="backup"
                        readonly
                        value={backup()}
                        onFocus={e => e.currentTarget.select()}
                      />
                    </label>
                  </Show>
                  <hr />
                  <h3>Import a napplet backup</h3>
                  <p>Notes merge into this wallet; existing notes are kept.</p>
                  <label>
                    Backup JSON
                    <textarea
                      value={restoreText()}
                      onInput={e => setRestoreText(e.currentTarget.value)}
                    />
                  </label>
                  <label>
                    Backup password
                    <input
                      type="password"
                      autocomplete="off"
                      value={backupPassword()}
                      onInput={e => setBackupPassword(e.currentTarget.value)}
                    />
                  </label>
                  <button
                    disabled={busy() || !restoreText() || !backupPassword()}
                    onClick={() =>
                      void run(async () => {
                        const added = await vault.restore(
                          restoreText(),
                          backupPassword()
                        )
                        setRestoreText('')
                        setBackupPassword('')
                        setMessage(
                          `Imported ${added} notes. Check them online before using.`
                        )
                      })
                    }
                  >
                    Import encrypted notes
                  </button>
                </section>
              </Show>
              <WalletTools
                tab={tab()}
                vault={vault}
                wallet={wallet}
                notes={notes()}
                busy={busy()}
                revision={revision()}
                preferences={preferences()}
                onPreferences={changePreferences}
                run={run}
              />
            </Show>
            <Show when={busy()}>
              <p class="notice" role="status">
                Working… keep the wallet open.
              </p>
            </Show>
            <Show when={message() && !busy()}>
              <p class="notice" role="status">
                {message()}
              </p>
            </Show>
          </Show>
        </Show>
      </main>
      <footer>
        LNURLcash · MIT licensed · Host-mediated storage & network
        <br />A balance is a claim on its issuing mint. Back up after every
        change.
      </footer>
    </div>
  )
}

render(() => <App />, document.getElementById('root')!)
