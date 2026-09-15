import type {DeviceClient} from './device'
import {DeviceError} from './device'
import {withStorageLock} from './storageLock'

// Persisted record of device-side bookkeeping still owed after a mint call
// already succeeded - see deviceOrchestration.ts's commitToDevice. Plain
// localStorage, deliberately NOT the encrypted bearer store: entries only
// ever reference device note ids and public amounts, never a raw secret.
//
// Exists to close a real gap: rotate/split/merge/mint on a device-backed
// note is a two-phase commit (mint call, then device confirm + mark_spent).
// If the device drops between those two phases, the mint has already
// committed but the device hasn't recorded it - without this queue, that
// desync has no way back short of manually reconciling PENDING notes by
// hand.
export type PendingDeviceOp = {
  id: string
  outputs: {
    deviceId: string
    amountMsat: number
    host: string
    signature?: string
  }[]
  burnDeviceIds: string[]
  createdAt: number
}

const STORAGE_KEY = 'lnurlcash_device_pending_ops'

const newOpId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

// this module is pulled in by deviceOrchestration.ts, which is
// unit-tested directly under plain Node (deviceOrchestration.test.ts) - no
// localStorage global there. Falls back to an in-memory copy so the queue
// still behaves correctly within one process either way - it just won't
// survive a reload without a real localStorage (which every real browser
// this ships to has).
let memoryFallback: PendingDeviceOp[] = []
let mediatedQueue: {
  entries: PendingDeviceOp[]
  save(entries: PendingDeviceOp[]): Promise<void>
} | null = null
let mediatedWrite: Promise<unknown> = Promise.resolve()

const withQueueLock = <T>(action: () => Promise<T>): Promise<T> => {
  if (!mediatedQueue) return withStorageLock(STORAGE_KEY, action)
  // An opaque-origin napplet cannot acquire a browser Web Lock. The shell
  // hosts one wallet instance; serialize this instance's encrypted writes.
  const next = mediatedWrite.catch(() => {}).then(action)
  mediatedWrite = next
  return next
}

/** Bind an encrypted shell queue for one authenticated device; web storage remains the default. */
export const useMediatedDeviceQueue = (queue: typeof mediatedQueue): void => {
  mediatedQueue = queue
}

const readStored = (): PendingDeviceOp[] => {
  if (mediatedQueue) return mediatedQueue.entries
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    const stored: PendingDeviceOp[] = Array.isArray(parsed) ? parsed : []
    if (memoryFallback.length > 0) {
      // ops that landed in memory because a write hit quota/permission get
      // folded back in (deduped by id) - otherwise they'd silently vanish
      // from every drain once localStorage reads succeed again
      const known = new Set(stored.map(o => o.id))
      stored.push(...memoryFallback.filter(o => !known.has(o.id)))
      memoryFallback = []
      writeStored(stored)
    }
    return stored
  } catch {
    return memoryFallback
  }
}

const writeStored = (ops: PendingDeviceOp[]): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ops))
  } catch {
    memoryFallback = ops
  }
}

export const readPendingDeviceOps = (): PendingDeviceOp[] => readStored()

// wipes the queue - part of forgetting a wallet (WalletContext's
// forgetWallet): pending device bookkeeping for a wallet that no longer
// exists must not survive it
export const clearPendingDeviceOps = (): void => {
  memoryFallback = []
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // no localStorage (plain-Node tests) - the memory wipe above is it
  }
}

// written the instant a mint call succeeds, before confirm/mark_spent are
// even attempted - see deviceOrchestration.ts's commitToDevice. Returns the
// stored record (id/createdAt filled in) so the caller can try draining it
// immediately, same record left behind if that attempt doesn't finish. The
// cross-tab lock keeps two tabs' enqueue/dequeue from losing each other's
// ops (a lost confirm+burn op strands a device note as PENDING)
export const enqueuePendingDeviceOp = async (
  op: Omit<PendingDeviceOp, 'id' | 'createdAt'>
): Promise<PendingDeviceOp> => {
  const entry: PendingDeviceOp = {...op, id: newOpId(), createdAt: Date.now()}
  await withQueueLock(async () => {
    const next = [...readStored(), entry]
    if (mediatedQueue) {
      await mediatedQueue.save(next)
      mediatedQueue.entries = next
    } else writeStored(next)
  })
  return entry
}

export const dequeuePendingDeviceOp = async (id: string): Promise<void> => {
  await withQueueLock(async () => {
    const next = readStored().filter(op => op.id !== id)
    if (mediatedQueue) {
      await mediatedQueue.save(next)
      mediatedQueue.entries = next
    } else writeStored(next)
  })
}

// 'invalid_state' from confirm/mark_spent means the device already did
// this (a PENDING note can't be confirmed twice, a SPENT one can't be
// marked spent twice) - treated as success, not failure, since that's
// exactly the idempotent recovery this queue exists for
const isAlreadyDone = (err: unknown): boolean =>
  err instanceof DeviceError && err.code === 'invalid_state'

// drains every queued op against `client`: confirms every output, then
// marks every burn id spent, tolerating 'invalid_state' on either step as
// "already done". An op that still fails partway through (device
// disconnects again mid-drain) is left queued for next time - never
// thrown, since this runs best-effort on every reconnect.
export const drainPendingDeviceOps = async (
  client: DeviceClient
): Promise<void> => {
  for (const op of readStored()) {
    try {
      for (const output of op.outputs) {
        try {
          await client.confirm(
            output.deviceId,
            output.amountMsat,
            output.host,
            output.signature
          )
        } catch (err) {
          if (!isAlreadyDone(err)) throw err
        }
      }
      for (const deviceId of op.burnDeviceIds) {
        try {
          await client.markSpent(deviceId)
        } catch (err) {
          if (!isAlreadyDone(err)) throw err
        }
      }
      await dequeuePendingDeviceOp(op.id)
    } catch {
      // still incomplete - leave it queued, the next drain retries it
    }
  }
}
