import {pendingOutputSecrets, clearPendingOutputSecret} from './cashSecrets'
import {
  fetchNoteInfo,
  noteK1,
  serverOf,
  withNewK1,
  NoteSpentError,
  NoteUnknownError
} from './lnurlcash'
import {msatToSats} from './helpers'
import type {Bearer, ActivityKind} from './storage'
import type {NewBearer} from './WalletContext'

// Settles cashSecrets.ts's pending output journal: every plain bearer
// secret a rotate/split/merge generated (lnurlcash.ts's generateNoteSecret)
// that never made it into a stored bearer. Each is looked up at its mint by
// its public Q only (fetchNoteInfo never sends k1), then:
//   live                -> adopted as a bearer (the request landed after
//                          the wallet stopped waiting for it)
//   spent               -> dropped (its value already moved on)
//   unknown to the mint -> kept until PENDING_OUTPUT_MAX_AGE_MS, in case a
//                          stalled request has yet to land
//   probe failed        -> kept, no information either way
// Entries younger than PENDING_OUTPUT_MIN_AGE_MS are skipped - their
// request may still be in flight in the flow that generated them.

export const PENDING_OUTPUT_MIN_AGE_MS = 2 * 60_000
export const PENDING_OUTPUT_MAX_AGE_MS = 30 * 24 * 60 * 60_000

export type ReconcileDeps = {
  bearers: () => Bearer[]
  addBearer: (note: NewBearer) => Promise<Bearer>
  logActivity: (kind: ActivityKind, message: string) => void
  now?: () => number
  fetchInfo?: typeof fetchNoteInfo
}

export type ReconcileResult = {recovered: number; recoveredMsat: number}

const heldSecret = (bearers: Bearer[], secret: string): boolean =>
  bearers.some(b => noteK1(b.url) === secret)

// any stored note on the same SERVICE supplies the url shape (host, path)
// to look the output up with - spent and device-backed ones included
const templateFor = (bearers: Bearer[], domain: string): Bearer | undefined =>
  bearers.find(
    b =>
      serverOf(b.url) === domain ||
      (b.callback !== '' && serverOf(b.callback) === domain)
  )

const reconcile = async (deps: ReconcileDeps): Promise<ReconcileResult> => {
  const now = (deps.now ?? Date.now)()
  const fetchInfo = deps.fetchInfo ?? fetchNoteInfo
  const result: ReconcileResult = {recovered: 0, recoveredMsat: 0}
  for (const [domain, entries] of Object.entries(pendingOutputSecrets())) {
    for (const {secret, createdAt} of entries) {
      const age = now - createdAt
      if (age < PENDING_OUTPUT_MIN_AGE_MS) continue
      if (heldSecret(deps.bearers(), secret)) {
        clearPendingOutputSecret(secret)
        continue
      }
      const template = templateFor(deps.bearers(), domain)
      if (!template) continue
      let info
      try {
        info = await fetchInfo(withNewK1(template.url, secret, template.amount))
      } catch (err) {
        if (err instanceof NoteSpentError) {
          clearPendingOutputSecret(secret)
        } else if (
          err instanceof NoteUnknownError &&
          age > PENDING_OUTPUT_MAX_AGE_MS
        ) {
          clearPendingOutputSecret(secret)
        }
        continue
      }
      // re-checked after the await: another flow may have stored it since
      if (heldSecret(deps.bearers(), secret)) {
        clearPendingOutputSecret(secret)
        continue
      }
      // addBearer clears the journal entry once the record is persisted
      await deps.addBearer({
        url: withNewK1(template.url, secret, info.maxWithdrawable),
        callback: info.callback,
        amount: info.maxWithdrawable,
        verified: true,
        mintPubkey: info.mintPubkey ?? template.mintPubkey
      })
      deps.logActivity(
        'recovered',
        `Recovered ${msatToSats(info.maxWithdrawable)} sats at ${domain} from an earlier operation whose outcome was uncertain.`
      )
      result.recovered++
      result.recoveredMsat += info.maxWithdrawable
    }
  }
  return result
}

// one run at a time - a mount-time run and a Rotate all click overlapping
// would otherwise both see the same live output and store it twice
let inFlight: Promise<ReconcileResult> | null = null

export const reconcilePendingOutputs = (
  deps: ReconcileDeps
): Promise<ReconcileResult> => {
  if (!inFlight) {
    inFlight = reconcile(deps).finally(() => {
      inFlight = null
    })
  }
  return inFlight
}
