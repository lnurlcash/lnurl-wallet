import {describe, expect, it} from 'vitest'
import {
  toBech32Lnurl,
  fromBech32Lnurl,
  isBech32Lnurl,
  fromLud17,
  toLud17w,
  resolveLnurlInput,
  isLightningAddress,
  resolveMintInput,
  resolveNoteInput,
  isValidNoteInput,
  noteK1,
  noteDeclaredAmount,
  noteSignature,
  buildNoteUrl,
  withNewK1,
  serverOf,
  serviceOriginOf,
  noteEndpointOf,
  mintAddressUrl,
  lightningAddressUsername,
  isAllowedServiceUrl
} from './urls'

const K1 = 'a'.repeat(64)
const NOTE_URL = `https://mint.example.com/withdraw?k1=${K1}&amount=21000`

describe('LUD-01 bech32', () => {
  it('round-trips a note URL', () => {
    const lnurl = toBech32Lnurl(NOTE_URL)
    expect(lnurl.startsWith('LNURL1')).toBe(true)
    expect(isBech32Lnurl(lnurl)).toBe(true)
    expect(fromBech32Lnurl(lnurl)).toBe(NOTE_URL)
    expect(fromBech32Lnurl(`  ${lnurl.toLowerCase()}  `)).toBe(NOTE_URL)
  })

  it('rejects malformed input', () => {
    expect(fromBech32Lnurl('LNURL1notbech32!!!')).toBeNull()
    expect(fromBech32Lnurl('https://x')).toBeNull()
  })
})

describe('LUD-17 schemes', () => {
  it('converts lnurlw:// to fetchable https and back', () => {
    expect(
      fromLud17(`lnurlw://mint.example.com/withdraw?k1=${K1}&amount=21000`)
    ).toBe(NOTE_URL)
    expect(toLud17w(NOTE_URL)).toBe(
      `lnurlw://mint.example.com/withdraw?k1=${K1}&amount=21000`
    )
  })

  it('resolves insecure hosts to http', () => {
    expect(fromLud17('lnurlw://localhost:8000/withdraw')).toBe(
      'http://localhost:8000/withdraw'
    )
  })
})

describe('service URL policy', () => {
  it('admits https anywhere, http only for the insecure hosts', () => {
    expect(isAllowedServiceUrl('https://mint.example.com/w')).toBe(true)
    expect(isAllowedServiceUrl('http://localhost:8000/w')).toBe(true)
    expect(isAllowedServiceUrl('http://127.0.0.1/w')).toBe(true)
    expect(isAllowedServiceUrl('http://someservice.onion/w')).toBe(true)
    expect(isAllowedServiceUrl('http://mint.example.com/w')).toBe(false)
    // userinfo tricks: the hostname is what matters
    expect(isAllowedServiceUrl('http://evil.com@localhost/w')).toBe(true)
    expect(isAllowedServiceUrl('http://localhost@evil.com/w')).toBe(false)
    expect(isAllowedServiceUrl('data:application/json,{}')).toBe(false)
    expect(isAllowedServiceUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedServiceUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedServiceUrl('not a url')).toBe(false)
  })

  it('pins signing identity to the full SERVICE origin', () => {
    expect(serviceOriginOf('https://mint.example.com/w')).toBe(
      'https://mint.example.com'
    )
    expect(serviceOriginOf('http://localhost:8000/w')).toBe(
      'http://localhost:8000'
    )
    expect(serviceOriginOf('https://localhost:8000/w')).toBe(
      'https://localhost:8000'
    )
    expect(serviceOriginOf('mint.example.com')).toBe('https://mint.example.com')
    expect(serviceOriginOf('ftp://mint.example.com/w')).toBe('')
  })
})

