import {describe, expect, it} from 'vitest'
import {schnorr, secp256k1} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, concatBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {bech32m} from '@scure/base'
import {
  encodeCr1WithAmount,
  encodeCs1WithAmount
} from '../../lib/recoverableNotes'
import {
  decodeSealConsignment,
  encodeSealConsignment,
  genesisState,
  nextState,
  planSealLock,
  sealCertificateProblem,
  type SealCertificate,
  type SealState
} from './seals'

const AMOUNT_MSAT = 20_000_000
const LOCKED = {
  urlTemplate: 'https://mint.example.com/w',
  amountMsat: AMOUNT_MSAT
}

const ownerKey = (): string =>
  bytesToHex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()))

const mintKeypair = () => {
  const priv = secp256k1.utils.randomSecretKey()
  return {priv, pub: bytesToHex(secp256k1.getPublicKey(priv, true))}
}

// what a mint answers a rotate with (lnurl-mint's signing.sign_rotation):
// its signmessage-style signature that `spent` was burned into `note`
const certifyRotation = (
  priv: Uint8Array,
  spent: string,
  note: string,
  amountMsat: number
): string => {
  const digest = sha256(
    sha256(
      new Uint8Array([
        ...utf8ToBytes('Lightning Signed Message:'),
        ...utf8ToBytes(`LNURLcash:rotate:${amountMsat}:${spent}:${note}`)
      ])
    )
  )
  const sig = secp256k1.sign(digest, priv, {
    format: 'recovered',
    prehash: false
  })
  return encodeCr1WithAmount(
    amountMsat,
    new Uint8Array([...sig.subarray(1), sig[0]!])
  )
}

const keyOf = (state: SealState): string => planSealLock(state).outputKeyHex

// a history of `transfers` transitions, and the certificate an honest mint
// issued for each one
const history = (transfers: number, mintPriv: Uint8Array) => {
  const states = [genesisState('Art #1', 'a description', ownerKey())]
  const certificates: SealCertificate[] = []
  for (let i = 1; i <= transfers; i++) {
    const next = nextState(states[i - 1]!, ownerKey())
    certificates.push({
      stateIndex: i,
      cr1: certifyRotation(
        mintPriv,
        keyOf(states[i - 1]!),
        keyOf(next),
        AMOUNT_MSAT
      )
    })
    states.push(next)
  }
  return {states, certificates}
}

// the length-prefixed parts after a consignment's header, and a consignment
// rebuilt from parts - for hand-making shapes the encoder itself refuses
const partsOf = (consignment: string) => {
  const bytes = bech32m.fromWords(
    bech32m.decode(consignment as `${string}1${string}`, false).words
  )
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const headerEnd = 8 + 2 + view.getUint16(8, false)
  const parts: Uint8Array[] = []
  let offset = headerEnd
  while (offset < bytes.length) {
    const length = view.getUint16(offset, false)
    parts.push(bytes.slice(offset + 2, offset + 2 + length))
    offset += 2 + length
  }
  return {header: bytes.slice(0, headerEnd), parts}
}

const withParts = (header: Uint8Array, parts: Uint8Array[]): string =>
  bech32m.encode(
    'seal',
    bech32m.toWords(
      concatBytes(
        header,
        ...parts.map(part =>
          concatBytes(
            Uint8Array.of((part.length >> 8) & 0xff, part.length & 0xff),
            part
          )
        )
      )
    ),
    false
  )

