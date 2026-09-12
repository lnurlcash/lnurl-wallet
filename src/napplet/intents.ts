import {
  isBolt11Invoice,
  decodeBolt11AmountMsat,
  resolveNoteInput
} from '../lnurlcash'
import {claimLinkToNoteInput, claimParamsFromHref} from '../claimLink'
import type {WalletHost} from './host'
import {NOTE_DESIGN_CONVENTION, parseNoteDesignMessage} from './note-interface'
import type {NoteDesign} from './design'

export const WALLET_CONVENTIONS = [
  'napplet:wallet/open',
  'napplet:wallet/receive',
  'napplet:wallet/pay',
  NOTE_DESIGN_CONVENTION
] as const
export type WalletRequest =
  | {
      action: 'open' | 'receive' | 'pay'
      value: string
      sender: string
    }
  | {action: 'design'; design: NoteDesign; sender: string}

/** Validate opaque incoming data without fetching, persisting or spending anything. */
export const parseWalletIntent = (
  topic: string,
  payload: unknown,
  sender: string
): WalletRequest => {
  if (
    !WALLET_CONVENTIONS.includes(topic as (typeof WALLET_CONVENTIONS)[number])
  ) {
    throw new Error('Unsupported wallet convention.')
  }
  if (
    payload !== undefined &&
    (typeof payload !== 'object' || payload === null || Array.isArray(payload))
  ) {
    throw new Error('Invalid wallet request.')
  }
  const data = (payload ?? {}) as Record<string, unknown>
  const action = topic.slice(
    'napplet:wallet/'.length
  ) as WalletRequest['action']
  if (action === 'open') return {action, value: '', sender}
  if (action === 'design')
    return {
      action,
      design: parseNoteDesignMessage(payload),
      sender: sender.slice(0, 200)
    }
  const value = action === 'receive' ? data.note : data.invoice
  if (typeof value !== 'string' || value.length > 16000)
    throw new Error('Missing or oversized wallet input.')
  const normalized = value.trim().replace(/^lightning:/i, '')
  if (action === 'receive') {
    const params = claimParamsFromHref(normalized)
    const url = resolveNoteInput(
      (params && claimLinkToNoteInput(params)) || normalized
    )
    if (!url || new URL(url).protocol !== 'https:')
      throw new Error('Expected an HTTPS LNURLcash note.')
  } else if (
    !isBolt11Invoice(normalized) ||
    !decodeBolt11AmountMsat(normalized)
  ) {
    throw new Error('Expected a BOLT11 invoice with a fixed amount.')
  }
  return {action, value: normalized, sender: sender.slice(0, 200)}
}

/** Subscribe once at startup; only the host SDK receives authenticated messages. */
export const listenWalletIntents = (
  host: WalletHost,
  receive: (request: WalletRequest) => void,
  reject: (message: string) => void
): (() => void) => {
  const subscriptions = WALLET_CONVENTIONS.map(topic =>
    host.inc?.on(topic, event => {
      try {
        receive(
          parseWalletIntent(
            topic,
            event.payload,
            String(event.sender ?? 'Host')
          )
        )
      } catch {
        reject('The shell delivered an invalid wallet request.')
      }
    })
  )
  return () => subscriptions.forEach(subscription => subscription?.close())
}
