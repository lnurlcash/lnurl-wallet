import type {Component} from 'solid-js'
import {Show, For, createSignal} from 'solid-js'
import {A, useNavigate, useSearchParams} from '@solidjs/router'
import {IoRefreshSharp, IoSearchSharp, IoTrashSharp} from 'solid-icons/io'

import {useWallet} from '../WalletContext'
import {generateSeedPhrase, isValidSeedPhrase} from '../keys'
import {notify, NotifyKind, msatToSats} from '../helpers'
import {resolveMintInput} from '../lnurlcash'
import {PUBLIC_MINTS} from '../trustedMints'
import {scanMintForNotes} from '../recovery'
import {gapLimit} from '../gapLimit'
import {mergeCashSecretIndices} from '../cashSecrets'

type Tab = 'create' | 'restore'

// the linking key's ciphertext sits in localStorage AND travels inside
// every backup file by design, so this password is the only thing between
// an offline brute-force and every note the wallet holds - a one-character
// password is no password at all
export const MIN_PASSWORD_LENGTH = 8

const Setup: Component = () => {
  const {setup, state} = useWallet()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [tab, setTab] = createSignal<Tab>(
    searchParams.tab === 'restore' ? 'restore' : 'create'
  )
  const [seedPhrase, setSeedPhrase] = createSignal<string | null>(null)
  const [restorePhrase, setRestorePhrase] = createSignal('')
  const [confirmed, setConfirmed] = createSignal(false)
  // encrypting the linking key is the default - opting out is possible but
  // means anyone with access to this browser profile can read the wallet
  const [encrypt, setEncrypt] = createSignal(true)
  const [setupPassword, setSetupPassword] = createSignal('')
  const [confirmPassword, setConfirmPassword] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  // set once a seed restore succeeds (never for "create new" - a fresh
  // seed has nothing to recover) - holds on the recovery step (see
  // MintRecovery below) instead of navigating straight to /wallet
  const [showRecovery, setShowRecovery] = createSignal(false)

  const generate = () => {
    setSeedPhrase(generateSeedPhrase())
    setConfirmed(false)
  }

  const passwordOk = () =>
    !encrypt() ||
    (setupPassword().length >= MIN_PASSWORD_LENGTH &&
      setupPassword() === confirmPassword())

  const finishSetup = async (phrase: string) => {
    if (encrypt() && setupPassword().length < MIN_PASSWORD_LENGTH) {
      notify(
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        NotifyKind.ERROR
      )
      return
    }
    if (encrypt() && setupPassword() !== confirmPassword()) {
      notify('Passwords do not match.', NotifyKind.ERROR)
      return
    }
    setBusy(true)
    try {
      await setup(
        phrase,
        encrypt() ? setupPassword() : undefined,
        tab() === 'create'
      )
      notify('Wallet ready.', NotifyKind.SUCCESS)
      // a restored seed may have notes at mints this device doesn't know
      // about yet - offer to scan for them before landing in an empty
      // wallet. A freshly generated seed has nothing to recover, so
      // "create new" skips straight to /wallet as before.
      if (tab() === 'restore') {
        setShowRecovery(true)
      } else {
        navigate('/wallet')
      }
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setBusy(false)
    }
  }

  const restore = async () => {
    if (!isValidSeedPhrase(restorePhrase())) {
      notify('Not a valid BIP39 seed phrase.', NotifyKind.ERROR)
      return
    }
    await finishSetup(restorePhrase().trim().toLowerCase())
  }

  return (
    <Show
      when={!showRecovery()}
      fallback={<MintRecovery onDone={() => navigate('/wallet')} />}
    >
      <div id="setup" class="page">
        <h2>Set up your wallet</h2>
        <Show when={state() !== 'none'}>
          <p class="warning">
            A wallet already exists on this device - setting up a new one
            replaces its linking key. Stored bearer tokens encrypted with the
            old key will stay in local storage but become unreadable until that
            seed is restored again.
          </p>
        </Show>
        <div class="tabs">
          <button
            classList={{active: tab() === 'create'}}
            onClick={() => setTab('create')}
          >
            Create new
          </button>
          <button
            classList={{active: tab() === 'restore'}}
            onClick={() => setTab('restore')}
          >
            Restore from seed
          </button>
        </div>
        <div class="setup-card">
          <Show when={tab() === 'create'}>
            <Show
              when={seedPhrase()}
              fallback={
                <>
                  <p>
                    A fresh seed phrase is generated in your browser - it is the
                    master key to your wallet and the only way to recover your
                    encrypted bearer tokens on another device.
                  </p>
                  <div class="btns">
                    <button onClick={generate}>Generate seed phrase</button>
                  </div>
                </>
              }
            >
              <label>
                Your seed phrase - write it down, it is never stored anywhere:
              </label>
              <pre>{seedPhrase()}</pre>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed()}
                  onChange={e => setConfirmed(e.currentTarget.checked)}
                />
                &nbsp;I have saved my seed phrase somewhere safe
              </label>
              <EncryptChoice
                encrypt={encrypt()}
                setEncrypt={setEncrypt}
                password={setupPassword()}
                setPassword={setSetupPassword}
                confirmPassword={confirmPassword()}
                setConfirmPassword={setConfirmPassword}
              />
              <div class="btns">
                <button
                  disabled={busy() || !confirmed() || !passwordOk()}
                  onClick={() => finishSetup(seedPhrase()!)}
                >
                  <Show when={busy()}>
                    <IoRefreshSharp class="spin" />
                    &nbsp;
                  </Show>
                  Continue
                </button>
                <button onClick={() => setSeedPhrase(null)}>Cancel</button>
              </div>
            </Show>
          </Show>
          <Show when={tab() === 'restore'}>
            <label>Your 12-word BIP39 seed phrase</label>
            <textarea
              rows="3"
              placeholder="twelve words separated by spaces"
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
              data-1p-ignore
              data-lpignore="true"
              value={restorePhrase()}
              onInput={e => setRestorePhrase(e.currentTarget.value)}
            />
            <EncryptChoice
              encrypt={encrypt()}
              setEncrypt={setEncrypt}
              password={setupPassword()}
              setPassword={setSetupPassword}
              confirmPassword={confirmPassword()}
              setConfirmPassword={setConfirmPassword}
            />
            <div class="btns">
              <button
                disabled={busy() || !restorePhrase().trim() || !passwordOk()}
                onClick={restore}
              >
                <Show when={busy()}>
                  <IoRefreshSharp class="spin" />
                  &nbsp;
                </Show>
                Restore wallet
              </button>
            </div>
          </Show>
          <p>
            Restoring straight from a backup file instead - no seed phrase
            needed, as long as you still know its password - happens on the{' '}
            <A href="/settings">Settings</A> page.
          </p>
        </div>
      </div>
    </Show>
  )
}