describe('seal consignment: certificates', () => {
  const mint = mintKeypair()

  it('a consignment without certificates is byte-for-byte what it always was', () => {
    const {states} = history(2, mint.priv)
    const plain = encodeSealConsignment(LOCKED, states)
    expect(encodeSealConsignment(LOCKED, states, [])).toBe(plain)
    expect(encodeSealConsignment(LOCKED, states, undefined)).toBe(plain)
    // exactly the states, nothing after them
    expect(partsOf(plain!).parts).toHaveLength(3)
    expect(decodeSealConsignment(plain)!.certificates).toEqual([])
  })

  it('encodes and decodes what the encoder before certificates wrote', () => {
    // these two strings came out of seals.ts as it was before certificates
    // existed (lnurl-wallet ed95b16), for exactly these states - so "byte
    // for byte what it was" is checked against the old bytes themselves,
    // not against this encoder's own output
    const pk = (fill: number): string =>
      bytesToHex(schnorr.getPublicKey(new Uint8Array(32).fill(fill)))
    expect([pk(1), pk(2), pk(3)]).toEqual([
      '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f',
      '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766',
      '531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337'
    ])
    const genesis: SealState = {
      assetId: '11'.repeat(32),
      name: 'Art #1',
      description: 'one of one',
      stateIndex: 0,
      ownerPubkeyHex: pk(1),
      prevStateHash: ''
    }
    const first = nextState(genesis, pk(2))
    const second = nextState(first, pk(3))
    const one =
      'seal1qqqqqqqpxyksqqq6dp68gurn8ghj7mtfde6zuetcv9khqmr99e3k7mf0wuqg7nzw24fyccmpwd5z7um9v9kz7um5v96x2tmkxqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zqqxg9e8ggprxyqq5mmwv5sx7e3qdahx2qqqqqqphpx92ea3yezqn9wna4d2hgzkt4c7rq6xqjqel7wp0a0f6hws0rcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqm7lqmc'
    const three =
      'seal1qqqqqqqpxyksqqq6dp68gurn8ghj7mtfde6zuetcv9khqmr99e3k7mf0wuqg7nzw24fyccmpwd5z7um9v9kz7um5v96x2tmkxqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zqqxg9e8ggprxyqq5mmwv5sx7e3qdahx2qqqqqqphpx92ea3yezqn9wna4d2hgzkt4c7rq6xqjqel7wp0a0f6hws0rcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqg7nzw24fyccmpwd5z7um9v9kz7um5v96x2tmkxqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zqqxg9e8ggprxyqq5mmwv5sx7e3qdahx2qqqqqq56jmv6ympqvk2n0f2awweqz4y63weatvq4j2zxd6vg5d8y4xswenytyyyt8w4gk5k30c0fq8wvhc4hkk3hedkg99rxd5d7g8j0vzlwvqg7nzw24fyccmpwd5z7um9v9kz7um5v96x2tmkxqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zqqxg9e8ggprxyqq5mmwv5sx7e3qdahx2qqqqqp9x8lxq6qng5payu33xv38epn6eraxeq79xl56gnput0daev07xdlsw0dvxr7zwwc02a0yaec94gtfepw5ulyjtexu3kxgaeh49hrn454jhngd'
    expect(encodeSealConsignment(LOCKED, [genesis])).toBe(one)
    expect(encodeSealConsignment(LOCKED, [genesis, first, second])).toBe(three)
    expect(decodeSealConsignment(one)).toEqual({
      ...LOCKED,
      states: [genesis],
      certificates: []
    })
    expect(decodeSealConsignment(three)!.states).toEqual([
      genesis,
      first,
      second
    ])
  })

  it('round-trips one certificate per transition', () => {
    const {states, certificates} = history(3, mint.priv)
    const consignment = encodeSealConsignment(LOCKED, states, certificates)
    const parsed = decodeSealConsignment(consignment)!
    expect(parsed.states).toEqual(states)
    expect(parsed.certificates).toEqual(certificates)
    expect(parsed.amountMsat).toBe(AMOUNT_MSAT)
  })

  it('carries them in whatever order they were handed in', () => {
    const {states, certificates} = history(3, mint.priv)
    const reversed = [...certificates].reverse()
    const parsed = decodeSealConsignment(
      encodeSealConsignment(LOCKED, states, reversed)
    )!
    expect(parsed.certificates).toEqual(reversed)
    expect(sealCertificateProblem(parsed, mint.pub)).toBe('')
  })

  it('carries a partly certified history as it is', () => {
    const {states, certificates} = history(3, mint.priv)
    const parsed = decodeSealConsignment(
      encodeSealConsignment(LOCKED, states, [certificates[2]!])
    )!
    expect(parsed.certificates).toEqual([certificates[2]])
  })

  it('refuses to encode a certificate that is not a cr1 for its own amount', () => {
    const {states, certificates} = history(1, mint.priv)
    const bad = (cr1: unknown) =>
      encodeSealConsignment(LOCKED, states, [{stateIndex: 1, cr1}])
    expect(bad('nope')).toBeNull()
    expect(bad(undefined)).toBeNull()
    expect(bad(encodeCs1WithAmount(AMOUNT_MSAT, new Uint8Array(65)))).toBeNull()
    expect(
      bad(encodeCr1WithAmount(AMOUNT_MSAT + 1000, new Uint8Array(65)))
    ).toBeNull()
    // the real one, for comparison
    expect(bad(certificates[0]!.cr1)).not.toBeNull()
  })

  it('refuses to encode a certificate for a transition the history lacks, or two for one', () => {
    const {states, certificates} = history(2, mint.priv)
    const cr1 = certificates[0]!.cr1
    const withIndex = (stateIndex: number) =>
      encodeSealConsignment(LOCKED, states, [{stateIndex, cr1}])
    expect(withIndex(0)).toBeNull() // genesis has no transition into it
    expect(withIndex(3)).toBeNull() // past the last state
    expect(withIndex(-1)).toBeNull()
    expect(withIndex(1.5)).toBeNull()
    expect(
      encodeSealConsignment(LOCKED, states, [certificates[0], certificates[0]])
    ).toBeNull()
  })

  it('refuses to decode a state after a certificate, a repeated one, or one out of range', () => {
    const {states, certificates} = history(2, mint.priv)
    const {header, parts} = partsOf(
      encodeSealConsignment(LOCKED, states, certificates)!
    )
    const [genesis, first, second, cert1, cert2] = parts as [
      Uint8Array,
      Uint8Array,
      Uint8Array,
      Uint8Array,
      Uint8Array
    ]
    // the honest order decodes
    expect(decodeSealConsignment(withParts(header, parts))).not.toBeNull()
    expect(
      decodeSealConsignment(
        withParts(header, [genesis, first, cert1, second, cert2])
      )
    ).toBeNull()
    expect(
      decodeSealConsignment(
        withParts(header, [genesis, first, second, cert1, cert1])
      )
    ).toBeNull()
    // certificate 2 with only two states: it names a state that isn't there
    expect(
      decodeSealConsignment(withParts(header, [genesis, first, cert1, cert2]))
    ).toBeNull()
    // a certificate cut short is neither a certificate nor a state
    expect(
      decodeSealConsignment(
        withParts(header, [genesis, first, second, cert1.slice(0, -1)])
      )
    ).toBeNull()
    // certificates alone are no consignment
    expect(decodeSealConsignment(withParts(header, [cert1]))).toBeNull()
  })
})

