import {schnorr} from '@noble/curves/secp256k1.js'
import {
  shareSecretAtIndex,
  legacyAddressSecretAtIndex,
  addressShareCx1,
  hasCashRoot
} from './cashSecrets'
import {
  resolveMintInput,
  fetchPayRequest,
  fromLud17,
  serverOf,
  noteK1,
  withNewK1,
  scanForAddressNotes,
  encodeCk1,
  signNoteOwnership,
  k1SpendsNote,
  ServiceError
} from './lnurlcash'
import {gapLimit} from './gapLimit'
import {msatToSats} from './helpers'
import {
  markAddressScanned,
  registeredAddresses,
  forgottenAddresses,
  addressKeyOf,
  type AddressKey
} from './addressRegistry'
import type {Bearer, ActivityKind} from './storage'
import type {IndexStatus} from './recovery'
import type {NewBearer} from './WalletContext'

// LUD-26 counterpart to recovery.ts's scanMintForNotes - same shape, same
// dedup convention (existing bearers checked by serverOf+noteK1, see
// receive.ts), but scans a REGISTERED address's share S/0'/2/n'/i (or, for
// a registration from before LUD-26, its old branch under purpose 2 - see
// AddressKey) via the public-commitment lookup (src/lib/addresses.ts's
// scanForAddressNotes). Every note this finds signs its own ck1 on the spot
// (signNoteOwnership) - the scan itself never redeems anything, it only
// proves this wallet CAN.

export type AddressScanOutcome = {
  server: string
  username: string
  recovered: NewBearer[]
  // highest index this scan actually found a note at - null when nothing
  // was found this pass (still may be non-null from an EARLIER pass - see
  // nextScanIndex, which tracks that across calls even when this one finds
  // nothing new)
  highestIndex: number | null
  // the index this pass started its forward walk from - what checkBehind's
  // window sits just below. Purely informational (a caller display value),
  // never fed back into a later call the way nextScanIndex is.
  checkedFrom: number
  // resume floor for the NEXT incremental "check notes" pass, as opposed
  // to a full "rescan all" (startIndex: 0) - the higher of whatever floor
  // the caller already passed in (never regresses below what's already
  // been checked) and this scan's own highest found index + 1. Always
  // present, even on an error before any of that was learned, so a caller
  // can feed it straight back into addressRegistry.ts's markAddressScanned
  // unconditionally
  nextScanIndex: number
  error?: string
}

export type AddressScanOptions = {
  // which key the notes were credited to - the share on file, a share the
  // address was moved off, or a pre-LUD-26 branch. runAddressScan fills it
  // in from the registry
  key?: AddressKey
  startIndex?: number
  // startIndex was picked by hand (AddressScanDialog's start index field):
  // don't treat it as an already-checked floor - nothing below it was
  // necessarily ever checked, so nextScanIndex only advances past what
  // this pass actually finds (same as a full rescan from 0)
  exactStart?: boolean
  // every index probed, hit or not - see scanForAddressNotes' onProgress
  onProgress?: (index: number) => void
  // every index's final verdict - see recovery.ts's IndexStatus
  onIndex?: (index: number, status: IndexStatus) => void
}

// a found note's initial label: the address it was paid to as a tag (so
// the Wallet page's tag filter groups every note from one address) plus
// the branch index it was scanned at - see noteTags.ts for the syntax
export const addressNoteLabel = (
  username: string,
  host: string,
  index: number
): string => `[${username}@${host}] index ${index}`

// the note key at `index` under `key`, or null with no cash root loaded
const addressSecretAt = (
  host: string,
  key: AddressKey,
  index: number
): Uint8Array | null =>
  key.kind === 'share'
    ? shareSecretAtIndex(host, key.share, index)
    : legacyAddressSecretAtIndex(host, index, key.slot)