describe('input resolution', () => {
  it('resolves bech32, scheme, address and plain URLs', () => {
    expect(resolveLnurlInput(toBech32Lnurl(NOTE_URL))).toBe(NOTE_URL)
    expect(
      resolveLnurlInput(
        `lnurlw://mint.example.com/withdraw?k1=${K1}&amount=21000`
      )
    ).toBe(NOTE_URL)
    expect(resolveLnurlInput('mint@mint.example.com')).toBe(
      'https://mint.example.com/.well-known/lnurlp/mint'
    )
    expect(resolveLnurlInput(NOTE_URL)).toBe(NOTE_URL)
    expect(resolveLnurlInput('nonsense')).toBeNull()
    // wallets hand LNURLs over behind the scheme (LUD-01); only the
    // clipboard path stripped it, so a scanned one was rejected
    expect(resolveLnurlInput(`lightning:${toBech32Lnurl(NOTE_URL)}`)).toBe(
      NOTE_URL
    )
    expect(resolveLnurlInput(`LIGHTNING:${toBech32Lnurl(NOTE_URL)}`)).toBe(
      NOTE_URL
    )
  })

  it('only accepts a note when a k1 is present', () => {
    expect(resolveNoteInput(toBech32Lnurl(NOTE_URL))).toBe(NOTE_URL)
    expect(resolveNoteInput(`lightning:${toBech32Lnurl(NOTE_URL)}`)).toBe(
      NOTE_URL
    )
    expect(resolveNoteInput('https://mint.example.com/withdraw')).toBeNull()
    expect(isValidNoteInput(NOTE_URL)).toBe(true)
    expect(isValidNoteInput('you@example.com')).toBe(false)
  })

  it('only accepts a note when its k1 is well-formed 32-byte hex', () => {
    // a non-hex k1 would crash sha256-based hashing later (offline signature
    // verification during render), so it's rejected at the door
    expect(
      resolveNoteInput('https://mint.example.com/withdraw?k1=zz')
    ).toBeNull()
    expect(
      resolveNoteInput(`https://mint.example.com/withdraw?k1=${'a'.repeat(63)}`)
    ).toBeNull()
    expect(
      isValidNoteInput(
        `https://mint.example.com/withdraw?k1=${K1.toUpperCase()}`
      )
    ).toBe(true)
  })

  it('normalizes k1 case - it is bytes, not text', () => {
    expect(noteK1(`https://mint.example.com/w?k1=${K1.toUpperCase()}`)).toBe(K1)
  })

  it('resolves insecure dev hosts to http, ports included', () => {
    expect(resolveMintInput('localhost:8000')).toBe(
      'http://localhost:8000/.well-known/lnurlp/mint'
    )
    expect(resolveMintInput('mint@127.0.0.1:8000')).toBe(
      'http://127.0.0.1:8000/.well-known/lnurlp/mint'
    )
  })

  it('resolves a dot-less dev host with a local-part - the mint picker builds one', () => {
    // Mint.tsx's quick-select prepends "mint@" to a stored server, so this
    // is the exact string clicking a trusted mint produces. It used to come
    // back null: the domain has no dot, so it was not a Lightning Address,
    // and it has an "@", so it was not a bare mint domain either. A mint
    // trusted at localhost could be typed and not clicked.
    //
    // 127.0.0.1 is why the case above never caught it - it has dots.
    expect(resolveMintInput('mint@localhost:8111')).toBe(
      'http://localhost:8111/.well-known/lnurlp/mint'
    )
    expect(resolveMintInput('mint@localhost')).toBe(
      'http://localhost/.well-known/lnurlp/mint'
    )
    // every server the picker can hold, run through the same "mint@" it
    // prepends, so none of them can regress into being unclickable
    for (const server of [
      'localhost:8111',
      '127.0.0.1:8111',
      '0.0.0.0:8111',
      'mint.example.com'
    ]) {
      expect(resolveMintInput(`mint@${server}`)).not.toBeNull()
    }
  })

  it('does not accept a dot-less domain that is not a dev host', () => {
    // the whole point of requiring a dot: a name with none cannot resolve on
    // the public internet, and an https fetch at it would go nowhere. Only
    // the hosts this wallet is allowed to reach over http are exempt.
    expect(isLightningAddress('mint@intranet')).toBe(false)
    expect(resolveMintInput('mint@intranet')).toBeNull()
    expect(isLightningAddress('mint@localhost')).toBe(true)
    // ...and the shape rules still hold
    expect(isLightningAddress('mint@')).toBe(false)
    expect(isLightningAddress('@mint.example.com')).toBe(false)
    expect(isLightningAddress('a@b@mint.example.com')).toBe(false)
    expect(isLightningAddress('mint mint@mint.example.com')).toBe(false)
    expect(isLightningAddress('mint@mint.example.com')).toBe(true)
  })

  it('rejects non-https URLs and clearnet http, even bech32-encoded', () => {
    // a data: URL would otherwise answer its own informational GET - a
    // self-contained fake "verified" note
    const fake = `data:application/json,{"tag":"withdrawRequest"}?k1=${K1}`
    expect(resolveLnurlInput(toBech32Lnurl(fake))).toBeNull()
    expect(resolveNoteInput(toBech32Lnurl(fake))).toBeNull()
    expect(resolveMintInput(toBech32Lnurl(fake))).toBeNull()
    // cleartext http is for the deliberate insecure dev hosts only
    expect(
      resolveLnurlInput(`http://mint.example.com/withdraw?k1=${K1}`)
    ).toBeNull()
    expect(
      resolveLnurlInput(
        toBech32Lnurl(`http://mint.example.com/withdraw?k1=${K1}`)
      )
    ).toBeNull()
    expect(resolveLnurlInput(`http://localhost:8000/withdraw?k1=${K1}`)).toBe(
      `http://localhost:8000/withdraw?k1=${K1}`
    )
    expect(
      resolveLnurlInput(
        toBech32Lnurl(`http://localhost:8000/withdraw?k1=${K1}`)
      )
    ).toBe(`http://localhost:8000/withdraw?k1=${K1}`)
    // a LUD-17 authority that only prefix-matches an insecure host must not
    // downgrade: localhost:80@evil.com's real host is evil.com
    expect(
      resolveLnurlInput(`lnurlw://localhost:80@evil.com/withdraw?k1=${K1}`)
    ).toBeNull()
    expect(
      resolveLnurlInput(toBech32Lnurl(`file:///etc/passwd?k1=${K1}`))
    ).toBeNull()
  })

  it('mirrors a resolved payRequest URL onto its withdraw-side mint address', () => {
    // derived from the resolved URL's own path, not the raw input - works
    // identically whether that URL came from a Lightning Address...
    expect(mintAddressUrl(resolveLnurlInput('mint@mint.example.com')!)).toBe(
      'https://mint.example.com/.well-known/lnurlw/mint'
    )
    // ...or a bare URL that already happens to follow the same convention
    expect(
      mintAddressUrl('https://mint.example.com/.well-known/lnurlp/mint')
    ).toBe('https://mint.example.com/.well-known/lnurlw/mint')
    // only a URL at that conventional path has an "other side" to mirror
    expect(mintAddressUrl(NOTE_URL)).toBeNull()
    expect(mintAddressUrl('https://mint.example.com/pay')).toBeNull()
    expect(mintAddressUrl('nonsense')).toBeNull()
  })

  it('extracts a payRequest URL username, cacheable onto TrustedMint', () => {
    expect(
      lightningAddressUsername(resolveLnurlInput('mint@mint.example.com')!)
    ).toBe('mint')
    expect(
      lightningAddressUsername(
        'https://mint.example.com/.well-known/lnurlp/mint'
      )
    ).toBe('mint')
    expect(lightningAddressUsername(NOTE_URL)).toBeNull()
    expect(lightningAddressUsername('nonsense')).toBeNull()
  })

  it('resolves a bare mint domain to the default mint@<domain> address', () => {
    // literally bare...
    expect(resolveMintInput('mint.example.com')).toBe(
      'https://mint.example.com/.well-known/lnurlp/mint'
    )
    // ...or with the leading "@" some mints display their own address as
    // (see PUBLIC_MINTS) - both are shorthand for the same address
    expect(resolveMintInput('@mint.example.com')).toBe(
      'https://mint.example.com/.well-known/lnurlp/mint'
    )
    // an actual Lightning Address still takes precedence - not reinterpreted
    // as a bare domain missing its "@"
    expect(resolveMintInput('mint@mint.example.com')).toBe(
      'https://mint.example.com/.well-known/lnurlp/mint'
    )
    // a scheme or path disqualifies it as "bare" - resolveMintInput has no
    // guess for those, same as before this existed
    expect(resolveMintInput('https://mint.example.com')).toBeNull()
    expect(resolveMintInput('mint.example.com/p')).toBeNull()
    expect(resolveMintInput('nonsense')).toBeNull()
  })
})