const EncryptChoice: Component<{
  encrypt: boolean
  setEncrypt: (v: boolean) => void
  password: string
  setPassword: (v: string) => void
  confirmPassword: string
  setConfirmPassword: (v: string) => void
}> = props => (
  <>
    <label>
      <input
        type="checkbox"
        checked={props.encrypt}
        onChange={e => props.setEncrypt(e.currentTarget.checked)}
      />
      &nbsp;Store my linking key encrypted, with a password (recommended)
    </label>
    <Show
      when={props.encrypt}
      fallback={
        <p class="warning">
          Without a password the linking key sits in local storage in plaintext
          - anyone using this browser profile can spend your LNURLcash.
        </p>
      }
    >
      <input
        type="password"
        placeholder="Password to encrypt the linking key"
        autocomplete="new-password"
        autocapitalize="off"
        spellcheck={false}
        value={props.password}
        onInput={e => props.setPassword(e.currentTarget.value)}
      />
      <input
        type="password"
        placeholder="Confirm password"
        autocomplete="new-password"
        autocapitalize="off"
        spellcheck={false}
        value={props.confirmPassword}
        onInput={e => props.setConfirmPassword(e.currentTarget.value)}
      />
      <Show
        when={
          props.password.length > 0 &&
          props.password.length < MIN_PASSWORD_LENGTH
        }
      >
        <p class="warning">
          At least {MIN_PASSWORD_LENGTH} characters - this password is the only
          thing standing between an offline brute-force and your notes.
        </p>
      </Show>
      <Show
        when={props.confirmPassword && props.password !== props.confirmPassword}
      >
        <p class="warning">Passwords do not match.</p>
      </Show>
    </Show>
  </>
)