export const scanRegisteredAddress = async (
  server: string,
  username: string,
  existing: Bearer[] = [],
  opts: AddressScanOptions = {}
): Promise<AddressScanOutcome> => {
  const startIndex = opts.startIndex ?? 0
  const failed = (error: string): AddressScanOutcome => ({
    server,
    username,
    recovered: [],
    highestIndex: null,
    checkedFrom: startIndex,
    nextScanIndex: opts.exactStart ? 0 : startIndex,
    error
  })
  // `host` keeps the port: a pre-LUD-26 branch hashed the host as stored,
  // port included, while a share's S drops it anyway (cashSecrets.ts)
  let host: string
  try {
    host = new URL(server).host
  } catch {
    return failed('Not a valid mint address.')
  }
  const key = opts.key ?? {kind: 'share', share: 0}
  if (!hasCashRoot()) {
    return failed(
      'No seed-derived key is loaded for this wallet - restore or re-enter your seed first.'
    )
  }

  const payUrl = resolveMintInput(`${username}@${host}`)
  if (!payUrl) return failed('Not a recognizable mint address.')

  let withdrawUrl: string
  try {
    const info = await fetchPayRequest(payUrl)
    if (!info.withdrawLink) {
      return failed('This mint does not advertise LNURLcash minting.')
    }
    withdrawUrl = fromLud17(info.withdrawLink)
  } catch (err) {
    return failed((err as Error).message)
  }

  const recovered: NewBearer[] = []
  let highestIndex: number | null = null
  const nextScanIndex = (): number =>
    Math.max(opts.exactStart ? 0 : startIndex, (highestIndex ?? -1) + 1)
  try {
    await scanForAddressNotes(
      withdrawUrl,
      index => {
        const secretKey = addressSecretAt(host, key, index)
        if (!secretKey) throw new Error('The wallet locked during the scan.')
        return schnorr.getPublicKey(secretKey)
      },
      {
        gapLimit: gapLimit(),
        startIndex,
        // re-verifies gapLimit indices below startIndex too, every pass -
        // the safety net that catches a stale floor - see
        // scanForAddressNotes' own doc comment
        checkBehind: true,
        onProgress: opts.onProgress,
        onOutcome: (index, outcome) => {
          // 'found' is reported from onFound below instead, once it's known
          // whether this wallet already held it
          if (outcome !== 'found') opts.onIndex?.(index, outcome)
        },
        // an index answered "already in use" (a burned note) is used too
        onSpent: index => {
          highestIndex = Math.max(highestIndex ?? -1, index)
        },
        // built directly in onFound (not batched after the scan returns), same
        // as recovery.ts's scanChain, so a later index's transport failure
        // can't discard a note already found this same pass
        onFound: result => {
          highestIndex = Math.max(highestIndex ?? -1, result.index)
          const secretKey = addressSecretAt(host, key, result.index)
          if (!secretKey) return
          const {pubkeyXOnly: ownershipPubkey, signature: ownershipSignature} =
            signNoteOwnership(secretKey, withdrawUrl)
          const ck1 = encodeCk1(ownershipPubkey, ownershipSignature)
          // attach an already-disclosed offline-verification sig immediately
          // (see WithdrawRequestInfo's own comment) rather than requiring a
          // separate rotate/refresh afterward just to obtain one
          const url = withNewK1(
            withdrawUrl,
            ck1,
            result.info.maxWithdrawable,
            result.info.c
          )
          const alreadyHeld = existing.some(
            b =>
              serverOf(b.url) === serverOf(url) &&
              k1SpendsNote(noteK1(b.url), ownershipPubkey)
          )
          if (!alreadyHeld) {
            recovered.push({
              url,
              callback: result.info.callback,
              amount: result.info.maxWithdrawable,
              verified: true,
              mintPubkey: result.info.mintPubkey,
              label: addressNoteLabel(username, host, result.index)
            })
          }
          opts.onIndex?.(result.index, alreadyHeld ? 'held' : 'recovered')
        }
      }
    )
  } catch (err) {
    return {
      server,
      username,
      recovered,
      highestIndex,
      checkedFrom: startIndex,
      nextScanIndex: nextScanIndex(),
      error: (err as Error).message
    }
  }
  return {
    server,
    username,
    recovered,
    checkedFrom: startIndex,
    highestIndex,
    nextScanIndex: nextScanIndex()
  }
}

