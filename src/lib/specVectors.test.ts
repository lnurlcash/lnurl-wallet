// Runs the published LUD-25 and LUD-26 test vectors (vectors/*-vectors.json,
// copied verbatim from lnurl/luds - refresh them from there, never by hand)
// against this package's own exported functions, never a re-implementation
// of the math: this file can only pass if the kit produces the exact bytes
// the spec publishes. If either drifts (a spec edit, a code change), this is
// where that shows up first.
import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'
import {HDKey} from '@scure/bip32'
import {secp256k1, schnorr} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {
  CASH_ROOT_PURPOSE,
  lud05PathSuffix,
  deriveServiceRoot,
  deriveNoteKey,
  deriveShareNode,
  shareCx1,
  type NotePath
} from './branchDerivation'
import {
  decodeCx1,
  deriveNotePubkey,
  encodeCp1,
  encodeCk1,
  encodeCx1,
  encodeCs1WithAmount,
  decodeCs1WithAmount,
  encodeCw1,
  outputKeyOfCw1
} from './recoverableNotes'
import {
  signNoteOwnership,
  signAddressProof,
  recoverNoteOwnershipPubkey,
  noteCertificateKind,
  verifyNoteSignature,
  verifyNoteSignatureForKey,
  verifyNoteSignatureHash
} from './signature'
import {bearerNote, keyPathSighash} from './spend'

type Hex = string
type Note = {i: number; path: string; sk: Hex; pk: Hex; Q: Hex; cp1: string}
type Share = {
  share: number
  path: string
  p: Hex
  P: Hex
  chaincode: Hex
  cx1: string
  notes: Note[]
}
type Account = {
  account: number
  wallet: {notes: Note[]}
  change: {notes: Note[]}
  shareable: Share[]
}
type Derivation = {
  seed: Hex
  domain: string
  cashHashingKey: Hex
  d: number[]
  accounts: Account[]
}
type Proof = {message: string; digest: Hex; sig: Hex}

const load = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`./vectors/${name}`, import.meta.url), 'utf8')
  )
const LUD25 = load('25-vectors.json')
const LUD26 = load('26-vectors.json') as {
  derivation: Derivation[]
  key_path_spend: Record<string, Hex>
  registration: {
    username: string
    domain: string
    cx1: string
    new_cx1: string
    register: Proof
    update: {sig: Proof; newsig: Proof}
    unregister: Proof
  }
}

const checkNote = (serviceRoot: HDKey, path: NotePath, note: Note) => {
  const key = deriveNoteKey(serviceRoot, path)
  expect(bytesToHex(key.secretKey)).toBe(note.sk)
  expect(bytesToHex(key.pubkey)).toBe(note.pk)
  expect(bytesToHex(key.outputKey)).toBe(note.Q)
  expect(encodeCp1(key.outputKey)).toBe(note.cp1)
}

const cashRootOf = (v: Derivation) =>
  HDKey.fromMasterSeed(hexToBytes(v.seed)).deriveChild(CASH_ROOT_PURPOSE)
const serviceRootOf = (v: Derivation) =>
  deriveServiceRoot(cashRootOf(v), v.domain)

describe.each(LUD26.derivation.map(v => [v.domain, v] as const))(
  'LUD-26 derivation at %s',
  (_domain, v) => {
    it("cashHashingKey (m/139'/0) and d1..d4", () => {
      const hashing = cashRootOf(v).deriveChild(0)
      expect(bytesToHex(hashing.privateKey!)).toBe(v.cashHashingKey)
      expect(lud05PathSuffix(hashing.privateKey!, v.domain)).toEqual(v.d)
    })

    it('S is the same node for any URL of the domain, port or not', () => {
      expect(
        bytesToHex(
          deriveServiceRoot(cashRootOf(v), `https://${v.domain}:8443/w`)
            .publicKey!
        )
      ).toBe(bytesToHex(serviceRootOf(v).publicKey!))
    })

    it("wallet and change notes, S/a'/0/i and S/a'/1/i", () => {
      const S = serviceRootOf(v)
      for (const a of v.accounts) {
        for (const note of a.wallet.notes) {
          checkNote(
            S,
            {chain: 'wallet', account: a.account, index: note.i},
            note
          )
        }
        for (const note of a.change.notes) {
          checkNote(
            S,
            {chain: 'change', account: a.account, index: note.i},
            note
          )
        }
      }
    })

    it("shares S/a'/2/n': p, P, chain code and cx1", () => {
      const S = serviceRootOf(v)
      for (const a of v.accounts) {
        for (const share of a.shareable) {
          const node = deriveShareNode(S, a.account, share.share)
          expect(bytesToHex(node.privateKey!)).toBe(share.p)
          expect(bytesToHex(node.publicKey!)).toBe(share.P)
          expect(bytesToHex(node.chainCode!)).toBe(share.chaincode)
          expect(encodeCx1(shareCx1(node))).toBe(share.cx1)
        }
      }
    })

    it("share notes S/a'/2/n'/i - privately, and publicly from the cx1 alone", () => {
      const S = serviceRootOf(v)
      for (const a of v.accounts) {
        for (const share of a.shareable) {
          const cx1 = decodeCx1(share.cx1)!
          for (const note of share.notes) {
            checkNote(
              S,
              {
                chain: 'share',
                account: a.account,
                share: share.share,
                index: note.i
              },
              note
            )
            expect(bytesToHex(deriveNotePubkey(cx1, note.i))).toBe(note.Q)
          }
        }
      }
    })
  }
)

