import {afterEach, describe, expect, it, vi} from 'vitest'
import {secp256k1} from '@noble/curves/secp256k1.js'
import {bytesToHex} from '@noble/hashes/utils.js'
import {
  canPayInternally,
  payInternalTransfer,
  sendNoteInternally,
  type InternalTransferPayee
} from './internalTransfer'
import {encodeCs1WithAmount} from './recoverableNotes'
import {AmbiguousMutationError} from './errors'

const SIG = encodeCs1WithAmount(1000, new Uint8Array(65).fill(0x01))
const SIG2 = encodeCs1WithAmount(1000, new Uint8Array(65).fill(0x02))
const MINT_PUBKEY = bytesToHex(
  secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)
)
const CALLBACK = 'https://mint.example/w/cb'
const WITHDRAW = 'https://mint.example/w'
const PAYEE: InternalTransferPayee = {
  callback: 'https://mint.example/lnurlp/alice/cb',
  withdrawLink: 'lnurlw://mint.example/w',
  minSendable: 1000,
  maxSendable: 1_000_000
}

afterEach(() => vi.unstubAllGlobals())

const json = (body: unknown) => ({json: async () => body}) as Response
const ok = () => json({status: 'OK'})
const lookup = (maxWithdrawable: number) =>
  json({
    tag: 'withdrawRequest',
    callback: CALLBACK,
    minWithdrawable: 1000,
    maxWithdrawable,
    mintPubkey: MINT_PUBKEY
  })

// answers by endpoint: the payee's callback, the note lookup (?p=) or the
// notes' own callback (split/merge)
const stubMint = (opts: {
  mutation?: () => Response
  value?: number
  send?: () => Response
}) => {
  const requests: URL[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = new URL(input.toString())
      requests.push(url)
      if (url.href.startsWith(PAYEE.callback)) return (opts.send ?? ok)()
      if (url.searchParams.has('p')) return lookup(opts.value ?? 0)
      return (opts.mutation ?? (() => json({status: 'OK', c: SIG})))()
    })
  )
  return requests
}

describe('canPayInternally', () => {
  it("is true only for an address whose withdrawLink is on the note's domain", () => {
    expect(canPayInternally(PAYEE, 'lnurlw://mint.example/w?k1=x')).toBe(true)
    expect(canPayInternally(PAYEE, 'https://Mint.Example:8443/w/cb')).toBe(true)
    expect(canPayInternally(PAYEE, 'https://other.example/w')).toBe(false)
    expect(
      canPayInternally({...PAYEE, withdrawLink: undefined}, CALLBACK)
    ).toBe(false)
    // the mint's own payRequest (a comment names the note) is no address
    expect(canPayInternally({...PAYEE, commentAllowed: 64}, CALLBACK)).toBe(
      false
    )
  })
})

describe('sendNoteInternally', () => {
  it("sends the whole note as amount and k1 to the payee's callback", async () => {
    const requests = stubMint({})
    await sendNoteInternally(PAYEE, CALLBACK, 'secretA', 21000)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.searchParams.get('amount')).toBe('21000')
    expect(requests[0]!.searchParams.get('k1')).toBe('secretA')
  })

  it("refuses another mint's address, or an amount it does not accept, before sending", async () => {
    const requests = stubMint({})
    await expect(
      sendNoteInternally(PAYEE, 'https://other.example/w/cb', 'secretA', 21000)
    ).rejects.toThrow(/not at the note's mint/)
    await expect(
      sendNoteInternally(PAYEE, CALLBACK, 'secretA', 999)
    ).rejects.toThrow(/outside/)
    expect(requests).toHaveLength(0)
  })

  it("surfaces the SERVICE's refusal", async () => {
    stubMint({send: () => json({status: 'ERROR', reason: 'already in use'})})
    await expect(
      sendNoteInternally(PAYEE, CALLBACK, 'secretA', 21000)
    ).rejects.toThrow()
  })
})

describe('payInternalTransfer', () => {
  it('sends a single note worth the amount as is', async () => {
    const requests = stubMint({})
    const result = await payInternalTransfer(
      PAYEE,
      WITHDRAW,
      CALLBACK,
      ['secretA'],
      21000,
      21000
    )
    expect(result).toEqual({paidMsat: 21000})
    expect(requests).toHaveLength(1)
    expect(requests[0]!.searchParams.get('k1')).toBe('secretA')
  })

  it('merges several notes into a fresh own note, then sends it at its value', async () => {
    const requests = stubMint({value: 21500})
    const result = await payInternalTransfer(
      PAYEE,
      WITHDRAW,
      CALLBACK,
      ['secretA', 'secretB'],
      21000,
      21000
    )
    const [merge, info, send] = requests
    expect(merge!.searchParams.getAll('k1')).toEqual(['secretA', 'secretB'])
    expect(merge!.searchParams.has('amount')).toBe(false)
    expect(info!.searchParams.get('p')).toBe(merge!.searchParams.get('p1'))
    expect(send!.searchParams.get('amount')).toBe('21500')
    expect(send!.searchParams.get('k1')).not.toMatch(/^secret/)
    expect(result).toEqual({paidMsat: 21500})
  })

  it('splits off the amount, keeps the change, and sends the split note', async () => {
    const requests = stubMint({
      mutation: () => json({status: 'OK', c: SIG, c2: SIG2}),
      value: 5000
    })
    const result = await payInternalTransfer(
      PAYEE,
      WITHDRAW,
      CALLBACK,
      ['secretA'],
      5000,
      21000
    )
    const [split, info, send] = requests
    expect(split!.searchParams.get('amount')).toBe('5000')
    expect(info!.searchParams.get('p')).toBe(split!.searchParams.get('p1'))
    expect(send!.searchParams.get('amount')).toBe('5000')
    expect(result.paidMsat).toBe(5000)
    expect(result.change).toBeDefined()
    expect(result.change).not.toBe(send!.searchParams.get('k1'))
    expect(result.changeSignature).toBe(SIG2)
  })

  it('carries both new notes out when sending after the split fails', async () => {
    stubMint({
      mutation: () => json({status: 'OK', c: SIG, c2: SIG2}),
      value: 5000,
      send: () => json({status: 'ERROR', reason: 'already in use'})
    })
    const err = await payInternalTransfer(
      PAYEE,
      WITHDRAW,
      CALLBACK,
      ['secretA'],
      5000,
      21000
    ).catch(e => e)
    expect(err).toBeInstanceOf(AmbiguousMutationError)
    expect((err as AmbiguousMutationError).newSecrets).toHaveLength(2)
  })

  it("refuses more than the inputs are worth, or another mint's address, without a request", async () => {
    const requests = stubMint({})
    await expect(
      payInternalTransfer(PAYEE, WITHDRAW, CALLBACK, ['secretA'], 21001, 21000)
    ).rejects.toThrow(/more than/)
    await expect(
      payInternalTransfer(
        PAYEE,
        'https://other.example/w',
        'https://other.example/w/cb',
        ['secretA'],
        21000,
        21000
      )
    ).rejects.toThrow(/not at the note's mint/)
    expect(requests).toHaveLength(0)
  })
})
