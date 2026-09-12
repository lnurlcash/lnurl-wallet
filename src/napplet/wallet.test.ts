import {beforeEach, describe, expect, it, vi, type Mock} from 'vitest'
import {Vault} from './vault'
import {Wallet, requireIssuerUrl} from './wallet'
import {parseWalletIntent, listenWalletIntents} from './intents'
import {DEFAULT_DESIGN, parseDesign} from './design'
import {fetchServiceResponse} from '../serviceTransport'
import {
  fetchNoteInfo,
  rotateNoteWithHash,
  splitNoteWithHash,
  meltNote
} from '../lnurlcash'
import type {Note} from './vault'

vi.mock('../lnurlcash', async original => ({
  ...(await original<typeof import('../lnurlcash')>()),
  fetchNoteInfo: vi.fn(),
  rotateNoteWithHash: vi.fn(),
  splitNoteWithHash: vi.fn(),
  meltNote: vi.fn()
}))

const password = 'a sufficiently long test password'
const noteUrl = `https://mint.example/withdraw?k1=${'ab'.repeat(32)}&amount=21000`
let data: Map<string, string>
let vault: Vault
let wallet: Wallet
let storage: {
  getItem: Mock<(key: string) => Promise<string | null>>
  setItem: Mock<(key: string, value: string) => Promise<void>>
  keys: Mock<() => Promise<string[]>>
}
const held = (): Note => ({
  id: crypto.randomUUID(),
  url: noteUrl,
  amount: 21000,
  status: 'ready',
  reason: 'fixture',
  updatedAt: Date.now()
})

beforeEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  data = new Map()
  storage = {
    getItem: vi.fn(async (key: string) => data.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      data.set(key, value)
    }),
    keys: vi.fn(async () => [...data.keys()])
  }
  vault = new Vault(storage)
  wallet = new Wallet(vault)
  await vault.create(password)
  vi.mocked(fetchNoteInfo).mockResolvedValue({
    tag: 'withdrawRequest',
    callback: 'https://mint.example/cb',
    k1: 'ab'.repeat(32),
    maxWithdrawable: 21000,
    minWithdrawable: 0,
    mintPubkey: '02' + 'aa'.repeat(32)
  })
  vi.mocked(rotateNoteWithHash).mockResolvedValue({signature: 'ab'.repeat(65)})
  vi.mocked(meltNote).mockResolvedValue({})
})

