import {describe, it, expect, vi, afterEach} from 'vitest'
import {bytesToHex} from '@noble/hashes/utils.js'
import {ed25519} from '@noble/curves/ed25519.js'
import type {ble, serial} from '@napplet/sdk'
import {DeviceClient, encodeBleFrames} from '../device'
import type {DeviceTransport} from '../device'
import {identityMessage} from '../devicePinning'
import {
  enqueuePendingDeviceOp,
  readPendingDeviceOps,
  useMediatedDeviceQueue
} from '../deviceQueue'
import {NappletDeviceTransport, VAULT_TX, VAULT_RX} from './device-transport'
import {HardwareWallet} from './hardware'
import {Vault} from './vault'
import {Wallet} from './wallet'

afterEach(() => {
  useMediatedDeviceQueue(null)
  vi.unstubAllGlobals()
})

describe('runtime device adapters', () => {
  it('reassembles fragmented serial JSON and ignores messages from other sessions', async () => {
    let emit: (
      event: Parameters<Parameters<typeof serial.onEvent>[0]>[0]
    ) => void = () => {}
    const api = {
      open: vi.fn(async () => ({session: {id: 'session', state: 'open'}})),
      close: vi.fn(async () => {}),
      onEvent: vi.fn(handler => {
        emit = handler
        return {close: vi.fn()}
      }),
      write: vi.fn(async (_id, bytes) => {
        expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({
          cmd: 'get_info'
        })
        const response = new TextEncoder().encode(
          JSON.stringify({
            ok: true,
            fw_version: 'fixture',
            storage: 'ok',
            note_count: 0,
            pending_count: 0
          }) + '\n'
        )
        emit({type: 'data', sessionId: 'wrong', data: [123, 10]})
        emit({
          type: 'data',
          sessionId: 'session',
          data: [...response.slice(0, 11)]
        })
        emit({
          type: 'data',
          sessionId: 'session',
          data: [...response.slice(11)]
        })
      })
    } as unknown as typeof serial
    const transport = await NappletDeviceTransport.open('serial', {serial: api})
    const client = new DeviceClient(transport)
    expect(await client.getInfo()).toMatchObject({
      fw_version: 'fixture',
      storage: 'ok'
    })
    await client.disconnect()
    expect(api.close).toHaveBeenCalledWith('session')
    await expect(transport.send({cmd: 'get_info'})).rejects.toThrow(
      'disconnected'
    )
  })

  it('uses the actual vault GATT identifiers and upstream BLE framing', async () => {
    let emit: (
      event: Parameters<Parameters<typeof ble.onEvent>[0]>[0]
    ) => void = () => {}
    const api = {
      open: vi.fn(async () => ({session: {id: 'ble-session', state: 'open'}})),
      subscribe: vi.fn(async () => {}),
      write: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      onEvent: vi.fn(handler => {
        emit = handler
        return {close: vi.fn()}
      })
    } as unknown as typeof ble
    const transport = await NappletDeviceTransport.open('ble', {ble: api})
    const received = vi.fn()
    transport.onMessage(received)
    await transport.send({cmd: 'list_notes'})
    expect(api.subscribe).toHaveBeenCalledWith('ble-session', VAULT_TX)
    expect(api.write).toHaveBeenCalledWith(
      'ble-session',
      VAULT_RX,
      [...encodeBleFrames({cmd: 'list_notes'})[0]],
      {response: 'with-response'}
    )
    const answer = {ok: true, notes: []}
    for (const frame of encodeBleFrames(answer))
      emit({
        type: 'notification',
        sessionId: 'ble-session',
        target: VAULT_TX,
        data: [...frame]
      })
    expect(received).toHaveBeenCalledWith(answer)
    await transport.disconnect()
  })

  it('does not acknowledge a queued commit when encrypted storage fails', async () => {
    vi.stubGlobal('navigator', {
      locks: {
        request: () => {
          throw new Error('Opaque origin cannot use Web Locks')
        }
      }
    })
    const save = vi.fn(async () => {
      throw new Error('quota')
    })
    useMediatedDeviceQueue({entries: [], save})
    await expect(
      enqueuePendingDeviceOp({outputs: [], burnDeviceIds: ['deadbeef']})
    ).rejects.toThrow('quota')
    expect(readPendingDeviceOps()).toEqual([])
  })

  it('serializes concurrent encrypted queue writes without browser locks', async () => {
    vi.stubGlobal('navigator', {
      locks: {
        request: () => {
          throw new Error('Opaque origin cannot use Web Locks')
        }
      }
    })
    const save = vi.fn(async () => {
      await Promise.resolve()
    })
    useMediatedDeviceQueue({entries: [], save})
    await Promise.all(
      ['aaaaaaaa', 'bbbbbbbb'].map(id =>
        enqueuePendingDeviceOp({outputs: [], burnDeviceIds: [id]})
      )
    )
    expect(readPendingDeviceOps()).toHaveLength(2)
    expect(save).toHaveBeenCalledTimes(2)
  })
})