export type AddressScanWalletOps = {
  addBearer: (note: NewBearer) => Promise<unknown>
  logActivity: (kind: ActivityKind, message: string, label?: string) => void
}

// runs scanRegisteredAddress and actually claims anything it finds into
// the wallet (addBearer + activity log) - the one piece every caller
// (AddressScanDialog's "check notes"/"full rescan", AddressAutoScanner's
// periodic tick) needs identically. Always
// records how far this pass got (markAddressScanned) so the NEXT
// incremental "check notes" pass resumes past it, regardless of whether
// this one found anything. What each caller does with the returned
// outcome (toast, silence-unless-found, a Notification, ...) stays
// caller-specific.
export const runAddressScan = async (
  server: string,
  username: string,
  existing: Bearer[],
  wallet: AddressScanWalletOps,
  opts: AddressScanOptions = {}
): Promise<AddressScanOutcome> => {
  const record = registeredAddresses().find(
    a => a.server === server && a.username === username
  )
  const claim = async (result: AddressScanOutcome) => {
    for (const note of result.recovered) {
      await wallet.addBearer(note)
      wallet.logActivity(
        'recovered',
        `Received ${msatToSats(note.amount)} sats at ${username}@${serverOf(server)}.`
      )
    }
  }
  const result = await scanRegisteredAddress(server, username, existing, {
    ...opts,
    key: opts.key ?? (record ? addressKeyOf(record) : undefined)
  })
  await claim(result)
  markAddressScanned(server, username, result.nextScanIndex)
  // a full rescan also sweeps every key the address was moved off: LUD-26
  // leaves notes credited there where they are
  if (!opts.key && (opts.startIndex ?? 0) === 0 && record?.retired) {
    for (const key of record.retired) {
      const swept = await scanRegisteredAddress(server, username, existing, {
        key,
        onProgress: opts.onProgress
      })
      await claim(swept)
      result.recovered.push(...swept.recovered)
      result.error ??= swept.error
    }
  }
  return result
}

// Whether `username`@`server` is still registered to THIS wallet - the
// question an "Invalid ownership signature." refusal (unclaim) or a
// reclaim leaves open. A LUD-26 SERVICE never publishes the cx1 it has on
// file, so this only goes as far as this device's own records:
// - 'ours': the SERVICE still knows the name, and this device recorded
//   which key registered it (registered or forgotten here)
// - 'unregistered': the SERVICE doesn't know the name at all any more
// - 'unknown': couldn't tell (offline, no seed, no record here)
// 'not-ours' is never concluded any more; it stays for callers' messages.
export type AddressOwnership = 'ours' | 'not-ours' | 'unregistered' | 'unknown'

// checkAddressOwnership, plus which key the registration was recorded with
// - what a reclaim needs to re-add the address
export const resolveAddressOwnership = async (
  server: string,
  username: string
): Promise<{ownership: AddressOwnership; key?: AddressKey}> => {
  let host: string
  try {
    host = new URL(server).host
  } catch {
    return {ownership: 'unknown'}
  }
  const payUrl = resolveMintInput(`${username}@${host}`)
  if (!payUrl || !addressShareCx1(host, 0)) return {ownership: 'unknown'}
  try {
    await fetchPayRequest(payUrl)
  } catch (err) {
    if (err instanceof ServiceError && /unknown user/i.test(err.reason)) {
      return {ownership: 'unregistered'}
    }
    return {ownership: 'unknown'}
  }
  const name = username.trim().toLowerCase()
  const record = [...registeredAddresses(), ...forgottenAddresses()].find(
    a => a.server === server && a.username === name
  )
  return record
    ? {ownership: 'ours', key: addressKeyOf(record)}
    : {ownership: 'unknown'}
}

export const checkAddressOwnership = async (
  server: string,
  username: string
): Promise<AddressOwnership> =>
  (await resolveAddressOwnership(server, username)).ownership
