import {createFreshSignal} from './freshSignal'

// in-memory handoff of a bolt11 invoice from ReceiveDialog (paste detected
// an invoice, not a note) to MeltDialog on the Wallet page - still needed
// when ReceiveDialog is reached from Claim.tsx instead, which has no
// MeltDialog of its own to open directly (see ReceiveDialog's onMelt prop
// for the same-page case). Deliberately NOT a URL query param: with the
// hash router that lands in location.hash, hence in browser history and
// any bookmark of it - an invoice is worth far less than a k1, but it
// still records a pending payment (amount, sometimes a description) in
// persistent local state for no reason. Module-level so neither side has
// to import the other's component.
const [pendingMeltInvoice, setPendingMeltInvoice] = createFreshSignal<
  string | null
>(null)

export const handoffMeltInvoice = (pr: string): void => {
  setPendingMeltInvoice(pr.trim())
}

// one-shot: reading consumes it, so a later plain visit to /wallet (or a
// reload) doesn't resurrect a stale invoice
export const takeMeltInvoice = (): string | null => {
  const pr = pendingMeltInvoice()
  setPendingMeltInvoice(null)
  return pr
}
