import {For, Show, createSignal, onSettled} from 'solid-js'
import type {JSX} from '@solidjs/web'
import {Portal} from '@solidjs/web'

// Minimal in-house toast queue - replaces solid-toast, which never moved
// past Solid 1.x. Covers exactly what this app uses: blank/success/error/
// loading/custom toasts, a per-toast position override (see helpers.ts's
// notify), dismiss by id, and pause-on-hover so a holder reading a long
// error doesn't watch it vanish mid-sentence.

export type ToastPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right'

export type ToastKind = 'blank' | 'success' | 'error' | 'loading' | 'custom'

export interface ToastOptions {
  position?: ToastPosition
  // ms; Infinity keeps it up until dismissed. Defaults to <Toaster>'s own
  duration?: number
}

// a function, not an element: it's called inside the toast's own component,
// so anything reactive it reads (e.g. WalletContext's lock countdown) stays
// owned and live, rather than being built once outside any render tree
export type ToastContent = string | (() => JSX.Element)

interface ToastEntry {
  id: string
  kind: ToastKind
  content: ToastContent
  position?: ToastPosition
  duration?: number
}

// module-scope queue - this is a client-only app (no SSR), and every caller
// (helpers.ts, WalletContext, index.tsx's SW prompt) is a plain function,
// not a component. ownedWrite: a toast may be raised from wherever the
// triggering code happens to run, including inside a reactive scope
const [toasts, setToasts] = createSignal<ToastEntry[]>([], {ownedWrite: true})

let counter = 0
const show =
  (kind: ToastKind) =>
  (content: ToastContent, options?: ToastOptions): string => {
    const id = `toast-${++counter}`
    setToasts(list => [...list, {id, kind, content, ...options}])
    return id
  }

const dismiss = (id: string): void => {
  setToasts(list => list.filter(t => t.id !== id))
}

export const toast = Object.assign(show('blank'), {
  success: show('success'),
  error: show('error'),
  loading: show('loading'),
  custom: show('custom'),
  dismiss
})

const ICON_TEXT: Partial<Record<ToastKind, string>> = {
  success: '✓',
  error: '!',
  loading: ''
}

const ToastItem = (props: {toast: ToastEntry; duration: number}) => {
  // resolved on first start(), not here - a top-level props read in a
  // component body is untracked in Solid 2 (and warns in dev)
  let remaining: number | undefined
  let startedAt = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const start = () => {
    remaining ??= props.toast.duration ?? props.duration
    if (timer !== undefined || !Number.isFinite(remaining)) return
    startedAt = Date.now()
    timer = setTimeout(() => dismiss(props.toast.id), remaining)
  }
  const pause = () => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
    remaining! -= Date.now() - startedAt
  }

  onSettled(() => {
    start()
    return () => clearTimeout(timer)
  })

  return (
    <div
      class={['toast', `toast-${props.toast.kind}`]}
      role={props.toast.kind === 'error' ? 'alert' : 'status'}
      aria-live={props.toast.kind === 'error' ? 'assertive' : 'polite'}
      onMouseEnter={pause}
      onMouseLeave={start}
    >
      <Show when={props.toast.kind in ICON_TEXT}>
        <span class={['toast-icon', `toast-icon-${props.toast.kind}`]}>
          {ICON_TEXT[props.toast.kind]}
        </span>
      </Show>
      <div class="toast-message">
        {typeof props.toast.content === 'function'
          ? props.toast.content()
          : props.toast.content}
      </div>
    </div>
  )
}

const POSITIONS: ToastPosition[] = [
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right'
]

export const Toaster = (props: {
  position?: ToastPosition
  // default duration for every toast that doesn't set its own
  duration?: number
  // distance of the top-* stacks from the viewport edge, px (bottom-*
  // stacks always sit 16px up)
  topOffset?: number
}) => {
  const position = () => props.position ?? 'top-center'
  const at = (p: ToastPosition) =>
    toasts().filter(t => (t.position ?? position()) === p)
  return (
    <Portal>
      <For each={POSITIONS}>
        {p => (
          <Show when={at(p).length > 0}>
            <div
              class={['toaster', `toaster-${p}`]}
              style={
                p.startsWith('top')
                  ? {top: `${props.topOffset ?? 16}px`}
                  : {bottom: '16px'}
              }
            >
              <For each={at(p)}>
                {t => <ToastItem toast={t} duration={props.duration ?? 4000} />}
              </For>
            </div>
          </Show>
        )}
      </For>
    </Portal>
  )
}

export default toast