describe('note helpers', () => {
  it('extracts k1, declared amount, sig and host', () => {
    expect(noteK1(NOTE_URL)).toBe(K1)
    expect(noteK1('https://mint.example.com/withdraw')).toBeNull()
    expect(noteDeclaredAmount(NOTE_URL)).toBe(21000)
    expect(
      noteDeclaredAmount('https://mint.example.com/withdraw?k1=x')
    ).toBeNull()
    expect(noteSignature(NOTE_URL)).toBeNull()
    expect(serverOf(NOTE_URL)).toBe('mint.example.com')
  })

  it('keeps the path when naming the endpoint a note is rebuilt from', () => {
    // LUD-25: "lnurlw://mint.example/w?k1=<P>&amount=<msat> *is* the bearer
    // note". Drop the /w and there is nothing left to GET. serverOf is for
    // display and does drop it, which is why these are separate functions.
    expect(noteEndpointOf('lnurlw://mint.example/w')).toBe('mint.example/w')
    expect(noteEndpointOf('https://mint.example/w')).toBe('mint.example/w')
    expect(noteEndpointOf(NOTE_URL)).toBe('mint.example.com/withdraw')
    expect(noteEndpointOf('lnurlw://localhost:8000/w')).toBe('localhost:8000/w')
    // a deeper path is not special-cased away either
    expect(noteEndpointOf('https://mint.example/lnurl/w')).toBe(
      'mint.example/lnurl/w'
    )
    // a root endpoint contributes no segment, so the note is host?k1=...
    expect(noteEndpointOf('https://mint.example/')).toBe('mint.example')
    expect(noteEndpointOf('https://mint.example')).toBe('mint.example')
    // and it is never the bare host for a path-bearing endpoint
    expect(noteEndpointOf('https://mint.example/w')).not.toBe('mint.example')
  })

  it('builds a note from withdrawLink + preimage + amount', () => {
    expect(buildNoteUrl('https://mint.example.com/withdraw', K1, 21000)).toBe(
      NOTE_URL
    )
    expect(
      buildNoteUrl(
        'lnurlw://mint.example.com/withdraw',
        K1.toUpperCase(),
        21000
      )
    ).toBe(NOTE_URL)
  })

  it('omits amount entirely when the value is not yet known', () => {
    // claiming a preimage that arrived from outside this wallet, with no
    // invoice request of our own to read a value from - some services
    // validate a declared amount strictly, so a placeholder like 0 risks
    // rejection where an absent param is simply ignored
    const url = buildNoteUrl('https://mint.example.com/withdraw', K1)
    expect(noteDeclaredAmount(url)).toBeNull()
    expect(new URL(url).searchParams.has('amount')).toBe(false)
  })

  it('swaps k1/amount and sets or clears sig after rotate/split/merge', () => {
    const newK1 = 'b'.repeat(64)
    const rotated = withNewK1(NOTE_URL, newK1, 15000)
    expect(noteK1(rotated)).toBe(newK1)
    expect(noteDeclaredAmount(rotated)).toBe(15000)
    expect(noteSignature(rotated)).toBeNull()

    const signed = withNewK1(NOTE_URL, newK1, 15000, 'deadbeef')
    expect(noteSignature(signed)).toBe('deadbeef')
    // rotating again without a signature drops the stale one
    const reRotated = withNewK1(signed, 'c'.repeat(64), 15000)
    expect(noteSignature(reRotated)).toBeNull()
  })
})
