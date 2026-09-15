import type {BleApi, serial, Subscription} from '@napplet/sdk'
type SerialApi = typeof serial
import {BleFrameReassembler, encodeBleFrames, splitLines} from '../device'
import type {DeviceTransport} from '../device'

export const VAULT_SERVICE = '407e0f1a-2c3d-118e-d64b-1b534e601a9c'
export const VAULT_RX = {
  service: VAULT_SERVICE,
  characteristic: '407e0f1b-2c3d-118e-d64b-1b534e601a9c'
}
export const VAULT_TX = {
  service: VAULT_SERVICE,
  characteristic: '407e0f1c-2c3d-118e-d64b-1b534e601a9c'
}

/** Adapt runtime-owned device sessions to the original vault command client. */
export class NappletDeviceTransport implements DeviceTransport {
  private subscription?: Subscription
  private handler: (message: unknown) => void = () => {}
  private dropped: (reason?: string) => void = () => {}
  private closed = false
  private buffer = ''
  private decoder = new TextDecoder()
  private frames = new BleFrameReassembler()
  private constructor(
    readonly kind: 'serial' | 'ble',
    private session: string,
    private serial?: SerialApi,
    private ble?: BleApi
  ) {}

  /** Open only in response to a holder action; the shell owns chooser and permission. */
  static async open(
    kind: 'serial' | 'ble',
    api: {serial?: SerialApi; ble?: BleApi}
  ): Promise<NappletDeviceTransport> {
    if (kind === 'serial') {
      if (!api.serial) throw new Error('This shell has no serial capability.')
      const {session} = await api.serial.open({
        options: {baudRate: 115200},
        label: 'LNURLcash vault'
      })
      const transport = new NappletDeviceTransport(kind, session.id, api.serial)
      transport.subscription = api.serial.onEvent(event => {
        if (event.sessionId !== session.id) return
        if (
          event.type === 'closed' ||
          (event.type === 'state' && event.state === 'closed')
        )
          transport.end('Device disconnected.')
        if (event.type === 'data') transport.receiveSerial(event.data)
      })
      return transport
    }
    if (!api.ble) throw new Error('This shell has no Bluetooth capability.')
    const {session} = await api.ble.open({
      filters: [{services: [VAULT_SERVICE]}],
      label: 'LNURLcash vault'
    })
    const transport = new NappletDeviceTransport(
      kind,
      session.id,
      undefined,
      api.ble
    )
    transport.subscription = api.ble.onEvent(event => {
      if (event.sessionId !== session.id) return
      if (
        event.type === 'closed' ||
        (event.type === 'state' && event.state === 'closed')
      )
        transport.end('Device disconnected.')
      if (
        event.type === 'notification' &&
        event.target.service === VAULT_TX.service &&
        event.target.characteristic === VAULT_TX.characteristic
      ) {
        const message = transport.frames.push(new Uint8Array(event.data))
        if (message !== null) transport.handler(message)
      }
    })
    try {
      await api.ble.subscribe(session.id, VAULT_TX)
    } catch (error) {
      await transport.disconnect()
      throw error
    }
    return transport
  }

  private receiveSerial(data: number[]): void {
    this.buffer += this.decoder.decode(new Uint8Array(data), {stream: true})
    if (this.buffer.length > 1024 * 1024) {
      this.end('Device exceeded the receive buffer limit.')
      void this.serial?.close(this.session).catch(() => {})
      return
    }
    const {lines, rest} = splitLines(this.buffer)
    this.buffer = rest
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        this.handler(JSON.parse(line))
      } catch {
        /* Boot log lines are not protocol responses. */
      }
    }
  }

  /** Preserve command order and exact upstream framing. */
  async send(message: unknown): Promise<void> {
    if (this.closed) throw new Error('Device disconnected.')
    if (this.kind === 'serial')
      await this.serial!.write(
        this.session,
        new TextEncoder().encode(JSON.stringify(message) + '\n')
      )
    else
      for (const frame of encodeBleFrames(message))
        await this.ble!.write(this.session, VAULT_RX, [...frame], {
          response: 'with-response'
        })
  }
  onMessage(handler: (message: unknown) => void): void {
    this.handler = handler
  }
  onDisconnect(handler: (reason?: string) => void): void {
    this.dropped = handler
  }
  private end(reason?: string): void {
    if (this.closed) return
    this.closed = true
    this.subscription?.close()
    this.buffer = ''
    this.dropped(reason)
  }
  /** Release the runtime session and reject outstanding commands. */
  async disconnect(): Promise<void> {
    if (this.closed) return
    this.end()
    if (this.kind === 'serial') await this.serial!.close(this.session)
    else await this.ble!.close(this.session)
  }
}
