import type {DeviceClient} from './device'
import type {Bearer} from './storage'
import type {NewBearer, WalletContextType} from './WalletContext'
import {
  requireNoteK1,
  withNewK1,
  splitNote,
  settleNote,
  rotateNote,
  probeBurnedNote,
  NoteSpentError,
  AmbiguousMutationError,
  serverOf
} from './lnurlcash'
import {deviceSplit, deviceSettle} from './deviceOrchestration'
import {msatToSats, notify, NotifyKind} from './helpers'

export type SplitTarget = {amountMsat: number; label?: string}

export type SplitOutcome = {
  // one per target, in the same order, each already carrying its own
  // label (if requested) - the caller never needs to re-fetch to know
  // what got created
  parts: Bearer[]
  // the still-unspent remainder's current bearer id, or null if it ended
  // up fully consumed (not currently possible - every target amount is
  // required to leave something behind, see the sum check below - but
  // kept nullable rather than asserted, in case that ever changes)
  remainderId: string | null
  // summed across every split (a mint MAY charge a flat per-split fee,
  // deducted from the change - LUD-25), plus the last split's own fee
  // alone - kept separate rather than averaged since a flat fee is the
  // same on every split, so "per split" should read as that one number,
  // not total/count
  totalFeeMsat: number
  lastFeeMsat: number
}

export type SplitContext = {
  addBearer: WalletContextType['addBearer']
  updateBearer: WalletContextType['updateBearer']
  removeBearer: WalletContextType['removeBearer']
  logActivity: WalletContextType['logActivity']
  deviceClient: () => DeviceClient | null
  requireDeviceClient: (client: DeviceClient | null) => DeviceClient
}

