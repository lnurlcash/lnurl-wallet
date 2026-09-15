import type {
  storage,
  resource,
  inc,
  intent,
  fs,
  ble,
  serial,
  link
} from '@napplet/sdk'

declare global {
  interface Window {
    napplet?: {
      storage?: typeof storage
      resource?: typeof resource
      inc?: typeof inc
      intent?: typeof intent
      fs?: typeof fs
      ble?: typeof ble
      serial?: typeof serial
      link?: typeof link
    }
  }
}