const fakeDevice = (
  privateKey: Uint8Array,
  forged = false
): DeviceTransport => {
  let message: (value: unknown) => void = () => {}
  return {
    kind: 'serial',
    onMessage: handler => {
      message = handler
    },
    onDisconnect: () => {},
    disconnect: vi.fn(async () => {}),
    send: vi.fn(async (command: any) => {
      if (command.cmd === 'get_info')
        message({
          ok: true,
          storage: 'ok',
          note_count: 0,
          pending_count: 0,
          fw_version: 'test'
        })
      else if (command.cmd === 'identify')
        message({
          ok: true,
          pubkey: bytesToHex(ed25519.getPublicKey(privateKey)),
          sig: bytesToHex(
            ed25519.sign(
              identityMessage(forged ? '00'.repeat(32) : command.nonce),
              privateKey
            )
          )
        })
      else if (command.cmd === 'list_notes')
        message({ok: true, notes: [], total: 0, offset: 0})
      else message({ok: true})
    })
  }
}

describe('device identity isolation', () => {
  it('requires holder review for a new identity and never replays another device queue', async () => {
    const records = new Map<string, string>()
    const vault = new Vault({
      getItem: async key => records.get(key) ?? null,
      setItem: async (key, value) => {
        records.set(key, value)
      },
      keys: async () => [...records.keys()]
    })
    await vault.create('a sufficiently long password')
    const hardware = new HardwareWallet(vault, new Wallet(vault))
    const first = fakeDevice(new Uint8Array(32).fill(1))
    expect((await hardware.connect(first)).changed).toBe(true)
    await expect(hardware.notes()).rejects.toThrow('Review and accept')
    await hardware.acceptIdentity()
    await enqueuePendingDeviceOp({outputs: [], burnDeviceIds: ['deadbeef']})
    const second = fakeDevice(new Uint8Array(32).fill(2))
    expect((await hardware.connect(second)).changed).toBe(true)
    await hardware.acceptIdentity()
    expect(second.send).not.toHaveBeenCalledWith({
      cmd: 'mark_spent',
      id: 'deadbeef'
    })
    expect(readPendingDeviceOps()).toEqual([])
    await hardware.disconnect()
    const returning = fakeDevice(new Uint8Array(32).fill(1))
    await hardware.connect(returning)
    await hardware.acceptIdentity()
    expect(returning.send).toHaveBeenCalledWith({
      cmd: 'mark_spent',
      id: 'deadbeef'
    })
    await hardware.disconnect()
  })

  it('rejects a replayed challenge response before pinning or listing notes', async () => {
    const records = new Map<string, string>()
    const vault = new Vault({
      getItem: async key => records.get(key) ?? null,
      setItem: async (key, value) => {
        records.set(key, value)
      },
      keys: async () => [...records.keys()]
    })
    await vault.create('a sufficiently long password')
    const hardware = new HardwareWallet(vault, new Wallet(vault)),
      device = fakeDevice(new Uint8Array(32).fill(1), true)
    await expect(hardware.connect(device)).rejects.toThrow('prove its identity')
    expect(await vault.meta('device-identity')).toBeNull()
    expect(device.disconnect).toHaveBeenCalled()
  })
})
