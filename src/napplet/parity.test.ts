import {beforeEach, afterEach, describe, it, expect, vi} from 'vitest'
import {bech32} from '@scure/base'
import {hexToBytes} from '@noble/hashes/utils.js'
import {Vault} from './vault'
import type {Note, CashState} from './vault'
import {Wallet} from './wallet'
import {exportWebBackup, importWebBackup} from './backup'
import {observeMint, reviewMintKey, importPins, signedNote} from './mints'
import {setNappletOffline, parsePreferences} from './preferences'
import {fetchServiceResponse} from '../serviceTransport'
import {
  deriveLud25CashRootNode,
  deriveBearerAesKey,
  deriveWalletLinkingKey,
  encryptRecord
} from '../keys'
import {cashSecretFromRoot} from '../cashSecrets'
import {
  fetchPayRequest,
  fetchNoteInfo,
  fetchInvoiceVerification,
  requestInvoice,
  meltNote,
  hashK1,
  NoteUnknownError,
  buildNoteUrl,
  rotateNoteWithHash,
  noteK1
} from '../lnurlcash'

vi.mock('../lnurlcash', async original => ({
  ...(await original<typeof import('../lnurlcash')>()),
  fetchPayRequest: vi.fn(),
  fetchNoteInfo: vi.fn(),
  fetchInvoiceVerification: vi.fn(),
  requestInvoice: vi.fn(),
  meltNote: vi.fn(),
  rotateNoteWithHash: vi.fn()
}))

const phrase =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const password = 'a sufficiently long password'
const origin = 'https://mint.example'
const k1 = 'ab'.repeat(32),
  pubkey = '02' + 'aa'.repeat(32)
const create = async (seed?: string, restored = false) => {
  const records = new Map<string, string>()
  const storage = {
    getItem: vi.fn(async (key: string) => records.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      records.set(key, value)
    }),
    keys: async () => [...records.keys()]
  }
  const vault = new Vault(storage)
  await vault.create(password, seed, restored)
  return {vault, records, storage, wallet: new Wallet(vault)}
}
const note = (extra: Partial<Note> = {}): Note => ({
  id: crypto.randomUUID(),
  url: buildNoteUrl(origin + '/w', k1, 21000),
  amount: 21000,
  status: 'ready',
  reason: 'fixture',
  updatedAt: Date.now(),
  ...extra
})
const invoice = (preimage = k1): string => {
  const words = bech32.toWords(hexToBytes(hashK1(preimage)))
  return bech32.encode(
    'lnbc210n',
    [
      ...new Array(7).fill(0),
      1,
      Math.floor(words.length / 32),
      words.length % 32,
      ...words,
      ...new Array(104).fill(0)
    ],
    2048
  )
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(fetchPayRequest).mockResolvedValue({
    tag: 'payRequest',
    callback: origin + '/pay/cb',
    withdrawLink: origin + '/w',
    minSendable: 1000,
    maxSendable: 1000000,
    metadata: '[]',
    commentAllowed: 64,
    mintPubkey: pubkey
  })
  vi.mocked(fetchNoteInfo).mockResolvedValue({
    tag: 'withdrawRequest',
    callback: origin + '/w/cb',
    k1,
    minWithdrawable: 21000,
    maxWithdrawable: 21000,
    mintPubkey: pubkey
  })
  vi.mocked(requestInvoice).mockResolvedValue({
    pr: invoice(),
    disposable: false,
    mintToHash: true
  })
  vi.mocked(meltNote).mockResolvedValue({})
  vi.mocked(rotateNoteWithHash).mockResolvedValue({signature: 'aa'.repeat(65)})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  setNappletOffline(false)
})

