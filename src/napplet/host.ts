import type {storage, resource, inc} from '@napplet/sdk'

export type WalletHost = {
  storage: Pick<typeof storage, 'getItem' | 'setItem' | 'keys'>
  resource: Pick<typeof resource, 'bytes'>
  inc?: Pick<typeof inc, 'on'>
}

/** Refuse an ephemeral wallet when the shell cannot persist its secrets. */
export const getWalletHost = (): WalletHost => {
  const host = window.napplet
  if (!host?.storage || !host.resource) {
    throw new Error(
      'Open this wallet in a napplet shell with storage and resource support.'
    )
  }
  return {storage: host.storage, resource: host.resource, inc: host.inc}
}
