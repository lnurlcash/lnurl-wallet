import type {Accessor} from 'solid-js'
import {createContext, createSignal, onSettled, useContext} from 'solid-js'
import type {JSX} from '@solidjs/web'

import {
  DeviceClient,
  SerialTransport,
  BleTransport,
  type DeviceInfo,
  type DeviceNote,
  type DeviceTransport
} from './device'
import {notify, NotifyKind} from './helpers'
import {drainPendingDeviceOps} from './deviceQueue'
import {
  identityChallenge,
  judgeIdentity,
  identityWarning,
  pinIdentity,
  readPinnedIdentity,
  type PinVerdict
} from './devicePinning'

export type DeviceConnectionState = 'disconnected' | 'connecting' | 'connected'

export type DeviceTransportKind = 'serial' | 'ble'

// Which transport last worked, so the next load can bring the vault back
// without a chooser. Not a secret and not note data - plain localStorage,
// same as trustedMints.ts.
const LAST_TRANSPORT_KEY = 'lnurlvault.lastTransport'

const readLastTransport = (): DeviceTransportKind | null => {
  try {
    const raw = localStorage.getItem(LAST_TRANSPORT_KEY)
    return raw === 'serial' || raw === 'ble' ? raw : null
  } catch {
    return null
  }
}

const rememberTransport = (kind: DeviceTransportKind | null): void => {
  try {
    if (kind) localStorage.setItem(LAST_TRANSPORT_KEY, kind)
    else localStorage.removeItem(LAST_TRANSPORT_KEY)
  } catch {
    // private browsing, quota - reconnect is a convenience, never required
  }
}

export type DeviceContextType = {
  connectionState: Accessor<DeviceConnectionState>
  info: Accessor<DeviceInfo | null>
  notes: Accessor<DeviceNote[]>
  serialSupported: boolean
  bleSupported: boolean
  connectSerial: () => Promise<void>
  connectBle: () => Promise<void>
  disconnect: () => Promise<void>
  // true while the on-load silent reconnect is still running, so the pairing
  // UI can hold off offering buttons the owner is about to not need
  reconnecting: Accessor<boolean>
  // trust-on-first-use verdict for the connected vault (devicePinning.ts).
  // null before a connection, or on firmware with no identity
  identity: Accessor<PinVerdict | null>
  // accept a vault this wallet has not seen before as the one to trust from
  // now on. The owner's call, not the wallet's: a wipe changes the key on
  // purpose, and only they know whether it should have
  trustCurrentIdentity: () => void
  refresh: () => Promise<void>
  rename: (id: string, label: string) => Promise<void>
  deleteNote: (id: string) => Promise<void>
  // clears every spent note in one press - see DeviceClient.pruneSpent
  pruneSpent: () => Promise<number>
  // exposed for a later phase (device-backed secrets in the rotate/split/
  // merge/melt flows) - the pairing UI itself never needs it directly
  client: Accessor<DeviceClient | null>
}

const DeviceContext = createContext<DeviceContextType>()