describe('webwallet-compatible seed and backups', () => {
  it('derives the original per-mint cash secret and advances only durable counters', async () => {
    const {vault, storage, records} = await create(phrase)
    const expected = cashSecretFromRoot(
      deriveLud25CashRootNode(phrase),
      'mint.example',
      0
    )
    expect(await vault.nextSecret('mint.example')).toBe(expected)
    storage.setItem.mockRejectedValueOnce(new Error('quota'))
    await expect(vault.nextSecret('mint.example')).rejects.toThrow('quota')
    expect((await vault.meta<CashState>('cash'))?.indices['mint.example']).toBe(
      1
    )
    expect(await vault.nextSecret('mint.example')).toBe(
      cashSecretFromRoot(deriveLud25CashRootNode(phrase), 'mint.example', 1)
    )
    expect([...records.values()].join('')).not.toContain(phrase)
    expect([...records.values()].join('')).not.toContain(expected)
  })

  it('requires scanning restored seeds and aborts gaps on network uncertainty', async () => {
    const {vault, wallet} = await create(phrase, true)
    await expect(vault.nextSecret('mint.example')).rejects.toThrow('Scan')
    vi.mocked(fetchNoteInfo).mockRejectedValueOnce(new Error('network failure'))
    await expect(
      wallet.recover(origin + '/pay', () => {}, new AbortController().signal)
    ).rejects.toThrow('network')
    await expect(vault.nextSecret('mint.example')).rejects.toThrow('Scan')
    vi.mocked(fetchNoteInfo).mockRejectedValue(new NoteUnknownError('unknown'))
    vi.mocked(fetchNoteInfo).mockResolvedValueOnce({
      tag: 'withdrawRequest',
      callback: origin + '/w/cb',
      k1,
      minWithdrawable: 21000,
      maxWithdrawable: 21000,
      mintPubkey: pubkey
    })
    expect(
      await wallet.recover(
        origin + '/pay',
        () => {},
        new AbortController().signal
      )
    ).toBe(1)
    expect(noteK1((await vault.notes())[0].url)).toBe(
      cashSecretFromRoot(deriveLud25CashRootNode(phrase), 'mint.example', 0)
    )
    expect((await vault.meta<CashState>('cash'))?.indices['mint.example']).toBe(
      21
    )
    await expect(vault.nextSecret('mint.example')).resolves.toHaveLength(64)
  })

  it('resets a forgotten password only after authenticating the correct seed', async () => {
    const {vault, storage} = await create(phrase)
    await vault.save(note())
    vault.lock()
    storage.setItem.mockClear()
    await expect(
      vault.resetPassword(
        'legal winner thank year wave sausage worth useful legal winner thank yellow',
        'new password long enough'
      )
    ).rejects.toThrow()
    expect(storage.setItem).not.toHaveBeenCalled()
    await vault.resetPassword(phrase, 'new password long enough')
    vault.lock()
    await expect(vault.unlock(password)).rejects.toThrow()
    await vault.unlock('new password long enough')
    expect(await vault.notes()).toHaveLength(1)
  })

  it('roundtrips original encrypted bearers, counters and unconfirmed pins without replacing the destination seed', async () => {
    const source = await create(phrase),
      target = await create()
    await source.vault.save(note())
    await source.vault.nextSecret('mint.example')
    await observeMint(source.vault, origin, pubkey)
    const backup = await exportWebBackup(source.vault, password)
    const keyBefore = target.records.get('lnurlcash-napplet:key:v1')
    expect(await importWebBackup(target.vault, backup, password)).toEqual({
      added: 1,
      deviceMirrors: 0
    })
    expect(await importWebBackup(target.vault, backup, password)).toEqual({
      added: 0,
      deviceMirrors: 0
    })
    expect(target.records.get('lnurlcash-napplet:key:v1')).toBe(keyBefore)
    expect((await target.vault.notes())[0].status).toBe('unverified')
    expect(
      (await target.vault.meta<CashState>('cash'))?.indices['mint.example']
    ).toBe(1)
    expect(await target.vault.meta('mints')).toMatchObject([{confirmed: false}])
  })

  it('supports seed-only legacy backups and skips hardware mirrors', async () => {
    const {vault} = await create()
    const key = await deriveBearerAesKey(deriveWalletLinkingKey(phrase))
    const bearer = {
      url: note().url,
      amount: 21000,
      callback: origin + '/w/cb',
      verified: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    const data = {
      type: 'lnurlwallet-backup',
      version: 1,
      bearers: [
        {id: 'one', ...(await encryptRecord(key, bearer))},
        {
          id: 'two',
          ...(await encryptRecord(key, {...bearer, deviceId: 'deadbeef'}))
        }
      ]
    }
    expect(
      await importWebBackup(vault, JSON.stringify(data), '', phrase)
    ).toEqual({added: 1, deviceMirrors: 1})
  })

  it('rejects a corrupt later record before writing any imported note or key', async () => {
    const source = await create(phrase),
      target = await create()
    await source.vault.save(note())
    const data = JSON.parse(await exportWebBackup(source.vault, password))
    data.bearers.push({id: 'bad', iv: '00', ciphertext: '00'})
    target.storage.setItem.mockClear()
    await expect(
      importWebBackup(target.vault, JSON.stringify(data), password)
    ).rejects.toThrow()
    expect(target.storage.setItem).not.toHaveBeenCalled()
  })

  it('retains payment quarantine and merges encrypted action history in full backups', async () => {
    const source = await create(phrase),
      target = await create(phrase)
    await source.vault.save(
      note({
        status: 'pending',
        invoiceType: 'payment',
        invoice: invoice(),
        verifyUrl: origin + '/verify'
      })
    )
    await source.wallet.log('payment', 'Requested payment')
    await source.vault.nextSecret('mint.example')
    await target.vault.nextSecret('mint.example')
    await target.vault.nextSecret('mint.example')
    await target.vault.restore(await source.vault.backup(), password)
    expect((await target.vault.notes())[0].status).toBe('pending')
    expect(await target.vault.meta('history')).toMatchObject([
      {message: 'Requested payment'}
    ])
    expect(
      (await target.vault.meta<CashState>('cash'))?.indices['mint.example']
    ).toBe(2)
  })
})

describe('payment evidence and issuer trust', () => {
  it('never marks a mismatched invoice or false preimage as settled', async () => {
    const {vault, wallet} = await create()
    const pending = note({
      status: 'pending',
      invoice: invoice(),
      invoiceType: 'payment',
      verifyUrl: origin + '/verify'
    })
    await vault.save(pending)
    vi.mocked(fetchInvoiceVerification).mockResolvedValue({
      settled: true,
      pr: invoice('cd'.repeat(32)),
      preimage: k1
    })
    await expect(wallet.settlement(pending.id)).rejects.toThrow(
      'another invoice'
    )
    vi.mocked(fetchInvoiceVerification).mockResolvedValue({
      settled: true,
      pr: invoice(),
      preimage: 'cd'.repeat(32)
    })
    await expect(wallet.settlement(pending.id)).rejects.toThrow(
      'valid payment preimage'
    )
    expect((await vault.notes())[0].status).toBe('pending')
    vi.mocked(fetchInvoiceVerification).mockResolvedValue({
      settled: true,
      pr: invoice(),
      preimage: k1
    })
    expect(await wallet.settlement(pending.id)).toBe(true)
    expect((await vault.notes())[0]).toMatchObject({status: 'spent', proof: k1})
  })

  it('retains unknown pending outputs and requires explicit resolution of pending payments', async () => {
    const {vault, wallet} = await create()
    const pending = note({status: 'pending'})
    await vault.save(pending)
    vi.mocked(fetchNoteInfo).mockRejectedValue(new NoteUnknownError('unknown'))
    await wallet.refresh(pending.id)
    expect((await vault.notes())[0].status).toBe('pending')
    await vault.save({...pending, invoiceType: 'payment', invoice: invoice()})
    await expect(wallet.refresh(pending.id)).rejects.toThrow(
      'Verify this payment'
    )
  })

  it('keeps changed signing keys pending and does not trust backup pins', async () => {
    const {vault} = await create()
    await importPins(vault, [{origin, key: pubkey, confirmed: true}])
    expect(signedNote(note(), (await vault.meta('mints')) ?? [])).toBe(false)
    await observeMint(vault, origin, pubkey)
    await observeMint(vault, origin, '03' + 'bb'.repeat(32))
    expect(await vault.meta('mints')).toMatchObject([
      {key: pubkey, confirmed: true, pending: '03' + 'bb'.repeat(32)}
    ])
    await reviewMintKey(vault, origin, true)
    expect(await vault.meta('mints')).toMatchObject([
      {key: '03' + 'bb'.repeat(32), confirmed: true}
    ])
  })

  it('enforces offline mode before touching the shell resource API', async () => {
    vi.stubEnv('MODE', 'napplet')
    const bytes = vi.fn()
    vi.stubGlobal('window', {napplet: {resource: {bytes}}})
    setNappletOffline(true)
    await expect(
      fetchServiceResponse(origin, AbortSignal.timeout(100))
    ).rejects.toThrow('Offline mode')
    expect(bytes).not.toHaveBeenCalled()
    expect(() => parsePreferences({autoLock: -1})).toThrow()
  })

  it('persists both sides before submitting a transfer and refuses callbacks outside the issuer', async () => {
    const {vault, wallet} = await create(phrase)
    const source = note({
      url: buildNoteUrl('https://source.example/w', k1, 21000)
    })
    await vault.save(source)
    vi.mocked(fetchNoteInfo).mockResolvedValue({
      tag: 'withdrawRequest',
      callback: 'https://source.example/w/cb',
      k1,
      minWithdrawable: 21000,
      maxWithdrawable: 21000,
      mintPubkey: pubkey
    })
    vi.mocked(meltNote).mockImplementation(async () => {
      expect(
        (await vault.notes()).filter(note => note.status === 'pending')
      ).toHaveLength(2)
      throw new Error('connection lost')
    })
    await expect(wallet.transfer(source.id, origin + '/pay')).rejects.toThrow(
      'connection lost'
    )
    expect(await vault.notes()).toHaveLength(2)
    const wrong = await create()
    await wrong.vault.save(note())
    await expect(
      wrong.wallet.pay((await wrong.vault.notes())[0].id, invoice())
    ).rejects.toThrow('outside its HTTPS origin')
  })

  it('requests an address invoice without spending and rejects a changed amount', async () => {
    const {wallet, vault} = await create()
    expect(await wallet.paymentInvoice(origin + '/pay', 21000)).toBe(invoice())
    expect(meltNote).not.toHaveBeenCalled()
    expect(await vault.meta('payment-addresses')).toEqual([origin + '/pay'])
    await expect(wallet.paymentInvoice(origin + '/pay', 22000)).rejects.toThrow(
      'different amount'
    )
  })
})
