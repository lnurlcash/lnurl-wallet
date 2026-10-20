import type {Component} from 'solid-js'
import {Show, createSignal} from 'solid-js'
import {IoRefreshSharp, IoSearchSharp} from 'solid-icons/io'

import Dialog from './Dialog'
import IndexMap, {type IndexMapCells} from './IndexMap'
import {useWallet} from '../WalletContext'
import {offlineMode} from '../offlineMode'
import {notify, NotifyKind, msatToSats} from '../helpers'
import {serverOf} from '../lnurlcash'
import {
  hasCashRoot,
  nextCashAddressSecretIndex,
  nextChangeSecretIndex,
  mergeCashAddressSecretIndices,
  mergeCashChangeSecretIndices
} from '../cashSecrets'
import {
  scanMintForNotes,
  type IndexStatus,
  type MintScanPass
} from '../recovery'

export type RescanDialogProps = {
  server: string
  onClose: () => void
}

// LUD-25 recovery of this mint's own seed-derived bearer notes
// (recovery.ts's scanMintForNotes - notes this wallet minted/rotated/
// split/merged directly here), walking the wallet and change counters in
// turn. Opened from the trusted-mint card's own "Rescan" button on the
// Mint page. A registered username@mint address's own notes are a
// separate counter, checked from the Address page instead (see
// AddressScanDialog) - this dialog is the same with or without one.
//
// NOTE: the two scans still walk two DIFFERENT branches for historical
// reasons - this one derives its domain via serverOf() (bare host), the
// address-aware one via the full origin - see addressRecovery.ts's own
// cashAddressBranch callers vs recovery.ts's. Unifying that key space
// would need src/lib/request.ts's generatePubkeySecret to also switch
// conventions, which is a real, separate, higher-stakes migration.
const RescanDialog: Component<RescanDialogProps> = props => {
  const {bearers, addBearer, logActivity} = useWallet()

  const [mintBusy, setMintBusy] = createSignal(false)
  const [mintProgress, setMintProgress] = createSignal<{
    index: number
    pass: MintScanPass
  } | null>(null)
  // what the latest pass saw at each index, per counter - drawn by
  // IndexMap, filled in live as the scan goes and kept after it ends
  const [walletCells, setWalletCells] = createSignal<IndexMapCells>({})
  const [changeCells, setChangeCells] = createSignal<IndexMapCells>({})
  const setCell =
    (set: typeof setWalletCells) => (index: number, status: IndexStatus) =>
      set(prev => ({...prev, [index]: status}))
  // blank = 0, same as before these fields existed
  const [walletStartInput, setWalletStartInput] = createSignal('')
  const [changeStartInput, setChangeStartInput] = createSignal('')
  // this device's own next-unused counters for this mint (cashSecrets.ts,
  // plain localStorage - not reactive), re-read after each pass since a
  // pass that finds notes raises them
  const readCounters = () => ({
    wallet: nextCashAddressSecretIndex(serverOf(props.server)),
    change: nextChangeSecretIndex(serverOf(props.server))
  })
  const [counters, setCounters] = createSignal(readCounters())

  const parseStart = (raw: string): number | null => {
    const typed = raw.trim()
    if (typed === '') return 0
    const n = Number(typed)
    return Number.isInteger(n) && n >= 0 ? n : null
  }

  const rescanMintBearerNotes = async () => {
    if (mintBusy()) return
    const walletStart = parseStart(walletStartInput())
    const changeStart = parseStart(changeStartInput())
    if (walletStart === null || changeStart === null) {
      notify(
        'Start indices must be whole numbers, 0 or more.',
        NotifyKind.ERROR
      )
      return
    }
    setMintBusy(true)
    setMintProgress(null)
    setWalletCells({})
    setChangeCells({})
    try {
      // scanMintForNotes resolves input the same narrow way resolveMintInput
      // does (bech32/Lightning Address/bare domain) - props.server is the
      // full https://... origin (see serviceOriginOf), which that parser
      // rejects outright, so this needs the bare host serverOf() strips it
      // down to
      const result = await scanMintForNotes(
        serverOf(props.server),
        (index, pass) => setMintProgress({index, pass}),
        bearers(),
        {
          walletStart,
          changeStart,
          onIndex: (index, status, pass) =>
            setCell(pass === 'wallet' ? setWalletCells : setChangeCells)(
              index,
              status
            )
        }
      )
      for (const note of result.recovered) {
        await addBearer(note)
        logActivity(
          'recovered',
          `Recovered ${msatToSats(note.amount)} sats from ${result.server} while rescanning.`
        )
      }
      if (result.highestUsedIndex !== null) {
        mergeCashAddressSecretIndices({
          [result.server]: result.highestUsedIndex + 1
        })
      }
      if (result.highestUsedChangeIndex !== null) {
        mergeCashChangeSecretIndices({
          [result.server]: result.highestUsedChangeIndex + 1
        })
      }
      if (result.error) {
        notify(result.error, NotifyKind.ERROR)
      } else {
        notify(
          result.recovered.length > 0
            ? `Recovered ${result.recovered.length} note${result.recovered.length === 1 ? '' : 's'} (${msatToSats(result.recovered.reduce((sum, n) => sum + n.amount, 0))} sats).`
            : 'No missing notes found at this mint.',
          NotifyKind.SUCCESS
        )
      }
    } finally {
      setMintBusy(false)
      setMintProgress(null)
      setCounters(readCounters())
    }
  }

  return (
    <Dialog onClose={props.onClose}>
      <h4>
        <IoSearchSharp />
        &nbsp;Rescan {serverOf(props.server)}
      </h4>
      <p class="bearer-label">This mint's own bearer notes</p>
      <p class="bearer-hint">
        Notes this wallet minted/rotated/split/merged directly here - lost
        locally on this device, a sync gap, or after a seed restore. Wallet
        notes and split change notes are two separate index counters, each
        scanned in turn.
      </p>
      <p class="bearer-hint">
        This device's next wallet index: {counters().wallet} · next change
        index: {counters().change}
      </p>
      <label for="rescan-wallet-start">Wallet notes start index</label>
      <input
        id="rescan-wallet-start"
        type="number"
        min="0"
        step="1"
        placeholder="0"
        value={walletStartInput()}
        disabled={mintBusy()}
        onInput={e => setWalletStartInput(e.currentTarget.value)}
        onKeyDown={e => e.key === 'Enter' && rescanMintBearerNotes()}
      />
      <label for="rescan-change-start">Change notes start index</label>
      <input
        id="rescan-change-start"
        type="number"
        min="0"
        step="1"
        placeholder="0"
        value={changeStartInput()}
        disabled={mintBusy()}
        onInput={e => setChangeStartInput(e.currentTarget.value)}
        onKeyDown={e => e.key === 'Enter' && rescanMintBearerNotes()}
      />
      <p class="bearer-hint">
        Leave blank to start from 0. Indices up to the gap limit below a start
        index are re-checked too.
      </p>
      <div class="btns">
        <button
          disabled={offlineMode() || !hasCashRoot() || mintBusy()}
          title={
            offlineMode()
              ? 'Offline mode is on'
              : !hasCashRoot()
                ? 'No seed loaded for this wallet - restore your seed again first'
                : 'Rescan this mint for seed-derived notes missing from this wallet (LUD-25)'
          }
          onClick={rescanMintBearerNotes}
        >
          <Show when={mintBusy()} fallback={<IoSearchSharp />}>
            <IoRefreshSharp class="spin" />
          </Show>
          &nbsp;Rescan
        </button>
      </div>
      <Show when={mintProgress()}>
        {progress => (
          <p class="scan-progress">
            Checking {progress().pass === 'wallet' ? 'wallet' : 'change'} index{' '}
            <strong>{progress().index}</strong>
          </p>
        )}
      </Show>
      <IndexMap
        label="Wallet notes"
        cells={walletCells()}
        current={
          mintProgress()?.pass === 'wallet' ? mintProgress()!.index : null
        }
      />
      <IndexMap
        label="Change notes"
        cells={changeCells()}
        current={
          mintProgress()?.pass === 'change' ? mintProgress()!.index : null
        }
      />
    </Dialog>
  )
}
export default RescanDialog