describe('encrypted shell vault', () => {
  it('keeps bearer URLs, passwords and artwork out of plaintext storage', async () => {
    await vault.save(held())
    await vault.saveDesign('default', DEFAULT_DESIGN)
    const raw = [...data.values()].join('')
    expect(raw).not.toContain('ab'.repeat(32))
    expect(raw).not.toContain(password)
    expect(raw).not.toContain(DEFAULT_DESIGN.title)
    vault.lock()
    await expect(vault.notes()).rejects.toThrow('Unlock')
    await expect(vault.unlock('wrong')).rejects.toThrow()
    await vault.unlock(password)
    expect((await vault.notes())[0].url).toBe(noteUrl)
  })

  it('restores encrypted notes and art under a different password without duplicates', async () => {
    await vault.save(held())
    await vault.saveDesign('default', DEFAULT_DESIGN)
    const backup = await vault.backup()
    data.clear()
    vault = new Vault(storage)
    await vault.create('another long test password')
    expect(await vault.restore(backup, password)).toBe(1)
    expect(await vault.restore(backup, password)).toBe(0)
    const [note] = await vault.notes()
    expect(note.status).toBe('unverified')
    expect((await vault.designs())[note.designId!]).toEqual(DEFAULT_DESIGN)
  })

  it('validates the whole backup before importing any notes', async () => {
    await vault.save(held())
    const backup = JSON.parse(await vault.backup())
    backup.notes.bad = {iv: 'aa'.repeat(12), ciphertext: 'bb'.repeat(50)}
    storage.setItem.mockClear()
    await expect(
      vault.restore(JSON.stringify(backup), password)
    ).rejects.toThrow()
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('refuses to replace an existing wallet key', async () => {
    const before = await vault.backup()
    await expect(vault.create(password)).rejects.toThrow('already exists')
    expect(await vault.backup()).toBe(before)
  })
})

describe('durable bearer operations', () => {
  it('persists the replacement before rotation and keeps both candidates after timeout', async () => {
    const note = held()
    await vault.save(note)
    vi.mocked(rotateNoteWithHash).mockImplementation(async () => {
      expect(await vault.notes()).toHaveLength(2)
      expect((await vault.notes()).every(n => n.status === 'pending')).toBe(
        true
      )
      throw new Error('timeout')
    })
    await expect(wallet.transform([note.id], 'rotate')).rejects.toThrow(
      'timeout'
    )
    vault.lock()
    await vault.unlock(password)
    expect(new Set((await vault.notes()).map(n => n.url)).size).toBe(2)
    expect(rotateNoteWithHash).toHaveBeenCalledTimes(1)
  })

  it('does not call the mint mutation when shell persistence fails', async () => {
    const note = held()
    await vault.save(note)
    storage.setItem.mockRejectedValueOnce(new Error('quota'))
    await expect(wallet.transform([note.id], 'rotate')).rejects.toThrow('quota')
    expect(rotateNoteWithHash).not.toHaveBeenCalled()
  })

  it('does not submit a second mutation from an unresolved source', async () => {
    const note = {...held(), status: 'pending' as const}
    await vault.save(note)
    await expect(wallet.transform([note.id], 'rotate')).rejects.toThrow(
      'unresolved'
    )
    expect(rotateNoteWithHash).not.toHaveBeenCalled()
  })

  it('rejects foreign callbacks before revealing secrets', async () => {
    const note = held()
    await vault.save(note)
    vi.mocked(fetchNoteInfo).mockResolvedValue({
      ...(await fetchNoteInfo(note.url)),
      callback: 'https://evil.example/cb'
    })
    await expect(wallet.transform([note.id], 'rotate')).rejects.toThrow(
      'outside'
    )
    expect(rotateNoteWithHash).not.toHaveBeenCalled()
    expect(() => requireIssuerUrl('http://mint.example/cb', noteUrl)).toThrow()
  })

  it('rejects duplicate selections and invalid split amounts', async () => {
    const note = held()
    await vault.save(note)
    await expect(
      wallet.transform([note.id, note.id], 'combine')
    ).rejects.toThrow('Select')
    await expect(wallet.transform([note.id], 'split', 21001)).rejects.toThrow(
      'smaller'
    )
    expect(splitNoteWithHash).not.toHaveBeenCalled()
  })

  it('requires exact invoice value and treats submission as pending', async () => {
    const note = held()
    await vault.save(note)
    await expect(wallet.pay(note.id, 'lnbc220n1qqqq')).rejects.toThrow(
      'must match'
    )
    expect(meltNote).not.toHaveBeenCalled()
    await wallet.pay(note.id, 'lnbc210n1qqqq')
    expect((await vault.notes())[0].status).toBe('pending')
  })
})

describe('untrusted intents and designs', () => {
  it('only stages stable conventions and rejects malformed payloads', () => {
    expect(
      parseWalletIntent('napplet:wallet/receive', {note: noteUrl}, 'sender')
        .action
    ).toBe('receive')
    for (const payload of [
      null,
      [],
      {invoice: 'lnurl1xyz'},
      {invoice: 'x'.repeat(16001)}
    ]) {
      expect(() =>
        parseWalletIntent('napplet:wallet/pay', payload, 'sender')
      ).toThrow()
    }
    expect(() =>
      parseWalletIntent('napplet:wallet/pay?invoice=x', {}, 'sender')
    ).toThrow()
    expect(fetchNoteInfo).not.toHaveBeenCalled()
  })

  it('closes all INC subscriptions and accepts missing optional INC', () => {
    const close = vi.fn()
    const on = vi.fn(() => ({close}))
    const disconnect = listenWalletIntents(
      {storage, resource: {bytes: vi.fn()}, inc: {on}},
      vi.fn(),
      vi.fn()
    )
    expect(on).toHaveBeenCalledTimes(4)
    disconnect()
    expect(close).toHaveBeenCalledTimes(4)
    expect(() =>
      listenWalletIntents(
        {storage, resource: {bytes: vi.fn()}},
        vi.fn(),
        vi.fn()
      )()
    ).not.toThrow()
  })

  it('rejects remote tracking images, SVG, CSS injection and oversized artwork', () => {
    expect(parseDesign(DEFAULT_DESIGN)).toEqual(DEFAULT_DESIGN)
    for (const image of [
      'https://tracker.example/pixel',
      'data:image/svg+xml;base64,AAAA',
      'x'.repeat(180001)
    ]) {
      expect(() => parseDesign({...DEFAULT_DESIGN, image})).toThrow()
    }
    expect(() =>
      parseDesign({...DEFAULT_DESIGN, paper: 'url(https://evil.example)'})
    ).toThrow()
  })
})

describe('shell network boundary', () => {
  it('uses unique resource URLs for protocol GETs, never direct fetch', async () => {
    vi.stubEnv('MODE', 'napplet')
    const bytes = vi.fn(async (_url: string) => new Blob(['{"status":"OK"}']))
    const direct = vi.fn()
    vi.stubGlobal('fetch', direct)
    vi.stubGlobal('window', {napplet: {resource: {bytes}}})
    await fetchServiceResponse(noteUrl, AbortSignal.timeout(1000))
    await fetchServiceResponse(noteUrl, AbortSignal.timeout(1000))
    expect(bytes.mock.calls[0][0]).not.toBe(bytes.mock.calls[1][0])
    expect(direct).not.toHaveBeenCalled()
    await expect(
      fetchServiceResponse('http://mint.example', AbortSignal.timeout(1000))
    ).rejects.toThrow('HTTPS')
  })
})
