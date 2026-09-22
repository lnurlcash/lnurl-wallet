import {describe, expect, it} from 'vitest'
import {schnorr} from '@noble/curves/secp256k1.js'
import {hexToBytes} from '@noble/hashes/utils.js'
import {
  dealerSetup,
  dkgRound1,
  dkgRound2,
  dkgRound3,
  frostAggregate,
  frostCommit,
  frostSignShare,
  frostVerifyShare,
  groupIdentifier,
  utf8MessageHex,
  type DealerResult,
  type DkgFinalResult
} from './frost'

// runs the staged signing round (commit -> signShare -> verifyShare ->
// aggregate) for an ARBITRARY subset of participants - the actual point
// of FROST over the sibling musig2 addon: this never has to be every
// participant in the group.
const stageASignature = (
  publicBlob: string,
  shareBlobsByIdNumber: Record<number, string>,
  messageHex: string
) => {
  const idNumbers = Object.keys(shareBlobsByIdNumber).map(Number)
  const nonces = idNumbers.map(n => frostCommit(shareBlobsByIdNumber[n]!))
  const commitmentBlobs = nonces.map(n => n.commitmentBlob)
  const shares = idNumbers.map((n, i) =>
    frostSignShare(
      shareBlobsByIdNumber[n]!,
      publicBlob,
      nonces[i]!.nonceBlob,
      commitmentBlobs,
      messageHex
    )
  )
  idNumbers.forEach((n, i) => {
    expect(
      frostVerifyShare(publicBlob, commitmentBlobs, messageHex, n, shares[i]!)
    ).toBe(true)
  })
  return frostAggregate(
    publicBlob,
    commitmentBlobs,
    messageHex,
    idNumbers,
    shares
  )
}

describe('dealerSetup', () => {
  it('rejects a threshold greater than the group size, non-positive values, or a threshold of 1', () => {
    expect(() => dealerSetup(3, 2)).toThrow(/threshold/)
    expect(() => dealerSetup(0, 3)).toThrow()
    expect(() => dealerSetup(2, 0)).toThrow()
    expect(() => dealerSetup(1, 3)).toThrow(/threshold of 1/)
  })

  it('produces a real group pubkey and one share per participant', () => {
    const deal = dealerSetup(2, 3)
    expect(deal.groupPubkeyHex).toMatch(/^[0-9a-f]{64}$/)
    expect(deal.shareBlobs).toHaveLength(3)
    expect(deal.min).toBe(2)
    expect(deal.max).toBe(3)
  })

  it('two calls produce two different groups (fresh randomness each time)', () => {
    const a = dealerSetup(2, 3)
    const b = dealerSetup(2, 3)
    expect(a.groupPubkeyHex).not.toBe(b.groupPubkeyHex)
  })
})

describe('trusted-dealer threshold signing', () => {
  const deal: DealerResult = dealerSetup(2, 3)
  const messageHex = utf8MessageHex('a real threshold signature')

  it('any 2 of the 3 shares can sign - genuinely a THRESHOLD, not everyone', () => {
    // participants 1 and 2 sign; participant 3 never participates at all
    const shareBlobsByIdNumber = {
      1: deal.shareBlobs[0]!,
      2: deal.shareBlobs[1]!
    }
    const result = stageASignature(
      deal.publicBlob,
      shareBlobsByIdNumber,
      messageHex
    )
    expect(result.groupPubkeyHex).toBe(deal.groupPubkeyHex)
    expect(result.verified).toBe(true)
    // the CENTRAL claim: verifies as an ORDINARY BIP340 signature, no
    // FROST-specific verification logic needed downstream
    expect(
      schnorr.verify(
        hexToBytes(result.finalSigHex),
        hexToBytes(messageHex),
        hexToBytes(result.groupPubkeyHex)
      )
    ).toBe(true)
  })

  it('a DIFFERENT pair of the 3 shares also signs correctly - not tied to one fixed subset', () => {
    const shareBlobsByIdNumber = {
      1: deal.shareBlobs[0]!,
      3: deal.shareBlobs[2]!
    }
    const result = stageASignature(
      deal.publicBlob,
      shareBlobsByIdNumber,
      messageHex
    )
    expect(result.verified).toBe(true)
  })

  it('refuses to aggregate with mismatched identity/share array lengths', () => {
    expect(() =>
      frostAggregate(deal.publicBlob, [], messageHex, [1, 2], ['aa'])
    ).toThrow(/matching identity/)
  })
})

describe('DKG - no trusted dealer, nobody ever holds the full group secret', () => {
  it('all 3 participants independently derive the SAME group pubkey, then any 2 sign', () => {
    const signers = {min: 2, max: 3}
    const r1 = [1, 2, 3].map(n => dkgRound1(n, signers.min, signers.max))

    // round2: each participant's OWN broadcast, filtered to "others"
    const r2 = r1.map((r, i) =>
      dkgRound2(
        r.secretBlob,
        r1.filter((_, j) => j !== i).map(o => o.broadcastBlob)
      )
    )

    // round3: finalize - uses round2's own UPDATED secret state (not
    // round1's original - round2 advances it), plus, for each OTHER
    // participant's own round2 output, whichever ONE package they
    // addressed to THIS identifier specifically (never the packages meant
    // for anyone else)
    const finals: DkgFinalResult[] = r2.map((mine, i) => {
      const myId = groupIdentifier(i + 1)
      const round2ForMe = r2
        .filter((_, senderIdx) => senderIdx !== i)
        .map(sent => sent.packageBlobs[sent.recipientIds.indexOf(myId)]!)
      return dkgRound3(
        mine.secretBlob,
        r1.filter((_, j) => j !== i).map(o => o.broadcastBlob),
        round2ForMe
      )
    })

    const groupPubkeys = new Set(finals.map(f => f.groupPubkeyHex))
    expect(groupPubkeys.size).toBe(1)
    expect([...groupPubkeys][0]).toMatch(/^[0-9a-f]{64}$/)

    // sign with participants 1 and 3 (DKG-derived shares), participant 2
    // never participates. keyBlob is toBlob({public, secret}) - the
    // public/secret sub-blobs frostCommit/frostSignShare/frostAggregate
    // each expect are just JSON.stringify of the matching sub-object,
    // already in the same toJsonSafe-encoded form throughout
    const key1 = JSON.parse(finals[0]!.keyBlob)
    const key3 = JSON.parse(finals[2]!.keyBlob)
    const publicBlob = JSON.stringify(key1.public)
    const shareBlobsByIdNumber = {
      1: JSON.stringify(key1.secret),
      3: JSON.stringify(key3.secret)
    }
    const messageHex = utf8MessageHex('real DKG, real threshold signature')
    const result = stageASignature(publicBlob, shareBlobsByIdNumber, messageHex)
    expect(result.groupPubkeyHex).toBe([...groupPubkeys][0])
    expect(result.verified).toBe(true)
  })

  it('rejects an invalid threshold at round1', () => {
    expect(() => dkgRound1(1, 3, 2)).toThrow(/threshold/)
  })
})
