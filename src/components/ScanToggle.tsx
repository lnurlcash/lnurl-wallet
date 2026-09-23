import type {Component} from 'solid-js'
import {Show, createSignal, onMount} from 'solid-js'
import {IoScanSharp} from 'solid-icons/io'
import Scanner, {canScan, hasCameraDevice} from './Scanner'

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
  // starts optimistic (canScan()'s cheap, synchronous "does the API even
  // exist" check) so a device that DOES have a camera never flashes the
  // button away and back while hasCameraDevice's own async probe (an
  // actual device enumeration, see Scanner.tsx) is still pending - only
  // flips to hidden once that probe positively comes back empty
  const [available, setAvailable] = createSignal(canScan())

  onMount(async () => {
    setAvailable(await hasCameraDevice())
  })

  const handleScan = (value: string) => {
    setShowScanner(false)
    props.onScan(value)
  }

  return (
    <Show when={available()}>
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