// LUD-25 seed-recoverable notes (see recovery.ts): shown once right after a
// seed restore, since that's the one moment this wallet knows nothing about
// its own history yet - there's no way to discover which mints to scan from
// the seed alone, so the holder picks from the public list or types an
// address, same two ways Mint.tsx already offers for minting itself.
// "Skip" always works: this step never blocks reaching the wallet, and
// nothing here is a one-shot chance - the same seed can scan the same mint
// again later.
const MintRecovery: Component<{onDone: () => void}> = props => {
  const {bearers, addBearer, logActivity} = useWallet()
  const [selected, setSelected] = createSignal<string[]>([])
  const [customInput, setCustomInput] = createSignal('')
  const [customMints, setCustomMints] = createSignal<string[]>([])
  const [scanning, setScanning] = createSignal(false)
  const [results, setResults] = createSignal<
    Record<
      string,
      {
        status: 'scanning' | 'done' | 'error'
        index: number
        foundCount: number
        error?: string
      }
    >
  >({})

  const togglePublicMint = (mint: string) => {
    setSelected(prev =>
      prev.includes(mint) ? prev.filter(m => m !== mint) : [...prev, mint]
    )
  }

  const addCustomMint = () => {
    const value = customInput().trim()
    if (!value) return
    if (!resolveMintInput(value)) {
      notify('Not a recognizable mint address or LNURL.', NotifyKind.ERROR)
      return
    }
    if (!customMints().includes(value)) {
      setCustomMints(prev => [...prev, value])
    }
    setCustomInput('')
  }

  const removeCustomMint = (mint: string) => {
    setCustomMints(prev => prev.filter(m => m !== mint))
  }

  const mintsToScan = () => [...selected(), ...customMints()]

  const runScan = async () => {
    const mints = mintsToScan()
    if (mints.length === 0 || scanning()) return
    setScanning(true)
    setResults({})
    let totalFound = 0
    let totalMsat = 0
    try {
      for (const mint of mints) {
        setResults(prev => ({
          ...prev,
          [mint]: {status: 'scanning', index: 0, foundCount: 0}
        }))
        const result = await scanMintForNotes(
          mint,
          index => {
            setResults(prev => ({...prev, [mint]: {...prev[mint], index}}))
          },
          bearers()
        )
        for (const note of result.recovered) {
          await addBearer(note)
          logActivity(
            'recovered',
            `Recovered ${msatToSats(note.amount)} sats from ${result.server} while restoring from seed.`
          )
        }
        if (result.highestUsedIndex !== null) {
          mergeCashSecretIndices({
            [result.server]: result.highestUsedIndex + 1
          })
        }
        totalFound += result.recovered.length
        totalMsat += result.recovered.reduce((sum, n) => sum + n.amount, 0)
        setResults(prev => ({
          ...prev,
          [mint]: {
            status: result.error ? 'error' : 'done',
            index: prev[mint]?.index ?? 0,
            foundCount: result.recovered.length,
            error: result.error
          }
        }))
      }
      notify(
        totalFound > 0
          ? `Recovered ${totalFound} note${totalFound === 1 ? '' : 's'} (${msatToSats(totalMsat)} sats).`
          : 'No recoverable notes found at the scanned mints.',
        NotifyKind.SUCCESS
      )
    } finally {
      setScanning(false)
    }
  }

  return (
    <div id="setup" class="page">
      <h2>Recover notes</h2>
      <div class="setup-card">
        <p>
          Re-derives every note secret this wallet would have generated at each
          mint below (LUD-25's seed-recoverable secrets) and checks which ones
          are still outstanding. This only finds notes minted, rotated, split or
          merged by a seed-aware version of this wallet - not ones simply
          received from someone else, and not ones minted while offline or with
          an older version that predates this feature. Each mint is checked
          index by index until {gapLimit()} in a row turn up nothing, the same
          gap-limit convention HD wallets already use for address recovery
          (configurable under Settings &gt; Recovery scan gap limit). Pick every
          mint you remember using; nothing is lost by skipping one now, the same
          seed can scan it again later.
        </p>
        <label>Public mints</label>
        <div class="form-item">
          <For each={PUBLIC_MINTS}>
            {address => (
              <label class="recovery-mint-option">
                <input
                  type="checkbox"
                  checked={selected().includes(address)}
                  onChange={() => togglePublicMint(address)}
                />
                &nbsp;{address}
              </label>
            )}
          </For>
        </div>
        <label>Add by address</label>
        <div class="paste-input-row">
          <div class="paste-input-wrapper">
            <input
              type="text"
              placeholder="lnurl1... or mint@example.com"
              value={customInput()}
              onInput={e => setCustomInput(e.currentTarget.value)}
              onKeyDown={e => e.key === 'Enter' && addCustomMint()}
            />
          </div>
          <button type="button" onClick={addCustomMint}>
            Add
          </button>
        </div>
        <Show when={customMints().length > 0}>
          <div class="mint-picker">
            <For each={customMints()}>
              {mint => (
                <span class="mint-picker-entry">
                  {mint}
                  <button
                    type="button"
                    class="icon-btn"
                    title="Remove"
                    onClick={() => removeCustomMint(mint)}
                  >
                    <IoTrashSharp />
                  </button>
                </span>
              )}
            </For>
          </div>
        </Show>
        <Show when={Object.keys(results()).length > 0}>
          <div class="form-item">
            <For each={mintsToScan()}>
              {mint => {
                const result = () => results()[mint]
                return (
                  <Show when={result()}>
                    {r => (
                      <p
                        class={
                          r().status === 'error' ? 'warning' : 'bearer-hint'
                        }
                      >
                        {mint}:{' '}
                        <Show when={r().status === 'scanning'}>
                          checking index {r().index}...
                        </Show>
                        <Show when={r().status === 'done'}>
                          {r().foundCount > 0
                            ? `${r().foundCount} note${r().foundCount === 1 ? '' : 's'} found`
                            : 'nothing found'}
                        </Show>
                        <Show when={r().status === 'error'}>{r().error}</Show>
                      </p>
                    )}
                  </Show>
                )
              }}
            </For>
          </div>
        </Show>
        <div class="btns">
          <button
            disabled={scanning() || mintsToScan().length === 0}
            onClick={runScan}
          >
            <Show when={scanning()} fallback={<IoSearchSharp />}>
              <IoRefreshSharp class="spin" />
            </Show>
            &nbsp;Scan
          </button>
          <button disabled={scanning()} onClick={props.onDone}>
            {Object.keys(results()).length > 0 ? 'Continue to wallet' : 'Skip'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default Setup
