import type {Component} from 'solid-js'
import {Show, createSignal, onCleanup, onMount} from 'solid-js'
import jsQR from 'jsqr'

export type ScannerProps = {
  // called once with the first QR payload that `accept` (if given) lets through
  onScan: (value: string) => void
  accept?: (value: string) => boolean
}

// whether this device/browser can even attempt a camera scan - used to hide
// the scan toggle entirely rather than show it and fail on first tap
export const canScan = (): boolean =>
  typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

// Camera QR scanning: the native BarcodeDetector API when available (fast,
// no extra decode work on the main thread), falling back to jsQR (~30kB)
// decoding raw video frames via an off-screen canvas everywhere else -
// notably Firefox, which still ships no BarcodeDetector on desktop or
// mobile, and would otherwise be unable to scan at all.
const Scanner: Component<ScannerProps> = props => {
  let videoRef: HTMLVideoElement | undefined
  let stream: MediaStream | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  const [error, setError] = createSignal<string | null>(null)
  const hasBarcodeDetector = 'BarcodeDetector' in window

  const stop = () => {
    if (timer) clearInterval(timer)
    timer = null
    stream?.getTracks().forEach(track => track.stop())
    stream = null
  }

  // shared by both detection paths - returns true once a value has been
  // accepted and handed off, so the caller can stop its own scan loop
  const handleValue = (value: string): boolean => {
    if (!value) return false
    if (props.accept && !props.accept(value)) return false
    stop()
    props.onScan(value)
    return true
  }

  const scanWithBarcodeDetector = () => {
    const detector = new (window as any).BarcodeDetector({
      formats: ['qr_code']
    })
    timer = setInterval(async () => {
      if (!videoRef || videoRef.readyState < 2) return
      try {
        const codes = await detector.detect(videoRef)
        for (const code of codes) {
          if (handleValue(String(code.rawValue || ''))) return
        }
      } catch {
        // a single failed detection pass is not fatal - just try again
      }
    }, 250)
  }

  const scanWithJsQr = () => {
    // an off-screen canvas, never attached to the DOM - only used to pull
    // pixel data out of the video element for jsQR to decode
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', {willReadFrequently: true})
    if (!ctx) return
    timer = setInterval(() => {
      if (!videoRef || videoRef.readyState < 2) return
      canvas.width = videoRef.videoWidth
      canvas.height = videoRef.videoHeight
      ctx.drawImage(videoRef, 0, 0, canvas.width, canvas.height)
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const result = jsQR(frame.data, frame.width, frame.height)
      if (result) handleValue(result.data)
    }, 250)
  }

  onMount(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Camera access is not available in this browser.')
      return
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {facingMode: 'environment'}
      })
    } catch {
      setError('Camera access was denied.')
      return
    }
    if (!videoRef) return
    videoRef.srcObject = stream
    await videoRef.play()

    if (hasBarcodeDetector) scanWithBarcodeDetector()
    else scanWithJsQr()
  })

  onCleanup(stop)

  return (
    <Show
      when={error()}
      fallback={
        // playsinline/muted so iOS Safari renders the stream inline
        // instead of forcing fullscreen playback
        <video ref={videoRef} class="scanner" playsinline muted />
      }
    >
      <p class="warning">{error()} Paste the note instead, below.</p>
    </Show>
  )
}
export default Scanner
