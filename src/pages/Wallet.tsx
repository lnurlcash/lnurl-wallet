import type {Component} from 'solid-js'
import {Show, For, createSignal, createMemo, onMount, onCleanup} from 'solid-js'
import {render} from 'solid-js/web'
import {A} from '@solidjs/router'
import {QRCodeSVG, ErrorCorrectionLevel} from 'solid-qr-code'
import {
  IoAddCircleSharp,
  IoLockOpenSharp,
  IoRefreshSharp,
  IoTrashSharp,
  IoGitMergeSharp,
  IoGitBranchSharp,
  IoSwapHorizontalSharp,
  IoBanSharp,
  IoCloseCircleSharp,
  IoSearchSharp,
  IoCloseSharp,
  IoArrowUpSharp,
  IoArrowDownSharp,
  IoLayersSharp,
  IoDownloadSharp,
  IoPencilSharp,
  IoQrCodeSharp,
  IoClipboardSharp,
  IoReturnDownForwardSharp,
  IoEllipsisVerticalSharp,
  IoSwapVerticalSharp
} from 'solid-icons/io'
import {MdSharpKeyboard} from 'solid-icons/md'

import {useWallet, groupByServer} from '../WalletContext'
import type {Bearer} from '../storage'
import {
  serverOf,
  toBech32Lnurl,
  isBolt11Invoice,
  isLightningAddress,
  isValidNoteInput
} from '../lnurlcash'
import {
  noteK1,
  requireNoteK1,
  withNewK1,
  fetchNoteInfo,
  rotateNote,
  mergeNotes,
  splitNote,
  settleNote,
  probeBurnedNote,
  NoteSpentError,
  AmbiguousMutationError
} from '../lnurlcash'
import {
  deviceRefresh,
  migrateNoteToDevice,
  markDeviceNoteSpent,
  deviceMerge,
  deviceSplit,
  deviceSettle,
  requireDeviceClient
} from '../deviceOrchestration'
import {useDevice} from '../DeviceContext'
import {offlineMode} from '../offlineMode'
import {
  noteSortKey,
  setNoteSortKey,
  noteSortDesc,
  setNoteSortDesc,
  noteGroupByMint,
  setNoteGroupByMint
} from '../notePrefs'
import {notify, NotifyKind, msatToSats, pasteFromClipboard} from '../helpers'
import {takeMeltInvoice} from '../meltHandoff'
import {receiveIntoWallet} from '../receive'
import BearerCard from '../components/BearerCard'
import Dialog from '../components/Dialog'
import TransferDialog from '../components/TransferDialog'
import MeltDialog from '../components/MeltDialog'
import ScanToggle from '../components/ScanToggle'
import NfcToggle from '../components/NfcToggle'
import FiatValue from '../components/FiatValue'

