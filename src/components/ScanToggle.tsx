import type {Component} from 'solid-js'
import {Show, createSignal} from 'solid-js'
import {IoScanSharp} from 'solid-icons/io'
import Scanner, {canScan} from './Scanner'

export type ScanToggleProps = {
  onScan: (value: string) => void
  accept?: (value: string) => boolean
}

// a QR-scan icon for a paste-input-row: camera access isn't requested until
// this is deliberately opened, and it closes itself the moment a value is
// accepted (Scanner has already stopped its own stream by then regardless -
// see its handleValue) - drop this into any paste-widget that should also
// take a scanned QR, not just typed/pasted text
const ScanToggle: Component<ScanToggleProps> = props => {
  const [showScanner, setShowScanner] = createSignal(false)

  const handleScan = (value: string) => {
    setShowScanner(false)
    props.onScan(value)
  }

  return (
    <Show when={canScan()}>
      <Show when={showScanner()}>
        {/* forces its own full-width line via flex-wrap, so the preview
        sits above the row's icons/input instead of squeezed inline with
        them - see .paste-input-row */}
        <div class="scan-preview">
          <Scanner onScan={handleScan} accept={props.accept} />
        </div>
      </Show>
      <button
        type="button"
        class="icon-btn paste-scan-btn"
        classList={{active: showScanner()}}
        title={showScanner() ? 'Stop scanning' : 'Scan a QR code'}
        onClick={() => setShowScanner(v => !v)}
      >
        <IoScanSharp />
      </button>
    </Show>
  )
}
export default ScanToggle