export const DeviceProvider = (props: {children: JSX.Element}) => {
  const [connectionState, setConnectionState] =
    createSignal<DeviceConnectionState>('disconnected')
  const [info, setInfo] = createSignal<DeviceInfo | null>(null)
  const [notes, setNotes] = createSignal<DeviceNote[]>([])
  const [client, setClient] = createSignal<DeviceClient | null>(null)
  const [reconnecting, setReconnecting] = createSignal(false)
  const [identity, setIdentity] = createSignal<PinVerdict | null>(null)

  const teardown = () => {
    setClient(null)
    setConnectionState('disconnected')
    setInfo(null)
    setNotes([])
    setIdentity(null)
  }

  // Ask the vault to prove it is the one this wallet paired with before
  // (lnurl-vault issue #69). Never throws: firmware without an identity is
  // older firmware, not a fault, and must not break a working connection.
  //
  // A 'changed' or 'invalid' verdict does NOT disconnect on its own. A wipe
  // changes the key deliberately, so only the owner knows whether a different
  // vault is the wrong vault - the wallet's job is to say so loudly and let
  // them decide (see trustCurrentIdentity, and pages/Vault.tsx).
  const checkIdentity = async (current: DeviceClient) => {
    const nonce = identityChallenge()
    let answer = null
    try {
      answer = await current.identify(nonce)
    } catch {
      answer = null
    }
    const verdict = judgeIdentity(answer, nonce, readPinnedIdentity())
    setIdentity(verdict)
    // First sighting pins silently - there is nothing to compare against, and
    // asking someone to approve a key they have never seen teaches nothing.
    if (verdict.kind === 'new') pinIdentity(verdict.pubkey)
    const warning = identityWarning(verdict)
    if (warning) notify(warning, NotifyKind.ERROR)
  }

  const trustCurrentIdentity = () => {
    const verdict = identity()
    if (verdict?.kind !== 'changed') return
    pinIdentity(verdict.pubkey)
    setIdentity({kind: 'known', pubkey: verdict.pubkey})
  }

  const refresh = async () => {
    const current = client()
    if (!current) return
    const [deviceInfo, deviceNotes] = await Promise.all([
      current.getInfo(),
      current.listAllNotes()
    ])
    setInfo(deviceInfo)
    setNotes(deviceNotes)
  }

  // shared by connectSerial/connectBle - only the transport's own
  // requestAndConnect() differs between them
  //
  // Device identity: the vault now carries a per-device key and answers a
  // challenge over it (`identify`), so trust-on-first-use IS implemented -
  // see checkIdentity above and devicePinning.ts. It replaces the note that
  // used to sit here explaining why it could not be.
  //
  // It proves the thing answering holds the same key as last time, and
  // nothing about who is holding it. The other mitigations still carry the
  // weight they always did: every plaintext export needs a physical press on
  // the device, and pending-op recovery (deviceQueue.ts) only ever pushes
  // confirm/mark_spent at note ids this wallet staged.
  const connectWith = async (
    requestAndConnect: () => Promise<DeviceTransport>,
    kind?: DeviceTransportKind
  ) => {
    if (connectionState() !== 'disconnected') return
    setConnectionState('connecting')
    try {
      const transport = await requestAndConnect()
      const newClient = new DeviceClient(transport)
      newClient.onDisconnect(teardown)
      setClient(newClient)
      setConnectionState('connected')
      if (kind) rememberTransport(kind)
      await checkIdentity(newClient)
      // reconciles any confirm/mark_spent this device missed from a
      // previous session that dropped mid-operation (see deviceQueue.ts) -
      // drainPendingDeviceOps never throws, it just leaves whatever didn't
      // go through queued for the next connect to retry
      await drainPendingDeviceOps(newClient)
      try {
        await refresh()
      } catch (err) {
        // paired but the first read failed - stay connected, the pairing
        // UI can retry with its own Refresh button rather than unwind an
        // otherwise-live session over one flaky read
        notify((err as Error).message, NotifyKind.ERROR)
      }
    } catch (err) {
      setConnectionState('disconnected')
      // the browser's own device chooser being dismissed isn't a real
      // error - both WebSerial and Web Bluetooth reject requestPort/
      // requestDevice with this DOMException name on cancel
      if ((err as Error)?.name !== 'NotFoundError') {
        notify((err as Error).message, NotifyKind.ERROR)
      }
    }
  }

  const connectSerial = () =>
    connectWith(() => SerialTransport.requestAndConnect(), 'serial')
  const connectBle = () =>
    connectWith(() => BleTransport.requestAndConnect(), 'ble')
  // Does what answered actually speak the vault protocol? getPorts() hands
  // back every port this origin was ever granted, so a reconnect must not
  // assume the first one is a vault - see SerialTransport.tryReconnect.
  const probe = async (transport: DeviceTransport): Promise<boolean> => {
    try {
      await new DeviceClient(transport).getInfo()
      return true
    } catch {
      return false
    }
  }

  // On load, bring back the vault the owner already granted, with no click.
  // Only for a transport that has worked here before: an unprompted scan of
  // every granted port on a wallet nobody has ever paired is noise.
  onSettled(() => {
    void (async () => {
      const last = readLastTransport()
      if (!last) return
      if (connectionState() !== 'disconnected') return
      setReconnecting(true)
      try {
        const transport =
          last === 'serial'
            ? await SerialTransport.tryReconnect(probe)
            : await BleTransport.tryReconnect(probe)
        if (!transport) return
        const newClient = new DeviceClient(transport)
        newClient.onDisconnect(teardown)
        setClient(newClient)
        setConnectionState('connected')
        await checkIdentity(newClient)
        await drainPendingDeviceOps(newClient)
        await refresh().catch(() => {})
      } catch {
        // nothing granted, unplugged, or in use elsewhere. Silent by design:
        // this runs without anyone asking for it, so it must never interrupt
      } finally {
        setReconnecting(false)
      }
    })()
  })

  const disconnect = async () => {
    const current = client()
    if (current) await current.disconnect().catch(() => {})
    // An explicit disconnect is a decision, so stop bringing it back.
    rememberTransport(null)
    teardown()
  }

  const rename = async (id: string, label: string) => {
    const current = client()
    if (!current) return
    await current.rename(id, label)
    await refresh()
  }

  const deleteNote = async (id: string) => {
    const current = client()
    if (!current) return
    await current.delete(id)
    await refresh()
  }

  const pruneSpent = async (): Promise<number> => {
    const current = client()
    if (!current) return 0
    const {removed} = await current.pruneSpent()
    await refresh()
    return removed
  }

  return (
    <DeviceContext
      value={{
        connectionState,
        info,
        notes,
        serialSupported: SerialTransport.isSupported(),
        bleSupported: BleTransport.isSupported(),
        connectSerial,
        connectBle,
        disconnect,
        reconnecting,
        identity,
        trustCurrentIdentity,
        refresh,
        rename,
        deleteNote,
        pruneSpent,
        client
      }}
    >
      {props.children}
    </DeviceContext>
  )
}

export const useDevice = () => {
  const context = useContext(DeviceContext)
  if (!context) {
    throw new Error('useDevice: cannot find a DeviceContext')
  }
  return context
}