const Wallet: Component = () => {
  const {
    state,
    bearers,
    unlock,
    addBearer,
    updateBearer,
    removeBearer,
    logActivity
  } = useWallet()
  const {client: deviceClient} = useDevice()
  const [password, setPassword] = createSignal('')
  const [unlocking, setUnlocking] = createSignal(false)
  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const [confirmClearSpent, setConfirmClearSpent] = createSignal(false)
  // collapsed by default, same reasoning MintGroupCard used to have per
  // mint - now a single wallet-wide toggle since notes no longer live in
  // separate per-mint sections
  const [showSpent, setShowSpent] = createSignal(false)
  const [searchQuery, setSearchQuery] = createSignal('')
  // the search field starts collapsed to a plain button, like the other
  // list-controls toggles - opening it mounts the actual input (see the
  // ref below, which focuses it the moment it appears)
  const [showSearch, setShowSearch] = createSignal(false)
  let searchInputRef: HTMLInputElement | undefined
  // remembered across reloads (see notePrefs.ts) instead of always
  // resetting to Updated/descending/ungrouped
  const sortKey = noteSortKey
  const setSortKey = setNoteSortKey
  const sortDesc = noteSortDesc
  const setSortDesc = setNoteSortDesc
  const groupByMint = noteGroupByMint
  const setGroupByMint = setNoteGroupByMint
  const [combining, setCombining] = createSignal(false)
  const [showSplitInput, setShowSplitInput] = createSignal(false)
  const [splitSats, setSplitSats] = createSignal('')
  const [splitting, setSplitting] = createSignal(false)
  // refresh/label/mark-spent act on every selected note at once; split
  // (still one note in, two out) stays limited to exactly one - all moved
  // here from BearerCard so they live in the same action bar as
  // Combine/Combine & split/Transfer, instead of each note carrying its own
  // copy of these buttons
  const [refreshing, setRefreshing] = createSignal(false)
  // separate from refreshing above (which is scoped to the current
  // selection) - Refresh all acts on every unspent note regardless of
  // what's selected, so it needs its own spinner state
  const [refreshingAll, setRefreshingAll] = createSignal(false)
  const [showSplitSingleInput, setShowSplitSingleInput] = createSignal(false)
  const [splitSingleSats, setSplitSingleSats] = createSignal('')
  const [splitSingleTimes, setSplitSingleTimes] = createSignal('1')
  const [splittingSingle, setSplittingSingle] = createSignal(false)
  const [showLabelInput, setShowLabelInput] = createSignal(false)
  const [labelInputValue, setLabelInputValue] = createSignal('')
  // Label/Mark spent/Export/QR live behind this toggle instead of the
  // primary action row - closes on an outside click, same as any other
  // dropdown, and on picking one of its own items (see the click handlers
  // below that wrap each item's action)
  const [showMoreMenu, setShowMoreMenu] = createSignal(false)
  let moreMenuRef: HTMLDivElement | null = null
  // same collapse-behind-one-button treatment as More below, for the same
  // reason: Amount vs. Updated (plus each one's own direction) was four
  // buttons/states fighting for space next to a plain "Sort:" label -
  // one button showing the active choice, a panel for picking the other
  const [showSortMenu, setShowSortMenu] = createSignal(false)
  let sortMenuRef: HTMLDivElement | null = null
  // Rotate all/Remove all spent - wallet-wide actions that don't depend on
  // a selection, so they live up here rather than in .selection-toolbar's
  // own More (which only ever shows once something is selected) - same
  // collapse-behind-one-button treatment as that one and Sort above
  const [showListMoreMenu, setShowListMoreMenu] = createSignal(false)
  let listMoreMenuRef: HTMLDivElement | null = null
  onMount(() => {
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (moreMenuRef && !moreMenuRef.contains(target)) {
        setShowMoreMenu(false)
      }
      if (sortMenuRef && !sortMenuRef.contains(target)) {
        setShowSortMenu(false)
      }
      if (listMoreMenuRef && !listMoreMenuRef.contains(target)) {
        setShowListMoreMenu(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    onCleanup(() => document.removeEventListener('mousedown', onDocClick))
  })
  // captured once Transfer is clicked, independent of live selection -
  // starting a transfer immediately marks the source spent, which would
  // otherwise drop it out of selectedEligible() and yank the dialog out
  // from under itself mid-flight
  const [transferSource, setTransferSource] = createSignal<Bearer | null>(null)
  // mutually exclusive - opening one closes the other rather than letting
  // both dialogs be up (and independently mutating wallet state) at once.
  // No 'send' anymore - carving an exact amount out of one or more notes is
  // already covered by this page's own Combine & split / Split toolbar
  // actions, so a standalone Send dialog was pure duplication
  const [openDialog, setOpenDialog] = createSignal<'melt' | null>(null)
  const showMelt = () => openDialog() === 'melt'
  // a bolt11 pasted into Receive hands off here (see meltHandoff.ts) rather
  // than duplicating invoice-vs-note detection on this page too - MeltDialog
  // reads it once as its own initialInvoice, pre-filled instead of a blank
  // paste step
  const [meltHandoffInvoice, setMeltHandoffInvoice] = createSignal<
    string | null
  >(null)
  onMount(() => {
    const pr = takeMeltInvoice()
    if (pr && isBolt11Invoice(pr)) {
      setMeltHandoffInvoice(pr)
      setOpenDialog('melt')
    }
  })

  // the hero's own scan/NFC/paste widget replaces the separate
  // Receive/Send/Melt buttons it used to have - whatever's recognized
  // decides which dialog opens, instead of making the holder pick the
  // right button before they've even entered anything
  const [heroValue, setHeroValue] = createSignal('')
  let heroPasteRef: HTMLInputElement | null = null
  // the hero paste field is hidden behind a keyboard icon on mobile (see
  // .paste-keyboard-btn) - scan/NFC/clipboard-paste cover the common case,
  // typing is the fallback. Desktop ignores this signal entirely (CSS only
  // hides the field under the mobile breakpoint)
  const [showHeroKeyboard, setShowHeroKeyboard] = createSignal(false)
  // a scanned/pasted bearer note redeems immediately - no confirmation
  // dialog in between, unlike ReceiveDialog's own review-first flow for a
  // vault handoff link (Claim.tsx), where there's an actual reason to
  // pause: the person hasn't asked for anything yet, they've just followed
  // a link. Here they scanned or pasted with clear intent to receive.
  const [heroReceiving, setHeroReceiving] = createSignal(false)
  // same idea as meltHandoffInvoice above, for a scanned/pasted Lightning
  // Address that doesn't have an invoice yet - MeltDialog resolves it via
  // its own initialAddress
  const [meltHandoffAddress, setMeltHandoffAddress] = createSignal<
    string | null
  >(null)

  const closeMelt = () => {
    setOpenDialog(null)
    setMeltHandoffInvoice(null)
    setMeltHandoffAddress(null)
  }

  const isValidHeroInput = (v: string) =>
    isValidNoteInput(v) || isBolt11Invoice(v) || isLightningAddress(v)

  // re-entrancy-guarded the same way ReceiveDialog's own receive is: a
  // scanner double-fire or Enter-key/confirm-click landing together must
  // not run two receives for the same k1
  const receiveHero = async (noteValue: string) => {
    if (heroReceiving()) return
    setHeroReceiving(true)
    try {
      await receiveIntoWallet(noteValue, {
        bearers: bearers(),
        addBearer,
        updateBearer,
        logActivity,
        deviceClient: deviceClient()
      })
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setHeroReceiving(false)
    }
  }

  const handleHeroValue = (raw: string) => {
    const trimmed = raw.trim()
    if (trimmed === '') return
    if (isValidNoteInput(trimmed)) {
      setHeroValue('')
      receiveHero(trimmed)
      return
    }
    if (isBolt11Invoice(trimmed)) {
      setMeltHandoffInvoice(trimmed)
      setHeroValue('')
      setOpenDialog('melt')
      return
    }
    if (isLightningAddress(trimmed)) {
      setMeltHandoffAddress(trimmed)
      setHeroValue('')
      setOpenDialog('melt')
      return
    }
    notify(
      'Not a bearer note, invoice, or Lightning Address.',
      NotifyKind.ERROR
    )
  }

  const handleHero = () => {
    if (heroValue() === '') return
    handleHeroValue(heroValue())
  }

  const pasteHero = async () => {
    const text = await pasteFromClipboard()
    if (text === null) return
    setHeroValue(text)
    setShowHeroKeyboard(true)
    heroPasteRef?.focus()
    handleHeroValue(text)
  }

  const onHeroScan = (raw: string) => {
    setHeroValue(raw)
    handleHeroValue(raw)
  }

  // the hero's balance/mint count is always the spendable view (excludes
  // spent notes) - "Total balance" shouldn't count sats that aren't
  // actually yours to spend anymore.
  const spendableBearers = createMemo(() => bearers().filter(b => !b.spent))
  const spentBearers = createMemo(() => bearers().filter(b => b.spent))
  const spentCount = createMemo(() => spentBearers().length)
  const spendableTotal = createMemo(() =>
    spendableBearers().reduce((sum, b) => sum + b.amount, 0)
  )
  const spentTotal = createMemo(() =>
    spentBearers().reduce((sum, b) => sum + b.amount, 0)
  )
  const mintCount = createMemo(() => groupByServer(spendableBearers()).length)

  // notes no longer live in per-mint sections - one flat list for the
  // whole wallet, always ordered by the chosen sort criteria below
  const visibleBearers = createMemo(() =>
    showSpent() ? bearers() : bearers().filter(b => !b.spent)
  )

  // matches either the issuing mint's hostname or the note's sat amount -
  // msatToSats formats with locale thousands separators (e.g. "1,000"),
  // which would never match a plain typed "1000", so amount matching goes
  // straight off the raw sats value instead
  const filteredBearers = createMemo(() => {
    const q = searchQuery().trim().toLowerCase()
    if (!q) return visibleBearers()
    return visibleBearers().filter(
      b =>
        serverOf(b.url).toLowerCase().includes(q) ||
        String(Math.floor(b.amount / 1000)).includes(q)
    )
  })

  const sortedBearers = createMemo(() => {
    const key = sortKey()
    const factor = sortDesc() ? -1 : 1
    return [...filteredBearers()].sort((a, b) => {
      const diff =
        key === 'amount' ? a.amount - b.amount : a.updatedAt - b.updatedAt
      return diff * factor
    })
  })

  // clicking the same sort button again flips direction instead of doing
  // nothing; switching to a different key starts it off descending
  // (highest amount / most recently updated first - the more common ask)
  const toggleSort = (key: 'amount' | 'updated') => {
    if (sortKey() === key) setSortDesc(!sortDesc())
    else {
      setSortKey(key)
      setSortDesc(true)
    }
  }

  // every mint present in the currently filtered/sorted view, in the order
  // they first appear there - the grouping Show below renders one heading
  // + sub-list per entry instead of one flat grid
  const groupedBearers = createMemo(() => {
    const groups = new Map<string, Bearer[]>()
    for (const b of sortedBearers()) {
      const server = serverOf(b.url)
      const list = groups.get(server)
      if (list) list.push(b)
      else groups.set(server, [b])
    }
    return [...groups.entries()]
  })

  // combine/split/transfer only ever act on notes from one mint, so the
  // selection itself enforces that instead of just silently disabling the
  // buttons once it's already mixed: picking a note from a different mint
  // than what's currently selected starts a fresh selection with just that
  // note, rather than adding to a mix that could never do anything anyway
  const toggleSelect = (id: string, isSelected: boolean) => {
    if (!isSelected) {
      setSelected(prev => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      return
    }
    const bearer = bearers().find(b => b.id === id)
    const server = bearer && serverOf(bearer.url)
    const current = selectedServer()
    setSelected(prev => {
      if (server && current && server !== current) return new Set([id])
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }

  // combine/split/transfer all require every selected note to share one
  // issuing mint - toggleSelect above is what actually enforces that as
  // notes are picked, this just reads back the mint that's currently
  // selected (if any) so toggleSelect knows when a click should start a
  // fresh selection instead of extending the current one
  const selectedBearers = createMemo(() =>
    bearers().filter(b => selected().has(b.id))
  )
  const selectedServer = createMemo(() => {
    const servers = new Set(selectedBearers().map(b => serverOf(b.url)))
    return servers.size === 1 ? [...servers][0] : null
  })
  const selectedEligible = createMemo(() =>
    selectedBearers().filter(b => b.callback !== '' && !b.spent)
  )
  const canCombine = createMemo(() => selectedEligible().length >= 2)
  const canTransfer = createMemo(() => selectedEligible().length === 1)
  // refresh/label/mark-spent all work on any number of selected notes
  // regardless of verification (refresh is how a note becomes verified in
  // the first place) - selectedBearers is always all-unspent already,
  // since BearerCard's own click-to-select refuses a spent note to begin
  // with, so these just need at least one selected. Split needs the
  // stricter selectedEligible (verified + a callback) and stays limited to
  // exactly one, same as before
  const canRefreshSelected = createMemo(() => selectedBearers().length > 0)
  const canMarkSpentSelected = createMemo(() => selectedBearers().length > 0)
  const canLabelSelected = createMemo(() => selectedBearers().length > 0)
  const canSplitSingle = createMemo(() => selectedEligible().length === 1)

  const unlockWallet = async (e: Event) => {
    e.preventDefault()
    setUnlocking(true)
    try {
      await unlock(password())
      setPassword('')
    } catch {
      notify('Incorrect password.', NotifyKind.ERROR)
    } finally {
      setUnlocking(false)
    }
  }

  const clearAllSpent = () => {
    const spent = spentBearers()
    for (const bearer of spent) removeBearer(bearer.id)
    setConfirmClearSpent(false)
    notify(
      `Cleared ${spent.length} spent note${spent.length === 1 ? '' : 's'}.`,
      NotifyKind.SUCCESS
    )
  }

  // a note's own url IS the bearer asset (see storage.ts) - one per line is
  // exactly what's needed to hand each off elsewhere (paste into another
  // wallet's Receive field, redeem directly, ...), no extra formatting to
  // strip first. bech32 (the "LNURL1..." form, same encoding Qr.tsx/Scan use
  // elsewhere in this wallet) rather than the raw https:// URL, since that's
  // the form other LNURL wallets actually expect pasted or scanned. Client-
  // side only, same download-a-Blob approach Backup.tsx already uses for the
  // full-wallet backup file.
  const exportSelected = () => {
    const picked = selectedBearers()
    if (picked.length === 0) return
    const text = picked.map(b => toBech32Lnurl(b.url)).join('\n') + '\n'
    const blob = new Blob([text], {type: 'text/plain'})
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `lnurlwallet-notes-${new Date().toISOString().slice(0, 10)}.txt`
    a.click()
    URL.revokeObjectURL(url)
    notify(
      `Exported ${picked.length} note${picked.length === 1 ? '' : 's'} to a text file.`,
      NotifyKind.SUCCESS
    )
  }

  // renders QRCodeSVG into a detached container just long enough to pull
  // its rendered <svg> back out - same trick Qr.tsx's own download button
  // uses (see its comment), just without ever attaching the container to
  // the visible page. render() (solid-js/web) mounts synchronously for
  // plain content like this, so the <svg> is there as soon as it returns.
  const svgForNote = (bearer: Bearer): string | null => {
    const container = document.createElement('div')
    const dispose = render(
      () => (
        <QRCodeSVG
          backgroundColor="white"
          backgroundAlpha={1}
          foregroundColor="black"
          foregroundAlpha={1}
          width={512}
          height={512}
          value={toBech32Lnurl(bearer.url)}
          level={ErrorCorrectionLevel.LOW}
        />
      ),
      container
    )
    const svg = container.querySelector('svg')
    const source = svg ? new XMLSerializer().serializeToString(svg) : null
    dispose()
    return source
  }

  // one .svg download per selected note - a single QR can only carry one
  // note's worth of data, so there's no meaningful "combined" file the way
  // the text export has; multiple notes just means multiple downloads,
  // triggered back to back the same way Export's own click already is
  const downloadQrSelected = () => {
    const picked = selectedBearers()
    if (picked.length === 0) return
    let downloaded = 0
    for (const bearer of picked) {
      const source = svgForNote(bearer)
      if (!source) continue
      const blob = new Blob([source], {type: 'image/svg+xml'})
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `lnurlwallet-note-${Math.floor(bearer.amount / 1000)}sats-${bearer.id.slice(0, 6)}.svg`
      a.click()
      URL.revokeObjectURL(url)
      downloaded++
    }
    notify(
      `Downloaded ${downloaded} QR code${downloaded === 1 ? '' : 's'} as SVG.`,
      NotifyKind.SUCCESS
    )
  }

  // The informational GET prefers h=sha256(k1), keeping the secret off the
  // wire on current services. Refresh still rotates to renew the note and to
  // handle the explicit raw-k1 compatibility fallback safely. When a vault is connected, that
  // replacement secret is generated and held there instead of in this
  // browser - for an already device-backed note that's deviceRefresh
  // (export, then GET+rotate with the same secret); for a browser-only
  // note it's a one-way migration onto the device (see
  // deviceOrchestration.ts's header comment). One note at a time - each
  // call already ends in its own notify()/logActivity() (unchanged from
  // the single-note version this was lifted from), so refreshing several
  // selected notes just reads as that many refreshes back to back, same as
  // clicking Refresh on each individually. Sequential, not Promise.all:
  // persistBearer reads localStorage fresh after its own encrypt step, so
  // concurrent writes here could race and clobber each other's records
  const refreshOneBearer = async (bearer: Bearer) => {
    try {
      const client = deviceClient()
      const deviceId = bearer.deviceId
      if (deviceId) {
        // A device-backed bearer's stored URL is deliberately only a
        // secret-free mirror. If its vault is disconnected, stop here with
        // the recovery action instead of falling through to fetchNoteInfo
        // and sending /w a request with neither k1 nor its device-held hash.
        const connectedClient = requireDeviceClient(client)
        const result = await deviceRefresh(connectedClient, {
          ...bearer,
          deviceId
        })
        await updateBearer(bearer.id, {
          url: result.url,
          callback: result.callback,
          amount: result.amountMsat,
          verified: true,
          mintPubkey: result.mintPubkey ?? bearer.mintPubkey,
          deviceId: result.deviceId,
          deviceHash: result.deviceHash
        })
        logActivity(
          'refresh',
          `Refreshed ${msatToSats(result.amountMsat)} sats from ${serverOf(result.url)} (on device).`,
          bearer.label
        )
        notify('Note refreshed.', NotifyKind.SUCCESS)
        return
      }

      const info = await fetchNoteInfo(bearer.url)

      if (client) {
        const migrated = await migrateNoteToDevice(client, {
          url: bearer.url,
          callback: info.callback,
          amount: info.maxWithdrawable
        })
        await updateBearer(bearer.id, {
          url: migrated.url,
          callback: migrated.callback,
          amount: info.maxWithdrawable,
          verified: true,
          mintPubkey: info.mintPubkey ?? bearer.mintPubkey,
          deviceId: migrated.deviceId,
          deviceHash: migrated.deviceHash
        })
        logActivity(
          'refresh',
          `Refreshed ${msatToSats(info.maxWithdrawable)} sats from ${serverOf(migrated.url)} - moved onto your vault.`,
          bearer.label
        )
        notify('Note refreshed and moved onto your vault.', NotifyKind.SUCCESS)
        return
      }

      let url = bearer.url
      let rotationError: string | null = null
      try {
        const rotated = await rotateNote(
          info.callback,
          requireNoteK1(bearer.url)
        )
        url = withNewK1(
          bearer.url,
          rotated.k1,
          info.maxWithdrawable,
          rotated.signature
        )
      } catch (err) {
        if (err instanceof AmbiguousMutationError) {
          // the rotate request may have landed despite the failure - the
          // fresh secret it carried is then the only copy of this note
          const outcome = await probeBurnedNote(bearer.url)
          if (outcome === 'gone') {
            // the burn landed - adopt the fresh secret as the note
            url = withNewK1(bearer.url, err.newSecrets[0], info.maxWithdrawable)
          } else if (outcome === 'unknown') {
            // can't tell: keep the old note AND track the possible new
            // copy, rather than gamble either way
            await addBearer({
              url: withNewK1(
                bearer.url,
                err.newSecrets[0],
                info.maxWithdrawable
              ),
              callback: info.callback,
              amount: info.maxWithdrawable,
              verified: false,
              mintPubkey: info.mintPubkey ?? bearer.mintPubkey
            })
            rotationError = `${(err as Error).message} The rotation may still have gone through - the possible new copy is stored unverified alongside this one; refresh both to reconcile.`
          } else {
            rotationError = (err as Error).message
          }
        } else {
          rotationError = (err as Error).message
        }
      }
      await updateBearer(bearer.id, {
        url,
        callback: info.callback,
        amount: info.maxWithdrawable,
        verified: true,
        mintPubkey: info.mintPubkey ?? bearer.mintPubkey
      })
      logActivity(
        'refresh',
        `Refreshed ${msatToSats(info.maxWithdrawable)} sats from ${serverOf(url)}.` +
          (rotationError ? ` Could not rotate (${rotationError}).` : ''),
        bearer.label
      )
      // the GET this refresh is nominally "about" is only ever a means to
      // the rotate - it succeeding on its own isn't worth telling the
      // holder about, so a failed rotate reports just the one thing that
      // actually matters (and is now exposed), not that plus an unrelated
      // "refreshed" success alongside it
      if (rotationError) {
        notify(
          `Could not rotate after refresh (${rotationError}) - your secret was just transmitted, treat old copies of this note as exposed.`,
          NotifyKind.ERROR
        )
      } else {
        notify('Note refreshed.', NotifyKind.SUCCESS)
      }
    } catch (err) {
      // the service just told us - unambiguously, this GET named exactly
      // this note's own k1 - that it's already spent. Trust it and lock
      // the note the same way markSpent() does, rather than leave it
      // sitting there looking spendable until someone notices by hand.
      if (err instanceof NoteSpentError) {
        await updateBearer(bearer.id, {spent: true})
        logActivity(
          'spent',
          `${serverOf(bearer.url)} reports ${msatToSats(bearer.amount)} sats as already spent - marked spent locally.`,
          bearer.label
        )
      }
      notify((err as Error).message, NotifyKind.ERROR)
    }
  }

  const refreshSelected = async () => {
    const picked = selectedBearers()
    if (picked.length === 0) return
    setRefreshing(true)
    try {
      for (const bearer of picked) {
        await refreshOneBearer(bearer)
      }
    } finally {
      setRefreshing(false)
    }
    setSelected(new Set<string>())
  }

  // every unspent note in the wallet, regardless of selection - same
  // one-at-a-time sequencing as refreshSelected, for the same reason
  // (persistBearer reads localStorage fresh per-write, so concurrent
  // refreshes could race and clobber each other's records)
  const refreshAllNotes = async () => {
    const picked = bearers().filter(b => !b.spent)
    if (picked.length === 0) return
    setRefreshingAll(true)
    try {
      for (const bearer of picked) {
        await refreshOneBearer(bearer)
      }
    } finally {
      setRefreshingAll(false)
    }
  }

  // a local-only lock (see storage.ts's Bearer.spent) - no network call,
  // just stops this wallet from acting on notes it considers given away.
  // A device-backed note's on-device copy is retired alongside (queued for
  // the next connect if the vault isn't attached right now), so the vault
  // doesn't keep listing as spendable a note this wallet considers gone
  const markSpentSelected = async () => {
    const picked = selectedBearers()
    if (picked.length === 0) return
    for (const bearer of picked) {
      updateBearer(bearer.id, {spent: true})
      if (bearer.deviceId) {
        await markDeviceNoteSpent(deviceClient(), bearer.deviceId)
      }
      logActivity(
        'spent',
        `Marked ${msatToSats(bearer.amount)} sats from ${serverOf(bearer.url)} as spent.`,
        bearer.label
      )
    }
    setSelected(new Set<string>())
    notify(
      `Marked ${picked.length} note${picked.length === 1 ? '' : 's'} as spent - split and refresh are locked until unspent.`,
      NotifyKind.SUCCESS
    )
  }

  // purely local, for the holder's own reference - not part of the note
  // itself, never sent anywhere. Applies the same text to every selected
  // note at once; prefilled with their shared label when they already all
  // carry the same one, otherwise blank rather than guessing which to show
  const openLabelInput = () => {
    const picked = selectedBearers()
    if (picked.length === 0) return
    const labels = new Set(picked.map(b => b.label ?? ''))
    setLabelInputValue(labels.size === 1 ? [...labels][0]! : '')
    setShowLabelInput(true)
  }

  const saveLabelSelected = () => {
    const picked = selectedBearers()
    if (picked.length === 0) return
    const trimmed = labelInputValue().trim()
    for (const bearer of picked) {
      updateBearer(bearer.id, {label: trimmed || undefined})
    }
    setShowLabelInput(false)
    setLabelInputValue('')
    setSelected(new Set<string>())
    notify(
      `Labeled ${picked.length} note${picked.length === 1 ? '' : 's'}.`,
      NotifyKind.SUCCESS
    )
  }

  // splitNote is only ever a 2-way split (one piece + a change note), so
  // splitting off the same amount `times` times means chaining that many
  // calls, each peeling one more piece off the still-unspent "change" from
  // the previous one - the leftover remainder (whatever's left after all of
  // them) becomes the final note. A failure partway through (network drop,
  // etc.) leaves whichever pieces already came back safely recorded as
  // bearers, but the in-flight call's own "change" secret isn't recorded
  // anywhere if its response never arrives - same exposure a single split
  // already has, just repeated per extra time
  const splitSingleSelected = async () => {
    if (!canSplitSingle()) return
    const bearer = selectedBearers()[0]
    // whole sats only - satsToMsat alone would round a typed fractional
    // sat (e.g. "10.5") to the nearest msat, not the nearest sat, so a
    // split note could otherwise end up worth a sub-sat amount that isn't
    // really spendable as its own unit
    const sats = Math.trunc(Number(splitSingleSats()))
    const msat = sats * 1000
    const times = parseInt(splitSingleTimes(), 10)
    if (!splitSingleSats() || !Number.isFinite(sats) || sats <= 0) {
      notify('Enter a whole number of sats.', NotifyKind.ERROR)
      return
    }
    if (!Number.isFinite(times) || times < 1) {
      notify('Enter how many times to split (1 or more).', NotifyKind.ERROR)
      return
    }
    if (msat * times >= bearer.amount) {
      notify(
        'Total split amount must be below the note value.',
        NotifyKind.ERROR
      )
      return
    }
    setSplittingSingle(true)
    try {
      // the still-unspent remainder is tracked as an actual stored bearer
      // throughout, starting as the selected note - never removed until a
      // split for it has actually succeeded. A rejected split (e.g.
      // "insufficient value" once its own base_fee_msat wouldn't leave
      // enough change - see LUD-25) still puts that remainder's k1 on the
      // wire via the failed callback request, so on failure it's rotated
      // in place (best-effort) rather than left exposed - but always kept,
      // never dropped, so a failed split costs nothing
      let remainderId = bearer.id
      let currentK1 = bearer.deviceId ? '' : requireNoteK1(bearer.url)
      let currentUrl = bearer.url
      let currentCallback = bearer.callback
      let currentAmount = bearer.amount
      let currentDeviceId = bearer.deviceId
      // a mint MAY charge a flat fee per split (LUD-25), deducted from the
      // change rather than the split-off amount - so the remainder is read
      // back authoritatively (informational GET) after each split instead
      // of just subtracting msat. Tracked per-iteration (perSplitFeeMsat,
      // the same on every iteration since it's a flat fee) as well as
      // summed (totalFeeMsat), so a multi-split report can say both "X per
      // split" and "Y total" instead of one ambiguous number that reads
      // like a single one-time deduction
      let totalFeeMsat = 0
      let perSplitFeeMsat = 0
      const client = deviceClient()
      if (bearer.deviceId) requireDeviceClient(client)
      for (let i = 0; i < times; i++) {
        const expectedChange = currentAmount - msat
        if (client) {
          // if a vault is connected, both outputs land on it - regardless
          // of whether the input being split was itself device-backed
          // (see deviceOrchestration.ts's "migration" note). No local
          // rotate-in-place fallback on failure here (unlike the
          // browser-only branch below): a failed device split never burns
          // its input (that only happens once the mint call succeeds), so
          // the existing remainder record is already correct as-is.
          const parts = await deviceSplit(
            client,
            [{deviceId: currentDeviceId, url: currentUrl}],
            currentCallback,
            msat,
            currentAmount
          )
          // past this point the input IS burned server-side, so both
          // outputs are tracked BEFORE the remainder record is removed -
          // otherwise a settle failure here would strand the change note
          // (CONFIRMED on the device) with no local record. A failed
          // settle still tracks a mirror of the raw output (unverified,
          // at its expected pre-fee amount) and stops the chain; the next
          // device refresh repairs it
          let settledChange = parts.change
          let changeVerified = false
          let settleError: Error | null = null
          try {
            settledChange = await deviceSettle(client, parts.change)
            changeVerified = true
          } catch (err) {
            settleError = new Error(
              `Settling the change note didn't complete (${(err as Error).message}) - it's kept as an unverified note; refresh it with the vault connected to repair.`
            )
          }
          await addBearer({
            url: parts.target.url,
            callback: parts.target.callback,
            amount: msat,
            verified: true,
            mintPubkey: bearer.mintPubkey,
            deviceId: parts.target.deviceId,
            deviceHash: parts.target.deviceHash
          })
          const remainder = await addBearer({
            url: settledChange.url,
            callback: settledChange.callback,
            amount: settledChange.amountMsat,
            verified: changeVerified,
            mintPubkey: bearer.mintPubkey,
            deviceId: settledChange.deviceId,
            deviceHash: settledChange.deviceHash
          })
          removeBearer(remainderId)
          remainderId = remainder.id
          if (settleError) throw settleError
          perSplitFeeMsat = expectedChange - settledChange.amountMsat
          totalFeeMsat += perSplitFeeMsat
          currentAmount = settledChange.amountMsat
          currentUrl = settledChange.url
          currentCallback = settledChange.callback
          currentDeviceId = settledChange.deviceId
          continue
        }

        let partK1 = ''
        let partSignature: string | undefined
        let changeK1 = ''
        let changeSignature: string | undefined
        let splitError: Error | null = null
        try {
          const result = await splitNote(currentCallback, [currentK1], msat)
          partK1 = result.k1
          partSignature = result.signature
          changeK1 = result.change
          changeSignature = result.changeSignature
        } catch (err) {
          splitError = err as Error
        }
        if (splitError) {
          // a single-k1 request, so a NoteSpentError here is unambiguous:
          // it's remainderId that's already gone, not some other selected
          // note - lock it the same way refresh does, and skip the
          // rotate-in-place attempt below (there's nothing left to rotate)
          if (splitError instanceof NoteSpentError) {
            await updateBearer(remainderId, {spent: true})
            logActivity(
              'spent',
              `${serverOf(currentUrl)} reports ${msatToSats(currentAmount)} sats as already spent - marked spent locally.`,
              bearer.label
            )
            throw splitError
          }
          if (splitError instanceof AmbiguousMutationError) {
            // the split request may have landed despite the failure -
            // probe the remainder's k1 before deciding what the secrets
            // it carried are worth
            const outcome = await probeBurnedNote(currentUrl)
            if (outcome === 'gone') {
              // the burn landed - the carried secrets are the only money
              // left; fall through to record both outputs below
              partK1 = splitError.newSecrets[0]
              changeK1 = splitError.newSecrets[1]
            } else if (outcome === 'unknown') {
              // can't tell: track both possible outputs without dropping
              // the remainder, and stop the chain here
              await addBearer({
                url: withNewK1(currentUrl, splitError.newSecrets[0], msat),
                callback: currentCallback,
                amount: msat,
                verified: false,
                mintPubkey: bearer.mintPubkey
              })
              await addBearer({
                url: withNewK1(
                  currentUrl,
                  splitError.newSecrets[1],
                  expectedChange
                ),
                callback: currentCallback,
                amount: expectedChange,
                verified: false,
                mintPubkey: bearer.mintPubkey
              })
              throw new Error(
                'The split may have gone through but could not be confirmed - the possible outputs are stored unverified alongside your original note; refresh them to reconcile.'
              )
            }
            // 'live': the request never landed - same as a definitive
            // rejection, handled below
          }
          if (!partK1) {
            // a definitive rejection (or a probe showing nothing burned)
            // still puts the remainder's k1 on the wire via the failed
            // callback request, so it's rotated in place (best-effort)
            // rather than left exposed - but always kept, never dropped,
            // so a failed split costs nothing
            try {
              const rotated = await rotateNote(currentCallback, currentK1)
              await updateBearer(remainderId, {
                url: withNewK1(
                  currentUrl,
                  rotated.k1,
                  currentAmount,
                  rotated.signature
                )
              })
            } catch (err) {
              // this rotate is itself a mutating request, so a transport
              // failure here is exactly as ambiguous as the split's own -
              // it may have landed despite the failure, and the fresh
              // secret it carries would then be the ONLY copy of the
              // remainder left (the pre-attempt one now burned). Silently
              // swallowing this (as this code used to) turned a purely
              // defensive "don't leave k1 exposed" step into real fund
              // loss: the remainder would vanish entirely, with neither
              // the old record (burned) nor the new secret (discarded)
              // pointing to real money - see issue report "split failed
              // due to minimum amount, note gone"
              if (err instanceof AmbiguousMutationError) {
                const outcome = await probeBurnedNote(currentUrl)
                if (outcome === 'gone') {
                  // the rotate landed - its carried secret is the only
                  // money left
                  await updateBearer(remainderId, {
                    url: withNewK1(currentUrl, err.newSecrets[0], currentAmount)
                  })
                } else if (outcome === 'unknown') {
                  // can't tell: keep the pre-rotate record (already
                  // shown below) AND track the possible rotated copy,
                  // rather than gamble either way
                  await addBearer({
                    url: withNewK1(
                      currentUrl,
                      err.newSecrets[0],
                      currentAmount
                    ),
                    callback: currentCallback,
                    amount: currentAmount,
                    verified: false,
                    mintPubkey: bearer.mintPubkey
                  })
                  notify(
                    "Couldn't confirm whether the remainder's defensive rotation went through - a possible rotated copy is stored unverified alongside it; refresh both to reconcile.",
                    NotifyKind.ERROR
                  )
                }
                // 'live': the rotate never landed - the pre-attempt secret
                // (already recorded) is still good, nothing to change
              }
              // any other failure (rotation unsupported/unreachable, a
              // definitive rejection) leaves the remainder recorded under
              // its pre-attempt secret rather than vanish
            }
            throw splitError
          }
        }
        // the split burned the remainder server-side from here on, so both
        // outputs are recorded BEFORE its record is removed; the change is
        // then settled in place - a failed settle leaves it as an
        // unverified note a refresh can repair, not a lost secret
        await addBearer({
          url: withNewK1(currentUrl, partK1, msat, partSignature),
          callback: currentCallback,
          amount: msat,
          verified: true,
          mintPubkey: bearer.mintPubkey
        })
        const remainder = await addBearer({
          url: withNewK1(currentUrl, changeK1, expectedChange, changeSignature),
          callback: currentCallback,
          amount: expectedChange,
          verified: false,
          mintPubkey: bearer.mintPubkey
        })
        removeBearer(remainderId)
        remainderId = remainder.id
        // settleNote learns the change's true value (a mint MAY have
        // deducted a fee - LUD-25) by hash, without another rotation
        try {
          const settled = await settleNote(
            currentUrl,
            changeK1,
            expectedChange,
            changeSignature
          )
          perSplitFeeMsat = expectedChange - settled.amountMsat
          totalFeeMsat += perSplitFeeMsat
          currentAmount = settled.amountMsat
          currentK1 = settled.k1
          currentUrl = withNewK1(
            currentUrl,
            settled.k1,
            settled.amountMsat,
            settled.signature
          )
          currentCallback = settled.callback
          await updateBearer(remainderId, {
            url: currentUrl,
            callback: currentCallback,
            amount: currentAmount,
            verified: true
          })
        } catch (err) {
          // the change is already recorded above - stop the chain with it
          // kept as an unverified note rather than risk splitting further
          // from a value this wallet hasn't confirmed
          throw new Error(
            `Settling the change note didn't complete (${(err as Error).message}) - it's kept as an unverified note; refresh it to repair.`
          )
        }
      }
      const feeNote =
        totalFeeMsat > 0
          ? times > 1
            ? ` ${msatToSats(perSplitFeeMsat)} sats fee deducted per split (${msatToSats(totalFeeMsat)} sats total).`
            : ` ${msatToSats(totalFeeMsat)} sats fee deducted from the remainder.`
          : ''
      logActivity(
        'split',
        `Split off ${times} note${times === 1 ? '' : 's'} of ${msatToSats(msat)} sats each from ${serverOf(bearer.url)}.${feeNote}`,
        bearer.label
      )
      notify(
        `Split off ${times} note${times === 1 ? '' : 's'} of ${msatToSats(msat)} sats each.${feeNote}`,
        NotifyKind.SUCCESS
      )
      setSelected(new Set<string>())
      setShowSplitSingleInput(false)
      setSplitSingleSats('')
      setSplitSingleTimes('1')
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setSplittingSingle(false)
    }
  }

  const combineSelected = async () => {
    const picked = selectedEligible()
    if (picked.length < 2) return
    setCombining(true)
    try {
      const [base] = picked
      const server = serverOf(base.url)
      const sum = picked.reduce((s, b) => s + b.amount, 0)
      let actualAmount: number
      const client = deviceClient()
      if (client) {
        // if a vault is connected, the merged note lands there instead -
        // regardless of whether any of the inputs were themselves
        // device-backed (mixed selections are fine, see
        // deviceOrchestration.ts)
        const merged = await deviceMerge(
          client,
          picked.map(b => ({deviceId: b.deviceId, url: b.url})),
          base.callback,
          sum
        )
        const settled = await deviceSettle(client, merged)
        actualAmount = settled.amountMsat
        for (const bearer of picked) removeBearer(bearer.id)
        await addBearer({
          url: settled.url,
          callback: settled.callback,
          amount: actualAmount,
          verified: true,
          mintPubkey: base.mintPubkey,
          deviceId: settled.deviceId,
          deviceHash: settled.deviceHash
        })
      } else {
        let mergedK1: string
        let mergedSignature: string | undefined
        try {
          const merged = await mergeNotes(
            base.callback,
            picked.map(b => requireNoteK1(b.url))
          )
          mergedK1 = merged.k1
          mergedSignature = merged.signature
        } catch (err) {
          if (!(err instanceof AmbiguousMutationError)) throw err
          // the merge request may have landed despite the failure - probe
          // one input before deciding what the carried secret is worth
          const outcome = await probeBurnedNote(base.url)
          if (outcome === 'live') throw err // nothing burned - plain failure
          if (outcome === 'unknown') {
            // can't tell: track the possible output without dropping the
            // inputs, and stop here
            await addBearer({
              url: withNewK1(base.url, err.newSecrets[0], sum),
              callback: base.callback,
              amount: sum,
              verified: false,
              mintPubkey: base.mintPubkey
            })
            throw new Error(
              'The combine may have gone through but could not be confirmed - the possible combined note is stored unverified alongside your originals; refresh them to reconcile.'
            )
          }
          // 'gone': the burn landed - the carried secret is the only money
          mergedK1 = err.newSecrets[0]
        }
        // the mint call above already burned every input server-side, so
        // the merged output is the only money left - it is stored BEFORE
        // any removeBearer of an input, then settled in place: a failed
        // settle leaves an unverified note a refresh can repair, not a
        // lost secret
        const added = await addBearer({
          url: withNewK1(base.url, mergedK1, sum, mergedSignature),
          callback: base.callback,
          amount: sum,
          verified: false,
          mintPubkey: base.mintPubkey
        })
        for (const bearer of picked) removeBearer(bearer.id)
        // a mint MAY refund part of its earlier per-note mint fees on merge
        // (LUD-25: (n - 1) * base_fee_msat back into the result) -
        // settleNote reads the actual value back authoritatively rather
        // than assume the naive sum. The hash lookup leaves the merged secret
        // untouched, while the stored amount and notice below still reflect
        // what the mint actually credited
        actualAmount = sum
        try {
          const settled = await settleNote(
            base.url,
            mergedK1,
            sum,
            mergedSignature
          )
          actualAmount = settled.amountMsat
          await updateBearer(added.id, {
            url: withNewK1(
              base.url,
              settled.k1,
              settled.amountMsat,
              settled.signature
            ),
            callback: settled.callback,
            amount: settled.amountMsat,
            verified: true
          })
        } catch (err) {
          notify(
            `Combined, but settling the new note didn't complete (${(err as Error).message}) - it's tracked unverified; refresh it to repair.`,
            NotifyKind.ERROR
          )
        }
      }
      setSelected(new Set<string>())
      // LUD-25 refunds (n - 1) * base_fee_msat on an n-note merge - the per-
      // note figure is exactly that division, same "X per unit (Y total)"
      // framing as BearerCard's split, so a combine of several notes
      // doesn't read as a single flat, ambiguous number either
      const creditMsat = actualAmount - sum
      const perNoteCreditMsat = creditMsat / (picked.length - 1)
      const creditNote =
        creditMsat > 0
          ? picked.length > 2
            ? ` ${msatToSats(perNoteCreditMsat)} sats fee credited per extra note (${msatToSats(creditMsat)} sats total).`
            : ` ${msatToSats(creditMsat)} sats fee credited back.`
          : ''
      logActivity(
        'combine',
        `Combined ${picked.length} notes from ${server} into ${msatToSats(actualAmount)} sats.${creditNote}`,
        base.label
      )
      notify(
        `Combined ${picked.length} notes into one.${creditNote}`,
        NotifyKind.SUCCESS
      )
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setCombining(false)
    }
  }

  // combine & split: same selection as combineSelected, but instead of
  // merging into one note, burns them all and mints two - splitSats() worth
  // and a change note for the remainder.
  const combineAndSplit = async () => {
    const picked = selectedEligible()
    if (picked.length < 2) return
    const sats = Math.trunc(Number(splitSats()))
    const msat = sats * 1000
    if (!splitSats() || !Number.isFinite(sats) || sats <= 0) {
      notify('Enter a whole number of sats.', NotifyKind.ERROR)
      return
    }
    const sum = picked.reduce((s, b) => s + b.amount, 0)
    if (msat >= sum) {
      notify('Split amount must be below the combined value.', NotifyKind.ERROR)
      return
    }
    setSplitting(true)
    try {
      const [base] = picked
      const server = serverOf(base.url)
      let targetAmount: number
      let changeAmount: number
      const client = deviceClient()
      if (client) {
        const parts = await deviceSplit(
          client,
          picked.map(b => ({deviceId: b.deviceId, url: b.url})),
          base.callback,
          msat,
          sum
        )
        for (const bearer of picked) removeBearer(bearer.id)
        await addBearer({
          url: parts.target.url,
          callback: parts.target.callback,
          amount: msat,
          verified: true,
          mintPubkey: base.mintPubkey,
          deviceId: parts.target.deviceId,
          deviceHash: parts.target.deviceHash
        })
        const settledChange = await deviceSettle(client, parts.change)
        targetAmount = msat
        changeAmount = settledChange.amountMsat
        await addBearer({
          url: settledChange.url,
          callback: settledChange.callback,
          amount: settledChange.amountMsat,
          verified: true,
          mintPubkey: base.mintPubkey,
          deviceId: settledChange.deviceId,
          deviceHash: settledChange.deviceHash
        })
      } else {
        let partK1 = ''
        let partSignature: string | undefined
        let changeK1 = ''
        let changeSignature: string | undefined
        let splitError: Error | null = null
        try {
          const result = await splitNote(
            base.callback,
            picked.map(b => requireNoteK1(b.url)),
            msat
          )
          partK1 = result.k1
          partSignature = result.signature
          changeK1 = result.change
          changeSignature = result.changeSignature
        } catch (err) {
          splitError = err as Error
        }
        if (splitError) {
          if (!(splitError instanceof AmbiguousMutationError)) throw splitError
          const outcome = await probeBurnedNote(base.url)
          if (outcome === 'live') throw splitError
          if (outcome === 'unknown') {
            await addBearer({
              url: withNewK1(base.url, splitError.newSecrets[0], msat),
              callback: base.callback,
              amount: msat,
              verified: false,
              mintPubkey: base.mintPubkey
            })
            await addBearer({
              url: withNewK1(base.url, splitError.newSecrets[1], sum - msat),
              callback: base.callback,
              amount: sum - msat,
              verified: false,
              mintPubkey: base.mintPubkey
            })
            throw new Error(
              'The split may have gone through but could not be confirmed - the possible outputs are stored unverified alongside your originals; refresh them to reconcile.'
            )
          }
          partK1 = splitError.newSecrets[0]
          changeK1 = splitError.newSecrets[1]
        }
        await addBearer({
          url: withNewK1(base.url, partK1, msat, partSignature),
          callback: base.callback,
          amount: msat,
          verified: true,
          mintPubkey: base.mintPubkey
        })
        const change = await addBearer({
          url: withNewK1(base.url, changeK1, sum - msat, changeSignature),
          callback: base.callback,
          amount: sum - msat,
          verified: false,
          mintPubkey: base.mintPubkey
        })
        for (const bearer of picked) removeBearer(bearer.id)
        targetAmount = msat
        changeAmount = sum - msat
        try {
          const settled = await settleNote(
            base.url,
            changeK1,
            sum - msat,
            changeSignature
          )
          changeAmount = settled.amountMsat
          await updateBearer(change.id, {
            url: withNewK1(
              base.url,
              settled.k1,
              settled.amountMsat,
              settled.signature
            ),
            callback: settled.callback,
            amount: settled.amountMsat,
            verified: true
          })
        } catch (err) {
          notify(
            `Split succeeded, but settling the change note didn't complete (${(err as Error).message}) - it's tracked unverified; refresh it to repair.`,
            NotifyKind.ERROR
          )
        }
      }
      setSelected(new Set<string>())
      const feeMsat = sum - msat - changeAmount
      const feeNote =
        feeMsat > 0
          ? ` ${msatToSats(feeMsat)} sats fee deducted from the change.`
          : ''
      logActivity(
        'split',
        `Combined ${picked.length} notes from ${server} and split into ${msatToSats(targetAmount)} + ${msatToSats(changeAmount)} sats.${feeNote}`,
        base.label
      )
      notify(
        `Split into ${msatToSats(targetAmount)} sats and ${msatToSats(changeAmount)} sats change.${feeNote}`,
        NotifyKind.SUCCESS
      )
      setShowSplitInput(false)
      setSplitSats('')
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    } finally {
      setSplitting(false)
    }
  }

  return (
    <Show
      when={state() !== 'none'}
      fallback={
        <div id="wallet" class="page">
          <div class="setup-card">
            <h2>No wallet on this device yet</h2>
            <p>Create one, or restore a seed phrase you already have.</p>
            <div class="btns">
              <A href="/setup" class="hero-btn hero-btn-primary">
                Create wallet
              </A>
            </div>
          </div>
        </div>
      }
    >
      <Show
        when={state() === 'unlocked'}
        fallback={
          <div id="unlock" class="page">
            <div class="setup-card">
              <h2>Unlock your wallet</h2>
              <form onSubmit={unlockWallet}>
                <input
                  type="password"
                  placeholder="Password"
                  autocomplete="current-password"
                  autocapitalize="off"
                  spellcheck={false}
                  value={password()}
                  onInput={e => setPassword(e.currentTarget.value)}
                />
                <div class="btns">
                  <button type="submit" disabled={unlocking() || !password()}>
                    <Show when={unlocking()} fallback={<IoLockOpenSharp />}>
                      <IoRefreshSharp class="spin" />
                    </Show>
                    &nbsp;Unlock
                  </button>
                </div>
              </form>
              <p>
                <A href="/setup?tab=restore">Forgot password?</A>
              </p>
            </div>
          </div>
        }
      >
        <Show
          when={bearers().length > 0}
          fallback={
            <div id="wallet" class="page">
              <section class="hero-intro">
                <h1>No LNURLcash yet</h1>
                <p class="hero-subtitle">
                  Your wallet is ready but empty. Mint a fresh bearer note from
                  any LNURLcash mint, or bring one in by scanning or pasting a
                  note someone handed you.
                </p>
                <div class="hero-actions">
                  <A href="/mint" class="hero-btn hero-btn-primary">
                    <IoAddCircleSharp />
                    &nbsp;Mint
                  </A>
                  <figure class="paste-widget hero-paste-widget">
                    <div class="paste-input-row">
                      <ScanToggle
                        onScan={onHeroScan}
                        accept={isValidHeroInput}
                      />
                      <NfcToggle
                        onScan={onHeroScan}
                        accept={isValidHeroInput}
                      />
                      <button
                        type="button"
                        class="icon-btn paste-icon-btn"
                        title="Paste from clipboard"
                        onClick={pasteHero}
                      >
                        <IoClipboardSharp />
                      </button>
                      <button
                        type="button"
                        class="icon-btn paste-keyboard-btn"
                        title="Type instead"
                        onClick={() => setShowHeroKeyboard(v => !v)}
                      >
                        <MdSharpKeyboard />
                      </button>
                      <div
                        class="paste-input-wrapper"
                        classList={{'mobile-open': showHeroKeyboard()}}
                      >
                        <input
                          ref={el => (heroPasteRef = el)}
                          type="text"
                          class="paste-input"
                          placeholder="Note, invoice, or Lightning Address..."
                          value={heroValue()}
                          onInput={e => setHeroValue(e.currentTarget.value)}
                          onKeyDown={e => e.key === 'Enter' && handleHero()}
                        />
                        <Show when={heroValue() !== ''}>
                          <button
                            type="button"
                            class="icon-btn paste-clear-btn"
                            title="Clear"
                            onClick={() => setHeroValue('')}
                          >
                            <IoCloseSharp />
                          </button>
                        </Show>
                      </div>
                      <button
                        type="button"
                        class="icon-btn paste-confirm-btn"
                        classList={{'mobile-open': showHeroKeyboard()}}
                        title="Receive a note, or pay an invoice/address"
                        disabled={heroValue() === '' || heroReceiving()}
                        onClick={handleHero}
                      >
                        <Show
                          when={heroReceiving()}
                          fallback={<IoReturnDownForwardSharp />}
                        >
                          <IoRefreshSharp class="spin" />
                        </Show>
                      </button>
                    </div>
                  </figure>
                </div>
                <Show when={showMelt()}>
                  <MeltDialog
                    initialInvoice={meltHandoffInvoice() ?? undefined}
                    initialAddress={meltHandoffAddress() ?? undefined}
                    onClose={closeMelt}
                  />
                </Show>
              </section>
            </div>
          }
        >
          <div id="wallet" class="page">
            <Show when={confirmClearSpent()}>
              <Dialog onClose={() => setConfirmClearSpent(false)}>
                <>
                  <h4>Remove all spent notes</h4>
                  <p class="warning">
                    Clear all {spentCount()} spent note
                    {spentCount() === 1 ? '' : 's'} from the wallet? If any of
                    them turn out not to have actually been spent, those sats
                    are gone unless you saved them elsewhere.
                  </p>
                  <div class="btns">
                    <button onClick={clearAllSpent}>Clear all</button>
                    <button onClick={() => setConfirmClearSpent(false)}>
                      Cancel
                    </button>
                  </div>
                </>
              </Dialog>
            </Show>
            <section class="wallet-hero">
              <div class="wallet-stats">
                <div class="wallet-stat">
                  <span class="wallet-stat-value">
                    {msatToSats(spendableTotal())} sats
                    <FiatValue msat={spendableTotal()} />
                  </span>
                  <span class="wallet-stat-label">Total balance</span>
                </div>
                <div class="wallet-stat">
                  <span class="wallet-stat-value">
                    {spendableBearers().length}
                  </span>
                  <span class="wallet-stat-label">
                    {spendableBearers().length === 1 ? 'Note' : 'Notes'}
                  </span>
                </div>
                <div class="wallet-stat">
                  <span class="wallet-stat-value">{mintCount()}</span>
                  <span class="wallet-stat-label">
                    {mintCount() === 1 ? 'Mint' : 'Mints'}
                  </span>
                </div>
                <Show when={spentCount() > 0}>
                  <div class="wallet-stat">
                    <span class="wallet-stat-value">
                      {msatToSats(spentTotal())} sats
                      <FiatValue msat={spentTotal()} />
                    </span>
                    <span class="wallet-stat-label">
                      Spent&nbsp;·&nbsp;{spentCount()}
                    </span>
                  </div>
                </Show>
              </div>
              <div class="btns">
                <A href="/mint" class="link-btn wallet-hero-btn">
                  <IoAddCircleSharp />
                  &nbsp;Mint
                </A>
                <div class="paste-widget hero-paste-widget">
                  <div class="paste-input-row">
                    <ScanToggle onScan={onHeroScan} accept={isValidHeroInput} />
                    <NfcToggle onScan={onHeroScan} accept={isValidHeroInput} />
                    <button
                      type="button"
                      class="icon-btn paste-icon-btn"
                      title="Paste from clipboard"
                      onClick={pasteHero}
                    >
                      <IoClipboardSharp />
                    </button>
                    <button
                      type="button"
                      class="icon-btn paste-keyboard-btn"
                      title="Type instead"
                      onClick={() => setShowHeroKeyboard(v => !v)}
                    >
                      <MdSharpKeyboard />
                    </button>
                    <div
                      class="paste-input-wrapper"
                      classList={{'mobile-open': showHeroKeyboard()}}
                    >
                      <input
                        ref={el => (heroPasteRef = el)}
                        type="text"
                        class="paste-input"
                        placeholder="Note, invoice, or Lightning Address..."
                        value={heroValue()}
                        onInput={e => setHeroValue(e.currentTarget.value)}
                        onKeyDown={e => e.key === 'Enter' && handleHero()}
                      />
                      <Show when={heroValue() !== ''}>
                        <button
                          type="button"
                          class="icon-btn paste-clear-btn"
                          title="Clear"
                          onClick={() => setHeroValue('')}
                        >
                          <IoCloseSharp />
                        </button>
                      </Show>
                    </div>
                    <button
                      type="button"
                      class="icon-btn paste-confirm-btn"
                      classList={{'mobile-open': showHeroKeyboard()}}
                      title="Receive a note, or pay an invoice/address"
                      disabled={heroValue() === '' || heroReceiving()}
                      onClick={handleHero}
                    >
                      <Show
                        when={heroReceiving()}
                        fallback={<IoReturnDownForwardSharp />}
                      >
                        <IoRefreshSharp class="spin" />
                      </Show>
                    </button>
                  </div>
                </div>
              </div>
            </section>
            <Show when={showMelt()}>
              <MeltDialog
                initialInvoice={meltHandoffInvoice() ?? undefined}
                initialAddress={meltHandoffAddress() ?? undefined}
                onClose={closeMelt}
              />
            </Show>

            <section class="list-controls">
              <div class="list-controls-row">
                <Show
                  when={showSearch()}
                  fallback={
                    <button
                      type="button"
                      class="search-toggle-btn"
                      title="Search notes by mint or amount"
                      onClick={() => setShowSearch(true)}
                    >
                      <IoSearchSharp />
                      <span class="btn-label">&nbsp;Search</span>
                    </button>
                  }
                >
                  <div class="search-input-wrapper">
                    <IoSearchSharp />
                    <input
                      ref={el => {
                        searchInputRef = el
                        el.focus()
                      }}
                      type="text"
                      class="search-input"
                      placeholder="Search by mint or amount..."
                      value={searchQuery()}
                      onInput={e => setSearchQuery(e.currentTarget.value)}
                    />
                    <Show when={searchQuery() !== ''}>
                      <button
                        type="button"
                        class="icon-btn"
                        title="Clear search"
                        onClick={() => {
                          setSearchQuery('')
                          searchInputRef?.focus()
                        }}
                      >
                        <IoCloseSharp />
                      </button>
                    </Show>
                    <button
                      type="button"
                      class="icon-btn"
                      title="Close search"
                      onClick={() => {
                        setShowSearch(false)
                        setSearchQuery('')
                      }}
                    >
                      <IoCloseCircleSharp />
                    </button>
                  </div>
                </Show>
                <div class="sort-menu" ref={el => (sortMenuRef = el)}>
                  <button
                    type="button"
                    class="sort-toggle-btn"
                    title={`Sort by ${sortKey()} (${sortDesc() ? 'descending' : 'ascending'})`}
                    onClick={() => setShowSortMenu(v => !v)}
                  >
                    <IoSwapVerticalSharp />
                    &nbsp;{sortKey() === 'amount' ? 'Amount' : 'Updated'}
                    &nbsp;
                    <Show when={sortDesc()} fallback={<IoArrowUpSharp />}>
                      <IoArrowDownSharp />
                    </Show>
                  </button>
                  <Show when={showSortMenu()}>
                    <div class="more-menu-panel">
                      <button
                        type="button"
                        classList={{active: sortKey() === 'amount'}}
                        onClick={() => {
                          toggleSort('amount')
                          setShowSortMenu(false)
                        }}
                      >
                        Amount
                        <Show when={sortKey() === 'amount'}>
                          &nbsp;
                          <Show when={sortDesc()} fallback={<IoArrowUpSharp />}>
                            <IoArrowDownSharp />
                          </Show>
                        </Show>
                      </button>
                      <button
                        type="button"
                        classList={{active: sortKey() === 'updated'}}
                        onClick={() => {
                          toggleSort('updated')
                          setShowSortMenu(false)
                        }}
                      >
                        Updated
                        <Show when={sortKey() === 'updated'}>
                          &nbsp;
                          <Show when={sortDesc()} fallback={<IoArrowUpSharp />}>
                            <IoArrowDownSharp />
                          </Show>
                        </Show>
                      </button>
                    </div>
                  </Show>
                </div>
                <Show when={spentCount() > 0}>
                  <button
                    type="button"
                    class="spent-btn"
                    classList={{active: showSpent()}}
                    title="Spent notes are locally locked (melted, or marked by hand) - this just shows or hides them, it doesn't change anything about them"
                    onClick={() => setShowSpent(v => !v)}
                  >
                    <IoBanSharp />
                    <span class="btn-label">&nbsp;Spent</span>
                    <Show when={!showSpent()}>&nbsp;({spentCount()})</Show>
                  </button>
                </Show>
                <button
                  type="button"
                  class="group-btn"
                  classList={{active: groupByMint()}}
                  title="Show notes grouped under their issuing mint instead of one flat list"
                  onClick={() => setGroupByMint(!groupByMint())}
                >
                  <IoLayersSharp />
                  <span class="btn-label">&nbsp;Group</span>
                </button>
                <div class="more-menu" ref={el => (listMoreMenuRef = el)}>
                  <button
                    type="button"
                    class="icon-btn list-more-btn"
                    title="More actions - rotate all, remove all spent"
                    onClick={() => setShowListMoreMenu(v => !v)}
                  >
                    <IoEllipsisVerticalSharp />
                  </button>
                  <Show when={showListMoreMenu()}>
                    <div class="more-menu-panel">
                      <button
                        type="button"
                        disabled={
                          refreshingAll() ||
                          offlineMode() ||
                          spendableBearers().length === 0
                        }
                        title={
                          offlineMode()
                            ? 'Offline mode is on'
                            : 'Rotate every unspent note in the wallet, one at a time'
                        }
                        onClick={() => {
                          refreshAllNotes()
                          setShowListMoreMenu(false)
                        }}
                      >
                        <Show
                          when={refreshingAll()}
                          fallback={<IoRefreshSharp />}
                        >
                          <IoRefreshSharp class="spin" />
                        </Show>
                        &nbsp;Rotate all
                      </button>
                      <Show when={spentCount() > 0}>
                        <button
                          type="button"
                          title={`Clear all ${spentCount()} spent note${spentCount() === 1 ? '' : 's'} from the wallet`}
                          onClick={() => {
                            setConfirmClearSpent(true)
                            setShowListMoreMenu(false)
                          }}
                        >
                          <IoTrashSharp />
                          &nbsp;Remove all spent
                        </button>
                      </Show>
                    </div>
                  </Show>
                </div>
              </div>
            </section>

            <Show when={selected().size > 0}>
              <section class="selection-toolbar">
                <div class="btns">
                  <button
                    class="icon-btn refresh-btn"
                    disabled={
                      !canRefreshSelected() || refreshing() || offlineMode()
                    }
                    title={
                      offlineMode()
                        ? 'Offline mode is on'
                        : canRefreshSelected()
                          ? 'Fetch the current value from the service, then rotate (this GET puts k1 on the wire) - one at a time for every selected note'
                          : 'Select notes to rotate'
                    }
                    onClick={refreshSelected}
                  >
                    <Show when={refreshing()} fallback={<IoRefreshSharp />}>
                      <IoRefreshSharp class="spin" />
                    </Show>
                    <span class="btn-label">
                      &nbsp;Rotate
                      <Show when={selectedBearers().length > 1}>
                        &nbsp;({selectedBearers().length})
                      </Show>
                    </span>
                  </button>
                  <button
                    class="icon-btn split-single-btn"
                    disabled={!canSplitSingle() || offlineMode()}
                    title={
                      offlineMode()
                        ? 'Offline mode is on'
                        : canSplitSingle()
                          ? 'Split the selected note into two'
                          : 'Select exactly 1 verified, unspent note to split'
                    }
                    onClick={() => setShowSplitSingleInput(v => !v)}
                  >
                    <IoGitBranchSharp />
                    <span class="btn-label">&nbsp;Split</span>
                  </button>
                  <button
                    class="icon-btn combine-btn"
                    disabled={!canCombine() || combining() || offlineMode()}
                    title={
                      offlineMode()
                        ? 'Offline mode is on'
                        : canCombine()
                          ? 'Combine the selected notes into one. If this mint charges a fee, combining refunds part of what was already withheld when these notes were minted - you get back all but one base fee.'
                          : 'Select 2+ verified, unspent notes from the same mint to combine'
                    }
                    onClick={combineSelected}
                  >
                    <Show when={combining()} fallback={<IoGitMergeSharp />}>
                      <IoRefreshSharp class="spin" />
                    </Show>
                    <span class="btn-label">&nbsp;Combine</span>
                  </button>
                  <button
                    class="icon-btn split-btn"
                    disabled={!canCombine() || splitting() || offlineMode()}
                    title={
                      offlineMode()
                        ? 'Offline mode is on'
                        : canCombine()
                          ? 'Combine the selected notes and split off an amount, leaving the rest as change. If this mint charges a fee, combining refunds part of what was already withheld when these notes were minted - you get back all but one base fee.'
                          : 'Select 2+ verified, unspent notes from the same mint to combine & split'
                    }
                    onClick={() => setShowSplitInput(v => !v)}
                  >
                    <Show when={splitting()} fallback={<IoGitBranchSharp />}>
                      <IoRefreshSharp class="spin" />
                    </Show>
                    <span class="btn-label">&nbsp;Combine &amp; split</span>
                  </button>
                  <button
                    class="icon-btn transfer-btn"
                    disabled={!canTransfer() || offlineMode()}
                    title={
                      offlineMode()
                        ? 'Offline mode is on'
                        : canTransfer()
                          ? 'Transfer the selected note to a different mint'
                          : 'Select exactly 1 note to transfer'
                    }
                    onClick={() => setTransferSource(selectedEligible()[0])}
                  >
                    <IoSwapHorizontalSharp />
                    <span class="btn-label">&nbsp;Transfer</span>
                  </button>
                  <div class="more-menu" ref={el => (moreMenuRef = el)}>
                    <button
                      type="button"
                      class="icon-btn more-btn"
                      title="More actions - label, mark spent, export"
                      onClick={() => setShowMoreMenu(v => !v)}
                    >
                      <IoEllipsisVerticalSharp />
                    </button>
                    <Show when={showMoreMenu()}>
                      <div class="more-menu-panel">
                        <button
                          class="icon-btn label-btn"
                          disabled={!canLabelSelected()}
                          title={
                            canLabelSelected()
                              ? 'Set a label on every selected note (private, for your own reference)'
                              : 'Select notes to label'
                          }
                          onClick={() => {
                            openLabelInput()
                            setShowMoreMenu(false)
                          }}
                        >
                          <IoPencilSharp />
                          &nbsp;Label
                          <Show when={selectedBearers().length > 1}>
                            &nbsp;({selectedBearers().length})
                          </Show>
                        </button>
                        <button
                          class="icon-btn mark-spent-btn"
                          disabled={!canMarkSpentSelected()}
                          title={
                            canMarkSpentSelected()
                              ? 'Mark every selected note as spent - locks them without removing them, e.g. if you already handed them out some other way'
                              : 'Select notes to mark as spent'
                          }
                          onClick={() => {
                            markSpentSelected()
                            setShowMoreMenu(false)
                          }}
                        >
                          <IoBanSharp />
                          &nbsp;Mark spent
                          <Show when={selectedBearers().length > 1}>
                            &nbsp;({selectedBearers().length})
                          </Show>
                        </button>
                        <button
                          class="icon-btn export-btn"
                          disabled={selected().size === 0}
                          title={
                            selected().size === 0
                              ? 'Select notes to export'
                              : 'Download the selected notes as a text file (bech32-encoded, one per line)'
                          }
                          onClick={() => {
                            exportSelected()
                            setShowMoreMenu(false)
                          }}
                        >
                          <IoDownloadSharp />
                          &nbsp;Export
                          <Show when={selected().size > 0}>
                            &nbsp;({selected().size})
                          </Show>
                        </button>
                        <button
                          class="icon-btn qr-export-btn"
                          disabled={selected().size === 0}
                          title={
                            selected().size === 0
                              ? 'Select notes to download as QR codes'
                              : 'Download an SVG QR code for each selected note'
                          }
                          onClick={() => {
                            downloadQrSelected()
                            setShowMoreMenu(false)
                          }}
                        >
                          <IoQrCodeSharp />
                          &nbsp;QR
                          <Show when={selected().size > 0}>
                            &nbsp;({selected().size})
                          </Show>
                        </button>
                      </div>
                    </Show>
                  </div>
                  <Show when={selected().size > 0}>
                    <button
                      type="button"
                      class="icon-btn clear-selection-btn"
                      title="Clear selection"
                      onClick={() => setSelected(new Set<string>())}
                    >
                      <IoCloseCircleSharp />
                      <span class="btn-label">&nbsp;Clear selection</span>
                      &nbsp;({selected().size})
                    </button>
                  </Show>
                </div>
                <Show when={showSplitInput() && canCombine()}>
                  <Dialog
                    onClose={() => {
                      setShowSplitInput(false)
                      setSplitSats('')
                    }}
                  >
                    <h4>Combine &amp; split</h4>
                    <label>
                      Split off (sats, of{' '}
                      {msatToSats(
                        selectedEligible().reduce((s, b) => s + b.amount, 0)
                      )}
                      )
                    </label>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      placeholder="amount in sats"
                      value={splitSats()}
                      onInput={e => setSplitSats(e.currentTarget.value)}
                    />
                    <p class="bearer-hint">
                      Burns the {selectedEligible().length} selected notes and
                      mints two: this amount, and a change note for the rest. If
                      this mint charges a fee, it's deducted from the change,
                      not the amount split off.
                    </p>
                    <div class="btns">
                      <button
                        disabled={splitting() || offlineMode()}
                        onClick={combineAndSplit}
                      >
                        <Show when={splitting()}>
                          <IoRefreshSharp class="spin" />
                          &nbsp;
                        </Show>
                        Split
                      </button>
                      <button
                        onClick={() => {
                          setShowSplitInput(false)
                          setSplitSats('')
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </Dialog>
                </Show>
                <Show when={showLabelInput() && canLabelSelected()}>
                  <Dialog
                    onClose={() => {
                      setShowLabelInput(false)
                      setLabelInputValue('')
                    }}
                  >
                    <h4>Label</h4>
                    <label>
                      Label {selectedBearers().length} note
                      {selectedBearers().length === 1 ? '' : 's'} (private, for
                      your own reference)
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. rent, gift for Alex"
                      value={labelInputValue()}
                      onInput={e => setLabelInputValue(e.currentTarget.value)}
                      onKeyDown={e => e.key === 'Enter' && saveLabelSelected()}
                    />
                    <div class="btns">
                      <button onClick={saveLabelSelected}>Save</button>
                      <button
                        onClick={() => {
                          setShowLabelInput(false)
                          setLabelInputValue('')
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </Dialog>
                </Show>
                <Show when={showSplitSingleInput() && canSplitSingle()}>
                  <Dialog
                    onClose={() => {
                      setShowSplitSingleInput(false)
                      setSplitSingleSats('')
                      setSplitSingleTimes('1')
                    }}
                  >
                    <h4>Split</h4>
                    <label>
                      Split off (sats, of{' '}
                      {msatToSats(selectedBearers()[0].amount)})
                    </label>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      placeholder="amount in sats"
                      value={splitSingleSats()}
                      onInput={e => setSplitSingleSats(e.currentTarget.value)}
                    />
                    <label>How many times</label>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      placeholder="1"
                      value={splitSingleTimes()}
                      onInput={e => setSplitSingleTimes(e.currentTarget.value)}
                    />
                    <p class="bearer-hint">
                      If this mint charges a fee, it's deducted from the
                      remainder, not the amount split off - splitting fails if
                      too little would be left over to cover it.
                    </p>
                    <Show when={Number(splitSingleTimes()) > 1}>
                      <p class="bearer-hint">
                        Chains {Number(splitSingleTimes())} split requests one
                        after another - if one fails partway through, whichever
                        notes already came back are kept, and you'd need to try
                        again for the rest.
                      </p>
                    </Show>
                    <div class="btns">
                      <button
                        disabled={splittingSingle() || offlineMode()}
                        onClick={splitSingleSelected}
                      >
                        <Show when={splittingSingle()}>
                          <IoRefreshSharp class="spin" />
                          &nbsp;
                        </Show>
                        Split
                      </button>
                      <button
                        onClick={() => {
                          setShowSplitSingleInput(false)
                          setSplitSingleSats('')
                          setSplitSingleTimes('1')
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </Dialog>
                </Show>
              </section>
            </Show>

            <Show
              when={groupByMint()}
              fallback={
                <div class="bearer-list">
                  <For each={sortedBearers()}>
                    {bearer => (
                      <BearerCard
                        bearer={bearer}
                        selected={selected().has(bearer.id)}
                        onSelect={isSelected =>
                          toggleSelect(bearer.id, isSelected)
                        }
                        onRefresh={refreshOneBearer}
                      />
                    )}
                  </For>
                </div>
              }
            >
              <For each={groupedBearers()}>
                {([server, group]) => (
                  <section class="mint-group-section">
                    <h4 class="mint-group-heading">{server}</h4>
                    <div class="bearer-list">
                      <For each={group}>
                        {bearer => (
                          <BearerCard
                            bearer={bearer}
                            selected={selected().has(bearer.id)}
                            onSelect={isSelected =>
                              toggleSelect(bearer.id, isSelected)
                            }
                            onRefresh={refreshOneBearer}
                          />
                        )}
                      </For>
                    </div>
                  </section>
                )}
              </For>
            </Show>
          </div>
        </Show>
      </Show>
      <Show when={transferSource()}>
        {bearer => (
          <TransferDialog
            sourceBearer={bearer()}
            onClose={() => {
              setTransferSource(null)
              setSelected(new Set<string>())
            }}
          />
        )}
      </Show>
    </Show>
  )
}
export default Wallet