describe('LUD-26 key_path_spend (odd-y wallet note)', () => {
  const v = LUD26.key_path_spend

  it('signs with the negated key and gives the published ck1', () => {
    const S = serviceRootOf(LUD26.derivation[0]!)
    const key = deriveNoteKey(S, {chain: 'wallet', account: 0, index: 0})
    expect(bytesToHex(key.secretKey)).toBe(v.sk)
    expect(bytesToHex(keyPathSighash(key.outputKey, v.domain!))).toBe(v.sighash)
    const {pubkeyXOnly, signature} = signNoteOwnership(key.secretKey, v.domain!)
    expect(bytesToHex(pubkeyXOnly)).toBe(v.Q)
    expect(bytesToHex(signature)).toBe(v.sig)
    expect(encodeCk1(pubkeyXOnly, signature)).toBe(v.ck1)
    expect(recoverNoteOwnershipPubkey(v.ck1!, v.domain!)).not.toBeNull()
    expect(recoverNoteOwnershipPubkey(v.ck1!, 'other.example')).toBeNull()
  })
})

describe('LUD-26 registration proofs', () => {
  const r = LUD26.registration
  const shares = () => {
    const S = serviceRootOf(LUD26.derivation[1]!)
    return [deriveShareNode(S, 0, 0), deriveShareNode(S, 0, 1)] as const
  }

  const check = (proof: Proof, sig: Uint8Array, signer: HDKey) => {
    expect(bytesToHex(sha256(utf8ToBytes(proof.message)))).toBe(proof.digest)
    expect(bytesToHex(sig)).toBe(proof.sig)
    expect(
      schnorr.verify(sig, hexToBytes(proof.digest), signer.publicKey!.slice(1))
    ).toBe(true)
  }

  it('the cx1s are account 0 shares 0 and 1', () => {
    const [share0, share1] = shares()
    expect(encodeCx1(shareCx1(share0))).toBe(r.cx1)
    expect(encodeCx1(shareCx1(share1))).toBe(r.new_cx1)
  })

  it('register, signed by the share key', () => {
    const [share0] = shares()
    const sig = signAddressProof(
      share0.privateKey!,
      'register',
      r.domain,
      r.username,
      r.cx1
    )
    check(r.register, sig, share0)
  })

  it('update: sig by the key on file, newsig by the new key over register', () => {
    const [share0, share1] = shares()
    const sig = signAddressProof(
      share0.privateKey!,
      'update',
      r.domain,
      r.username,
      r.new_cx1
    )
    check(r.update.sig, sig, share0)
    const newsig = signAddressProof(
      share1.privateKey!,
      'register',
      r.domain,
      r.username,
      r.new_cx1
    )
    check(r.update.newsig, newsig, share1)
  })

  it('unregister, signed by the key now on file', () => {
    const [, share1] = shares()
    const sig = signAddressProof(
      share1.privateKey!,
      'unregister',
      r.domain,
      r.username
    )
    check(r.unregister, sig, share1)
  })
})

