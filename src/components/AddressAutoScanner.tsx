import type {Component} from 'solid-js'
import {onCleanup, onMount} from 'solid-js'

import {useWallet} from '../WalletContext'
import {offlineMode} from '../offlineMode'
import {hasCashRoot} from '../cashSecrets'
import {registeredAddresses} from '../addressRegistry'
import {runAddressScan} from '../addressRecovery'
import {sendNotification} from '../notifications'
import {msatToSats} from '../helpers'
import {serverOf} from '../lnurlcash'

// foreground-only per-address "check notes" scheduler (TODO.md's
// background-scan item) - mounted once at the app root (see index.tsx),
// ticks while the wallet/tab is open and fires an incremental
// runAddressScan for any registered address whose own autoScanMinutes
// interval (addressRegistry.ts, set from Mint.tsx's trusted-mint card)
// has elapsed. This is NOT true background execution: closing the tab (or
// backgrounding the OS app on mobile) stops it, same as any other
// setInterval. A real "still runs with the app closed" version would need
// the PWA's service worker registering Periodic Background Sync and
// polling from there instead - deliberately not built yet, because a
// service worker can't read this wallet's localStorage or hold any
// seed-derived key material, so it could only ever do a public,
// watch-only "does anything NEW exist" check (mirroring each address's
// public cx1 into IndexedDB first) and notify, never actually claim a
// note the way this in-page version does - a meaningfully different and
// separately-scoped piece of work.
const TICK_MS = 30_000

const AddressAutoScanner: Component = () => {
  const {state, bearers, addBearer, logActivity} = useWallet()
  const inFlight = new Set<string>()

  const tick = async () => {
    if (state() !== 'unlocked' || offlineMode() || !hasCashRoot()) return
    const now = Date.now()
    for (const addr of registeredAddresses()) {
      if (!addr.autoScanMinutes) continue
      const key = `${addr.server}|${addr.username}`
      if (inFlight.has(key)) continue
      const dueAt = (addr.lastAutoScanAt ?? 0) + addr.autoScanMinutes * 60_000
      if (now < dueAt) continue
      inFlight.add(key)
      try {
        const result = await runAddressScan(
          addr.server,
          addr.username,
          bearers(),
          {addBearer, logActivity},
          {startIndex: addr.nextScanIndex ?? 0}
        )
        for (const note of result.recovered) {
          sendNotification('New funds received', {
            body: `${msatToSats(note.amount)} sats at ${addr.username}@${serverOf(addr.server)}.`,
            tag: `address-scan-${key}`
          })
        }
      } finally {
        inFlight.delete(key)
      }
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined
  onMount(() => {
    timer = setInterval(() => void tick(), TICK_MS)
  })
  onCleanup(() => {
    if (timer !== undefined) clearInterval(timer)
  })

  return null
}
export default AddressAutoScanner
