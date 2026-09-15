// LUD-25 Part 2's "Internal transfer" (25.md): if a payee has registered a
// cx1 (Seed & derivation) at a mint, SERVICE MAY publish it in their
// payRequest metadata as a `text/xpub` entry, `cx1<...>:<i>` (their own
// best-known next-unused index for that branch). A WALLET that already
// holds a note at that SAME SERVICE can then skip Lightning entirely:
// derive the payee's next pubkey pk_i from their cx1, and rotate, split or
// merge (Redeeming a bearer note) naming it as p1 directly, instead of
// generating a fresh secret for itself the way an ordinary mutation does.
// `i` is only ever a hint - SERVICE rejects it if some other request beat
// this one to it, and WALLET just retries at the next index.
import {serverOf} from './urls'
import {
  AmbiguousMintError,
  AmbiguousMutationError,
  ServiceError
} from './errors'
import {
  deriveNotePubkey,
  decodeCx1,
  encodeCp1,
  isCk1,
  type Cx1
} from './recoverableNotes'
import {
  mergeNotesWithHash,
  splitNoteWithHash,
  generateOutputSecret,
  disclosedValue
} from './request'

export type InternalTransferHint = {cx1: Cx1; startIndex: number}

// pulls a payee's cx1 export + hinted next index out of a payRequest's
// metadata (per this section's own `["text/xpub", "cx1<...>:<i>"]` entry),
// mirroring fees.ts's parseMintFee - JSON.parse, scan for the matching
// entry type, never throw. `i` isn't validated against anything here (a
// stale or adversarial hint is harmless - see payInternalTransfer's own
// retry-on-conflict), only checked for being a well-formed non-negative
// integer.
export const parseInternalTransferHint = (
  metadata: string
): InternalTransferHint | null => {
  let entries: unknown
  try {
    entries = JSON.parse(metadata)
  } catch {
    return null
  }
  if (!Array.isArray(entries)) return null
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry[0] !== 'text/xpub') continue
    if (typeof entry[1] !== 'string') continue
    const sep = entry[1].lastIndexOf(':')
    if (sep < 0) continue
    const cx1 = decodeCx1(entry[1].slice(0, sep))
    const startIndex = Number(entry[1].slice(sep + 1))
    if (!cx1 || !Number.isInteger(startIndex) || startIndex < 0) continue
    return {cx1, startIndex}
  }
  return null
}

const isIndexInUse = (err: unknown): boolean =>
  err instanceof ServiceError && /already in use/i.test(err.reason)

// bounded the same defensive way addresses.ts's scanForAddressNotes bounds
// its own index walk - a stale hint, or a mint that keeps reporting every
// index tried as taken, must not spin this forever
const MAX_INDEX_ATTEMPTS = 25

export type InternalTransferResult =
  | {kind: 'merge'; index: number; signature: string}
  | {
      kind: 'split'
      index: number
      signature: string
      change: string
      changeSignature: string
    }

// burns k1s (one note, or several - same "one or many" input shape every
// mutation in this kit already takes) and credits pk_i, on the recipient's
// own branch, with `amountMsat`. When `amountMsat` equals the inputs'
// combined value this is a plain merge naming pk_i as the WHOLE output
// (a single input makes it an ordinary free rotate - SERVICE sees no
// difference, see rotateNoteWithHash/mergeNotesWithHash's own shared wire
// shape); otherwise it's a split, naming pk_i as the first output and a
// fresh wallet-held secret as change. Normal split/merge fees apply either
// way (Mint fee's for split and combine) - only a genuine single-input,
// full-value rotate is free.
export const payInternalTransfer = async (
  callback: string,
  k1s: string[],
  amountMsat: number,
  totalInputMsat: number,
  hint: InternalTransferHint
): Promise<InternalTransferResult> => {
  if (amountMsat > totalInputMsat) {
    throw new Error('Cannot pay more than the selected notes are worth.')
  }
  const domain = serverOf(callback)
  const preferPubkey = k1s.every(isCk1)
  let index = hint.startIndex
  for (let attempt = 0; attempt < MAX_INDEX_ATTEMPTS; attempt++) {
    const recipientOutput = encodeCp1(
      deriveNotePubkey(hint.cx1.pubkeyXOnly, hint.cx1.chainCode, index)
    )
    if (amountMsat === totalInputMsat) {
      try {
        const {signature} = await mergeNotesWithHash(
          callback,
          k1s,
          recipientOutput
        )
        return {kind: 'merge', index, signature}
      } catch (err) {
        if (isIndexInUse(err)) {
          index++
          continue
        }
        throw err
      }
    }
    // the change output IS this wallet's own money - generated fresh per
    // attempt so a retried index never reuses a secret already disclosed
    // (as a hash/pubkey commitment) to a request that may yet still land
    const changeK1 = generateOutputSecret(domain, preferPubkey)
    try {
      const result = await splitNoteWithHash(
        callback,
        k1s,
        amountMsat,
        recipientOutput,
        disclosedValue(changeK1)
      )
      return {
        kind: 'split',
        index,
        signature: result.signature,
        change: changeK1,
        changeSignature: result.changeSignature
      }
    } catch (err) {
      if (isIndexInUse(err)) {
        index++
        continue
      }
      // the request may have landed despite the failure - unlike splitNote's
      // own equivalent catch, the recipient's output is never this wallet's
      // to lose, only the change secret is, so only that rides the error
      if (err instanceof AmbiguousMintError) {
        throw new AmbiguousMutationError((err as Error).message, [changeK1])
      }
      throw err
    }
  }
  throw new Error(
    `${domain} kept reporting every index tried as already in use - could not complete the internal transfer.`
  )
}