describe('LUD-25 key_path_spend', () => {
  const v = LUD25.key_path_spend

  it('signs the canonical spend transaction sighash for its domain (all-zero aux_rand)', () => {
    expect(bytesToHex(keyPathSighash(hexToBytes(v.Q), v.domain))).toBe(
      v.sighash
    )
    const {pubkeyXOnly, signature} = signNoteOwnership(
      hexToBytes(v.sk),
      v.domain
    )
    expect(bytesToHex(pubkeyXOnly)).toBe(v.Q)
    expect(encodeCp1(pubkeyXOnly)).toBe(v.cp1)
    expect(bytesToHex(signature)).toBe(v.sig)
    expect(encodeCk1(pubkeyXOnly, signature)).toBe(v.ck1)
    expect(recoverNoteOwnershipPubkey(v.ck1, v.domain)).not.toBeNull()
    expect(recoverNoteOwnershipPubkey(v.ck1, 'cash.example.com')).toBeNull()
  })
})

type CertCase = {
  amount_msat: number
  message: string
  digest: Hex
  signature: Hex
  cs1: string
}

describe('LUD-25 certificates', () => {
  const v = LUD25.certificates

  it('mintPubkey is the SERVICE key', () => {
    expect(
      bytesToHex(secp256k1.getPublicKey(hexToBytes(v.service_sk), true))
    ).toBe(v.mintPubkey)
  })

  it.each((v.cases as CertCase[]).map(c => [c.amount_msat, c] as const))(
    'amount_msat = %i: message, digest, signature and cs1',
    (_amount, c) => {
      const {amount_msat, message, digest, signature, cs1} = c
      expect(message).toBe(`LNURLcash:${v.domain}:${amount_msat}:${v.Q}`)
      expect(
        bytesToHex(
          sha256(sha256(utf8ToBytes(`Lightning Signed Message:${message}`)))
        )
      ).toBe(digest)
      expect(encodeCs1WithAmount(amount_msat, hexToBytes(signature))).toBe(cs1)
      expect(bytesToHex(decodeCs1WithAmount(cs1)!.signature)).toBe(signature)
      const verify = (domain: string, amount: number, sig: string) =>
        verifyNoteSignatureForKey(v.Q, domain, amount, sig, v.mintPubkey)
      expect(verify(v.domain, amount_msat, cs1)).toBe(true)
      // the message binds the domain, the amount and Q, and only a cs1 is
      // a certificate
      expect(verify('other.example', amount_msat, cs1)).toBe(false)
      expect(verify(v.domain, amount_msat + 1, cs1)).toBe(false)
      expect(verify(v.domain, amount_msat, signature)).toBe(false)
    }
  )
})

describe('LUD-25 bearer_note', () => {
  const v = LUD25.bearer_note

  it('the full cw1 is the spend its preimage short form stands for', () => {
    expect(bytesToHex(sha256(hexToBytes(v.preimage)))).toBe(v.h)
    const {outputKey, controlBlock, leaf} = bearerNote(hexToBytes(v.h))
    expect(bytesToHex(leaf)).toBe(v.leaf)
    expect(bytesToHex(controlBlock)).toBe(v.control_block)
    expect(bytesToHex(outputKey)).toBe(v.Q)
    expect(encodeCp1(outputKey)).toBe(v.cp1)
    expect(
      encodeCw1({
        locktime: 0,
        sequence: 0xffffffff,
        script: leaf,
        controlBlock,
        witness: [hexToBytes(v.preimage)]
      })
    ).toBe(v.cw1)
    expect(outputKeyOfCw1(v.cw1)).toBe(v.Q)
  })

  it("the mint's cs1 over Q verifies from either form of the spend, at its domain only", () => {
    const {amount_msat, cs1} = v.certificate
    const {mintPubkey, domain} = LUD25.certificates
    expect(
      verifyNoteSignature(v.preimage, domain, amount_msat, cs1, mintPubkey)
    ).toBe(true)
    expect(
      verifyNoteSignature(v.cw1, domain, amount_msat, cs1, mintPubkey)
    ).toBe(true)
    expect(
      verifyNoteSignatureHash(v.h, domain, amount_msat, cs1, mintPubkey)
    ).toBe(true)
    expect(
      noteCertificateKind(v.preimage, domain, amount_msat, cs1, mintPubkey)
    ).toBe('current')
    expect(
      verifyNoteSignature(v.preimage, domain, amount_msat + 1, cs1, mintPubkey)
    ).toBe(false)
    expect(
      verifyNoteSignature(
        v.preimage,
        'other.example',
        amount_msat,
        cs1,
        mintPubkey
      )
    ).toBe(false)
  })
})