describe('sealCertificateProblem', () => {
  const mint = mintKeypair()
  const consignmentOf = (
    states: SealState[],
    certificates: SealCertificate[]
  ): string => encodeSealConsignment(LOCKED, states, certificates)!

  it('accepts a history whose every transition the mint certified', () => {
    const {states, certificates} = history(3, mint.priv)
    const consignment = consignmentOf(states, certificates)
    expect(sealCertificateProblem(consignment, mint.pub)).toBe('')
    // a parsed consignment works as well as its string
    expect(
      sealCertificateProblem(decodeSealConsignment(consignment), mint.pub)
    ).toBe('')
    expect(
      sealCertificateProblem(consignment, ` ${mint.pub.toUpperCase()} `)
    ).toBe('')
  })

  it('has nothing to certify in a seal that was never transferred', () => {
    const {states} = history(0, mint.priv)
    expect(sealCertificateProblem(consignmentOf(states, []), mint.pub)).toBe('')
  })

  it('names the first transition without a certificate', () => {
    const {states, certificates} = history(3, mint.priv)
    expect(sealCertificateProblem(consignmentOf(states, []), mint.pub)).toMatch(
      /State 1: the mint did not certify/
    )
    expect(
      sealCertificateProblem(
        consignmentOf(states, [certificates[0]!, certificates[2]!]),
        mint.pub
      )
    ).toMatch(/State 2: the mint did not certify/)
  })

  it('rejects certificates another key signed', () => {
    const {states, certificates} = history(2, mint.priv)
    expect(
      sealCertificateProblem(
        consignmentOf(states, certificates),
        mintKeypair().pub
      )
    ).toMatch(/State 1: its certificate is not this mint/)
  })

  it('rejects a look-alike: a made-up next state on a note of its own', () => {
    // whoever knows a state can lock any note to a state that follows it;
    // the chain checks out, but the mint never burned the real note into it
    const {states, certificates} = history(2, mint.priv)
    const forged = nextState(states[1]!, ownerKey())
    const lookAlike = [states[0]!, states[1]!, forged]
    expect(
      sealCertificateProblem(consignmentOf(lookAlike, certificates), mint.pub)
    ).toMatch(/State 2: its certificate is not this mint/)
    // and without the real step's certificate there is none at all
    expect(
      sealCertificateProblem(
        consignmentOf(lookAlike, [certificates[0]!]),
        mint.pub
      )
    ).toMatch(/State 2: the mint did not certify/)
  })

  it('rejects a fork: only one note was ever certified as the next one', () => {
    // an owner who also locked a note to a SECOND next state has, at best,
    // the mint's certificate for the first - and it does not fit the second
    const {states, certificates} = history(1, mint.priv)
    const fork = nextState(states[0]!, ownerKey())
    expect(keyOf(fork)).not.toBe(keyOf(states[1]!))
    expect(
      sealCertificateProblem(
        consignmentOf([states[0]!, fork], certificates),
        mint.pub
      )
    ).toMatch(/State 1: its certificate is not this mint/)
  })

  it('rejects certificates swapped between transitions', () => {
    const {states, certificates} = history(2, mint.priv)
    const swapped = [
      {stateIndex: 1, cr1: certificates[1]!.cr1},
      {stateIndex: 2, cr1: certificates[0]!.cr1}
    ]
    expect(
      sealCertificateProblem(consignmentOf(states, swapped), mint.pub)
    ).toMatch(/State 1: its certificate is not this mint/)
  })

  it('rejects a history certified for another amount', () => {
    const {states, certificates} = history(1, mint.priv)
    const parsed = decodeSealConsignment(consignmentOf(states, certificates))!
    expect(
      sealCertificateProblem({...parsed, amountMsat: AMOUNT_MSAT + 1}, mint.pub)
    ).toMatch(/State 1: its certificate is not this mint/)
  })

  it('reports a broken chain before it looks at any certificate', () => {
    const {states, certificates} = history(2, mint.priv)
    const parsed = decodeSealConsignment(consignmentOf(states, certificates))!
    const drifted = [
      parsed.states[0]!,
      {...parsed.states[1]!, name: 'Art #2'},
      parsed.states[2]!
    ]
    expect(
      sealCertificateProblem({...parsed, states: drifted}, mint.pub)
    ).toMatch(/name\/description changed/)
  })

  it('needs the mint key, and a consignment, to say anything', () => {
    const {states, certificates} = history(1, mint.priv)
    const consignment = consignmentOf(states, certificates)
    expect(sealCertificateProblem(consignment, '')).toMatch(/signing key/)
    expect(sealCertificateProblem(consignment, 'ab'.repeat(32))).toMatch(
      /signing key/
    )
    expect(sealCertificateProblem(consignment, undefined)).toMatch(
      /signing key/
    )
    expect(sealCertificateProblem('nope', mint.pub)).toMatch(/consignment/)
    expect(sealCertificateProblem(null, mint.pub)).toMatch(/consignment/)
  })
})
