import type {Component} from 'solid-js'
import {Show, createMemo} from 'solid-js'
import {IoDownloadSharp} from 'solid-icons/io'

import {copyToClipboard} from '../helpers'
import {qrMatrix, qrSvg} from '../qr'

export interface QrProps {
  value: string
  width?: number
  height?: number
  // e.g. `lightning:${invoice}` - wraps the code in a link so a phone can
  // offer its own "open in wallet" picker on tap, same as scanning it would
  href?: string
}

const Qr: Component<QrProps> = (props: QrProps) => {
  // the actual on-screen size is controlled by CSS (.qrcode scales the SVG
  // to fill its box via its viewBox - see style.scss) - width/height only
  // set the pixel size a downloaded .svg opens at in other viewers
  const width = () => props.width || 340
  const height = () => props.height || 340
  const matrix = createMemo(() => qrMatrix(props.value))

  // built from the same value as the on-screen code (qr.ts renders both),
  // so the downloaded file is identical to what's shown
  const download = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const blob = new Blob([qrSvg(props.value, width())], {
      type: 'image/svg+xml'
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'qrcode.svg'
    a.click()
    URL.revokeObjectURL(url)
  }

  const code = (
    <div class="qrcode" onClick={() => copyToClipboard(props.value)}>
      <svg
        width={width()}
        height={height()}
        viewBox={`0 0 ${matrix().size} ${matrix().size}`}
        shape-rendering="crispEdges"
      >
        <rect width={matrix().size} height={matrix().size} fill="#fff" />
        <path fill="#000" d={matrix().path} />
      </svg>
    </div>
  )
  return (
    <div class="qr-frame">
      <Show when={props.href} fallback={code}>
        <a class="qrcode-link" href={props.href}>
          {code}
        </a>
      </Show>
      <button
        type="button"
        class="icon-btn qr-download-btn"
        title="Download QR code as SVG"
        onClick={download}
      >
        <IoDownloadSharp />
      </button>
    </div>
  )
}
export default Qr
