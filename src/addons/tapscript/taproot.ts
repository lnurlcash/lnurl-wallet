// BIP341-style Taproot pubkey tweaking - a thin hex-in/hex-out wrapper
// around @scure/btc-signer/utils.js (same author/ecosystem as this repo's
// own @noble/curves - see this addon's own README-level comment in
// manifest.ts for why that library was chosen over hand-rolling BIP341).
// Statically imported (not lazy, unlike raffle/pdf.ts's pdf-lib/qrcode) -
// this module is small and every exported function here must stay
// SYNCHRONOUS: a helper returning a Promise only gets awaited by the addon
// renderer when it's a verb's own arg (see Renderer.tsx's runVerb), never
// when it's the direct value of a plain Text/Show binding or a `set`
// action - a lazy import here would silently break the live Text displays
// this addon's UI relies on.
import {
  randomPrivateKeyBytes,
  pubSchnorr,
  tapTweak,
  taprootTweakPrivKey,
  taprootTweakPubkey
} from '@scure/btc-signer/utils.js'
import {schnorr} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'

const parseHex = (
  hex: string,
  expectedBytes: number,
  label: string
): Uint8Array => {
  const trimmed = hex.trim().toLowerCase()
  if (!/^[0-9a-f]*$/.test(trimmed) || trimmed.length !== expectedBytes * 2) {
    throw new Error(`${label} must be ${expectedBytes * 2} hex characters.`)
  }
  return hexToBytes(trimmed)
}

// a holder-typed "script" stands in for a real Taproot script leaf/merkle
// root - this addon is a pubkey-tweaking playground, not a full script-
// tree builder, so a script's own bytes are folded into one merkle-root-
// shaped 32-byte value via sha256 rather than genuinely building a tapleaf/
// tapbranch tree. An empty list means key-path-only (merkle root = empty
// bytes, per BIP341)
const merkleRootFor = (scripts: string[]): Uint8Array =>
  scripts.length === 0
    ? new Uint8Array(0)
    : sha256(utf8ToBytes(scripts.join('\n')))

export type TweakResult = {
  tweakedPubkeyHex: string
  tweakScalarHex: string
  parity: 'even' | 'odd'
}

// pubkeyHex: 32-byte x-only hex (the BIP340/Taproot "internal key" P).
// scripts: see merkleRootFor above. Throws on bad hex or if the tweak
// scalar is >= the curve order (BIP341's own reject-don't-reduce
// contract - taprootTweakPubkey/tapTweak both already enforce this).
export const tweakPubkey = (
  pubkeyHex: string,
  scripts: string[]
): TweakResult => {
  const pubkey = parseHex(pubkeyHex, 32, 'Pubkey')
  const merkleRoot = merkleRootFor(scripts)
  const tweakScalar = tapTweak(pubkey, merkleRoot)
  const [tweakedPubkey, parity] = taprootTweakPubkey(pubkey, merkleRoot)
  return {
    tweakedPubkeyHex: bytesToHex(tweakedPubkey),
    tweakScalarHex: tweakScalar.toString(16).padStart(64, '0'),
    parity: parity === 0 ? 'even' : 'odd'
  }
}

export const tweakSecretKey = (
  secretKeyHex: string,
  scripts: string[]
): string => {
  const secretKey = parseHex(secretKeyHex, 32, 'Secret key')
  const merkleRoot = merkleRootFor(scripts)
  return bytesToHex(taprootTweakPrivKey(secretKey, merkleRoot))
}

// generates a fresh random keypair entirely client-side - ephemeral, same
// pattern as nostrTools.generateNostrKeypair / seedGenerator's own seed
// generation. Never touches this wallet's real seed or note secrets.
export const generateKeypair = (): {
  secretKeyHex: string
  pubkeyHex: string
} => {
  const secretKey = randomPrivateKeyBytes()
  return {
    secretKeyHex: bytesToHex(secretKey),
    pubkeyHex: bytesToHex(pubSchnorr(secretKey))
  }
}

export type SignResult = {signatureHex: string; verified: boolean}

// proves a tweaked key is a real, usable keypair (not just abstract hex) -
// signs a holder-typed message with the tweaked secret key using this
// repo's own @noble/curves schnorr (BIP340), then verifies against the
// tweaked pubkey. Not @scure/btc-signer's Signer tool - that's shaped
// around signing a Bitcoin transaction input, not an arbitrary message.
export const signWithTweakedKey = (
  secretKeyHex: string,
  scripts: string[],
  messageUtf8: string
): SignResult => {
  const tweakedSecretKey = hexToBytes(tweakSecretKey(secretKeyHex, scripts))
  const tweakedPubkey = schnorr.getPublicKey(tweakedSecretKey)
  // @noble/curves' schnorr.sign/verify accept an arbitrary-length message
  // (BIP340 doesn't mandate a fixed size) - hashed first anyway, matching
  // how a real signer almost always signs a fixed-size digest (a sighash,
  // a challenge hash, ...) rather than raw holder-typed text
  const digest = sha256(utf8ToBytes(messageUtf8))
  const signature = schnorr.sign(digest, tweakedSecretKey)
  return {
    signatureHex: bytesToHex(signature),
    verified: schnorr.verify(signature, digest, tweakedPubkey)
  }
}
