import type {Component} from 'solid-js'
import {Show, createSignal, onCleanup, onMount} from 'solid-js'
import jsQR from 'jsqr'

export type ScannerProps = {
  // called once with the first QR payload that `accept` (if given) lets through
  onScan: (value: string) => void
  accept?: (value: string) => boolean
}

// whether this browser even exposes the camera API at all - a cheap,
// synchronous prerequisite check (no permission prompt, no device probe)
// for hasCameraDevice below, and the one ScanToggle falls back to showing
// while that async probe is still pending, so a browser that DOES have a
// camera doesn't flash the scan button away and back.
export const canScan = (): boolean =>
  typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

// whether this device actually has a camera to scan with, not just the
// browser API for one - canScan() alone stays true on a desktop/laptop
// with zero webcams (the API exists, there's simply nothing to open), which
// used to mean tapping the scan button always "worked" right up until
// getUserMedia rejected and Scanner showed a wrong "Camera access was
// denied" error for what was actually "no camera exists". enumerateDevices
// lists every input device - including its `kind` - without requesting
// permission first (labels are blank until permission is granted, but
// `kind` itself is always populated), so this needs no user prompt to
// answer honestly. Never throws: an environment that can't enumerate at
// all (permissions-policy denial, an unusual embedded webview) is treated
// the same as "no camera" - the button stays hidden rather than risk
// showing one that can't work.
export const hasCameraDevice = async (): Promise<boolean> => {
  if (!canScan()) return false
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.some(d => d.kind === 'videoinput')
  } catch {
    return false
  }
}

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
    } catch (err) {
      // NotFoundError: hasCameraDevice's own probe (ScanToggle) missed a
      // race - the camera was unplugged/reclaimed between probing and
      // opening. Distinct message from an actual permission denial, which
      // is the far more common real-world case.
      setError(
        err instanceof DOMException && err.name === 'NotFoundError'
          ? 'No camera was found.'
          : 'Camera access was denied.'
      )
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