// Splits `bearer` into one new note per entry in `targets`, in order,
// tracking the still-unspent remainder as a real, persisted Bearer
// throughout - never removed until a split for it has actually succeeded.
// Generalized out of Wallet.tsx's own multi-split UI (originally: `times`
// copies of one constant amount) so any caller - the wallet page's own
// split button, or an addon's note.split verb - gets the exact same
// fee-accounting and error-recovery guarantees, not a second
// reimplementation of them.
//
// A mint MAY charge a flat per-split fee (LUD-25), deducted from the
// change rather than the split-off amount, so the remainder is read back
// authoritatively (an informational GET via settleNote/deviceSettle) after
// each split instead of just subtracting the target amount.
//
// A rejected split still puts the remainder's k1 on the wire via the
// failed callback request, so on failure it's rotated in place
// (best-effort) rather than left exposed - but always kept, never
// dropped, so a failed split costs nothing.
export const splitBearerIntoAmounts = async (
  bearer: Bearer,
  targets: SplitTarget[],
  ctx: SplitContext
): Promise<SplitOutcome> => {
  const totalMsat = targets.reduce((sum, t) => sum + t.amountMsat, 0)
  if (totalMsat >= bearer.amount) {
    throw new Error('Total split amount must be below the note value.')
  }

  const {addBearer, updateBearer, removeBearer, logActivity} = ctx
  const parts: Bearer[] = []
  let totalFeeMsat = 0
  let lastFeeMsat = 0

  let remainderId = bearer.id
  let currentK1 = bearer.deviceId ? '' : requireNoteK1(bearer.url)
  let currentUrl = bearer.url
  let currentCallback = bearer.callback
  let currentAmount = bearer.amount
  let currentDeviceId = bearer.deviceId

  const client = ctx.deviceClient()
  if (bearer.deviceId) ctx.requireDeviceClient(client)

  for (const target of targets) {
    const msat = target.amountMsat
    const expectedChange = currentAmount - msat

    if (client) {
      // if a vault is connected, both outputs land on it - regardless of
      // whether the input being split was itself device-backed (see
      // deviceOrchestration.ts's "migration" note). No local
      // rotate-in-place fallback on failure here (unlike the browser-only
      // branch below): a failed device split never burns its input (that
      // only happens once the mint call succeeds), so the existing
      // remainder record is already correct as-is.
      const splitParts = await deviceSplit(
        client,
        [{deviceId: currentDeviceId, url: currentUrl}],
        currentCallback,
        msat,
        currentAmount
      )
      // past this point the input IS burned server-side, so both outputs
      // are tracked BEFORE the remainder record is removed - otherwise a
      // settle failure here would strand the change note (CONFIRMED on
      // the device) with no local record. A failed settle still tracks a
      // mirror of the raw output (unverified, at its expected pre-fee
      // amount) and stops the chain; the next device refresh repairs it
      let settledChange = splitParts.change
      let changeVerified = false
      let settleError: Error | null = null
      try {
        settledChange = await deviceSettle(client, splitParts.change)
        changeVerified = true
      } catch (err) {
        settleError = new Error(
          `Settling the change note didn't complete (${(err as Error).message}) - it's kept as an unverified note; refresh it with the vault connected to repair.`
        )
      }
      const part = await addBearer({
        url: splitParts.target.url,
        callback: splitParts.target.callback,
        amount: msat,
        verified: true,
        mintPubkey: bearer.mintPubkey,
        deviceId: splitParts.target.deviceId,
        deviceHash: splitParts.target.deviceHash
      })
      if (target.label) await updateBearer(part.id, {label: target.label})
      parts.push({...part, label: target.label ?? part.label})
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
      lastFeeMsat = expectedChange - settledChange.amountMsat
      totalFeeMsat += lastFeeMsat
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
      // a single-k1 request, so a NoteSpentError here is unambiguous: it's
      // remainderId that's already gone, not some other selected note -
      // lock it the same way refresh does, and skip the rotate-in-place
      // attempt below (there's nothing left to rotate)
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
        // the split request may have landed despite the failure - probe
        // the remainder's k1 before deciding what the secrets it carried
        // are worth
        const outcome = await probeBurnedNote(currentUrl)
        if (outcome === 'gone') {
          // the burn landed - the carried secrets are the only money left;
          // fall through to record both outputs below
          partK1 = splitError.newSecrets[0]!
          changeK1 = splitError.newSecrets[1]!
        } else if (outcome === 'unknown') {
          // can't tell: track both possible outputs without dropping the
          // remainder, and stop the chain here
          const untaggedPart: NewBearer = {
            url: withNewK1(currentUrl, splitError.newSecrets[0]!, msat),
            callback: currentCallback,
            amount: msat,
            verified: false,
            mintPubkey: bearer.mintPubkey
          }
          await addBearer(untaggedPart)
          await addBearer({
            url: withNewK1(
              currentUrl,
              splitError.newSecrets[1]!,
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
        // a definitive rejection (or a probe showing nothing burned) still
        // puts the remainder's k1 on the wire via the failed callback
        // request, so it's rotated in place (best-effort) rather than
        // left exposed - but always kept, never dropped, so a failed
        // split costs nothing
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
          // failure here is exactly as ambiguous as the split's own - it
          // may have landed despite the failure, and the fresh secret it
          // carries would then be the ONLY copy of the remainder left
          // (the pre-attempt one now burned). Silently swallowing this
          // turns a purely defensive "don't leave k1 exposed" step into
          // real fund loss: the remainder would vanish entirely, with
          // neither the old record (burned) nor the new secret
          // (discarded) pointing to real money
          if (err instanceof AmbiguousMutationError) {
            const outcome = await probeBurnedNote(currentUrl)
            if (outcome === 'gone') {
              // the rotate landed - its carried secret is the only money
              // left
              await updateBearer(remainderId, {
                url: withNewK1(currentUrl, err.newSecrets[0]!, currentAmount)
              })
            } else if (outcome === 'unknown') {
              // can't tell: keep the pre-rotate record (already shown
              // below) AND track the possible rotated copy, rather than
              // gamble either way
              await addBearer({
                url: withNewK1(currentUrl, err.newSecrets[0]!, currentAmount),
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
          // definitive rejection) leaves the remainder recorded under its
          // pre-attempt secret rather than vanish
        }
        throw splitError
      }
    }
    // the split burned the remainder server-side from here on, so both
    // outputs are recorded BEFORE its record is removed; the change is
    // then settled in place - a failed settle leaves it as an unverified
    // note a refresh can repair, not a lost secret
    const part = await addBearer({
      url: withNewK1(currentUrl, partK1, msat, partSignature),
      callback: currentCallback,
      amount: msat,
      verified: true,
      mintPubkey: bearer.mintPubkey
    })
    if (target.label) await updateBearer(part.id, {label: target.label})
    parts.push({...part, label: target.label ?? part.label})
    const remainder = await addBearer({
      url: withNewK1(currentUrl, changeK1, expectedChange, changeSignature),
      callback: currentCallback,
      amount: expectedChange,
      verified: false,
      mintPubkey: bearer.mintPubkey
    })
    removeBearer(remainderId)
    remainderId = remainder.id
    // settleNote learns the change's true value (a mint MAY have deducted
    // a fee - LUD-25) by hash, without another rotation
    try {
      const settled = await settleNote(
        currentUrl,
        changeK1,
        expectedChange,
        changeSignature
      )
      lastFeeMsat = expectedChange - settled.amountMsat
      totalFeeMsat += lastFeeMsat
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

  return {parts, remainderId, totalFeeMsat, lastFeeMsat}
}
