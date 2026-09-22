import type {Component, JSX} from 'solid-js'
import {Show, onCleanup, onMount} from 'solid-js'
import {Portal} from 'solid-js/web'
import {IoCloseSharp} from 'solid-icons/io'

export type DialogProps = {
  onClose: () => void
  children: JSX.Element
  // hides the top-right X button while leaving every other way to close
  // (Escape, clicking the backdrop) intact - for a dialog whose own content
  // already crowds that corner, or that wants closing to only ever be
  // explicit/backdrop-driven
  hideCloseButton?: boolean
}

// shared modal chrome (backdrop + panel + top-right close button) for every
// dialog in the wallet (ReceiveDialog, MeltDialog, TransferDialog, Mint's
// invoice card) - previously each rendered its own bare <figure
// class="setup-card"> straight into the page flow, with no overlay/backdrop
// and only an in-form "Cancel" button to close it. Portal'd to <body> so it
// stacks above the fixed nav (z-index 2/3) regardless of where it's mounted.
const Dialog: Component<DialogProps> = props => {
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') props.onClose()
  }

  onMount(() => document.addEventListener('keydown', onKeydown))
  onCleanup(() => document.removeEventListener('keydown', onKeydown))

  return (
    <Portal>
      <div class="dialog-overlay" onClick={() => props.onClose()}>
        <div
          class="dialog"
          role="dialog"
          aria-modal="true"
          // stop the backdrop's close-on-click from also seeing clicks that
          // land inside the panel itself
          onClick={e => e.stopPropagation()}
        >
          <Show when={!props.hideCloseButton}>
            <button
              type="button"
              class="icon-btn dialog-close-btn"
              title="Close"
              onClick={() => props.onClose()}
            >
              <IoCloseSharp />
            </button>
          </Show>
          {props.children}
        </div>
      </div>
    </Portal>
  )
}
export default Dialog
