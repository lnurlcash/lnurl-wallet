import {bytesToHex} from '@noble/hashes/utils.js'
import type {Addon, AddonHelper, AddonManifest, UiNode} from '../types'
import {
  isBech32Lnurl,
  fromBech32Lnurl,
  toBech32Lnurl,
  noteK1,
  noteDeclaredAmount,
  noteSignature,
  serviceOriginOf,
  verifyNoteSignature,
  isCk1,
  isPreimage,
  decodeCw1,
  outputKeyOfCw1,
  isBolt11Invoice,
  decodeBolt11AmountMsat,
  decodeBolt11PaymentHash
} from '../../lnurlcash'
import type {Cw1} from '../../lnurlcash'
import {identifyLeaf, opcodesOf} from '../taproot/taproot'
import {LOCKTIME_THRESHOLD, formatUnlock} from '../timelocker/timelock'

// LUD-01's own fixed human-readable part - both directions of this addon's
// bech32 codec (src/lib/urls.ts's toBech32Lnurl/fromBech32Lnurl) always use
// this exact tag, never anything else, so it's a constant rather than
// something decoded per input.
const LNURL_HRP = 'lnurl'

// A pure text transform, nothing more - no verb/permission needed at all,
// same reasoning as the currency converter: this never touches a note, a
// secret, or the network. Reuses this wallet's own LUD-01 bech32 codec
// (src/lib/urls.ts) rather than re-implementing it, so it decodes/encodes
// exactly the same way every note URL in this wallet already does.
const stripScheme = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .replace(/^lightning:/i, '')
    .trim()

const isDecodable = (value: unknown): boolean =>
  isBech32Lnurl(stripScheme(value))

const decodeLnurl = (value: unknown): string | null =>
  fromBech32Lnurl(stripScheme(value))

const looksLikeUrl = (value: unknown): boolean =>
  /^https?:\/\//i.test(stripScheme(value))

const encodeLnurl = (value: unknown): string | null => {
  const stripped = stripScheme(value)
  return looksLikeUrl(stripped) ? toBech32Lnurl(stripped) : null
}

// the actual bech32 payload either direction carries is nothing more than
// the URL's own UTF-8 bytes (see toBech32Lnurl/fromBech32Lnurl) - shown as
// a byte count (not the bytes themselves) so a holder can sanity-check the
// payload size behind the bech32 text, e.g. against a service's own
// length limits, without a hex dump adding noise for what's otherwise
// already shown as the plain URL right above it
const decodedUrlByteSize = (value: unknown): string => {
  const url = decodeLnurl(value)
  if (!url) return '-'
  const n = new TextEncoder().encode(url).length
  return `${n} byte${n === 1 ? '' : 's'}`
}

const encodedUrlByteSize = (value: unknown): string => {
  const stripped = stripScheme(value)
  if (!looksLikeUrl(stripped)) return '-'
  const n = new TextEncoder().encode(stripped).length
  return `${n} byte${n === 1 ? '' : 's'}`
}

// A pasted lnurlcash bearer note URL (see src/lib/urls.ts) - same shape
// this wallet's own bearers are stored as, but detected from plain pasted
// text rather than something already held. `amount` is only this wallet's
// own convention when it builds a note url (buildNoteUrl) - plenty of
// real note urls carry just k1 (+ c), no declared amount - so k1 alone
// is the actual required field; amount/c only disambiguate it from some
// other k1-bearing LNURL (e.g. LNURL-auth's own callback) that isn't a
// note at all. noteK1/noteDeclaredAmount/noteSignature are all null-safe
// on a non-URL/malformed string, so this never throws.
const looksLikeNoteUrl = (value: unknown): boolean => {
  const stripped = stripScheme(value)
  return (
    noteK1(stripped) !== null &&
    (noteDeclaredAmount(stripped) !== null || noteSignature(stripped) !== null)
  )
}

// the note url behind the input, whichever way it arrived: a bech32 LNURL
// decodes to one (quite often a bearer note itself), a pasted note url
// already is one. Null when there's no k1-bearing url to read from.
const noteUrlOf = (value: unknown): string | null => {
  const url = isDecodable(value) ? decodeLnurl(value) : stripScheme(value)
  if (!url || !noteK1(url)) return null
  return isDecodable(value) || looksLikeNoteUrl(value) ? url : null
}

const hasNote = (value: unknown): boolean => noteUrlOf(value) !== null

// a bare note secret pasted on its own - a hex preimage, ck1 or cw1 - with
// no url around it
const bareSecretOf = (value: unknown): string | null => {
  const trimmed = stripScheme(value).toLowerCase()
  return isPreimage(trimmed) || isCk1(trimmed) || decodeCw1(trimmed)
    ? trimmed
    : null
}

const isBareSecret = (value: unknown): boolean => bareSecretOf(value) !== null

const secretOf = (value: unknown): string | null => {
  const url = noteUrlOf(value)
  return url ? noteK1(url) : bareSecretOf(value)
}

const kindOf = (k1: string): string => {
  if (isCk1(k1))
    return 'Key-path note (ck1 - a signature by the note key, bound to its mint)'
  if (decodeCw1(k1))
    return 'Script-path note (cw1 - a revealed tapscript leaf, decoded below)'
  if (isPreimage(k1)) return 'Bearer note (hex preimage, the k1 short form)'
  return 'Unrecognised k1 - not a hex preimage, ck1 or cw1'
}

const noteKindDisplay = (value: unknown): string => {
  const k1 = secretOf(value)
  return k1 ? kindOf(k1) : '-'
}

const noteAmountDisplay = (value: unknown): string => {
  const url = noteUrlOf(value)
  const msat = url ? noteDeclaredAmount(url) : null
  return msat === null
    ? 'not declared in this url'
    : `${Math.floor(msat / 1000).toLocaleString()} sats`
}

const noteK1Display = (value: unknown): string => secretOf(value) ?? '-'

const noteSigDisplay = (value: unknown): string => {
  const url = noteUrlOf(value)
  return (url && noteSignature(url)) ?? 'not attached'
}

const noteOriginDisplay = (value: unknown): string => {
  const url = noteUrlOf(value)
  if (!url) return '-'
  try {
    return serviceOriginOf(url)
  } catch {
    return '-'
  }
}

// ---- cw1 script-path secrets ----

// the same read-only view components/ScriptPreviewDialog.tsx gives a held
// cw1 note, decoded from the same bytes the mint checks (identifyLeaf /
// opcodesOf, shared with the taproot addon) - whether the cw1 arrived bare,
// as a pasted note url's k1, or inside a bech32 LNURL
const cw1Of = (value: unknown): Cw1 | null => {
  const k1 = secretOf(value)
  return k1 ? decodeCw1(k1) : null
}

const isScriptPath = (value: unknown): boolean => cw1Of(value) !== null

const scriptSummary = (value: unknown): string => {
  const cw1 = cw1Of(value)
  if (!cw1) return ''
  const leaf = identifyLeaf(cw1.script)
  return leaf
    ? `${leaf.template.name} - ${leaf.template.description}`
    : "This leaf doesn't match any template this wallet recognises by name - shown below exactly as decoded."
}

// the Timelocker's own shape: a CLTV leaf with a time-typed locktime
const scriptUnlock = (value: unknown): string => {
  const cw1 = cw1Of(value)
  if (!cw1 || cw1.locktime < LOCKTIME_THRESHOLD) return ''
  if (identifyLeaf(cw1.script)?.template.id !== 'cltv') return ''
  return `Timelock - redeemable once the mint's own clock passes ${formatUnlock(cw1.locktime)} (unix ${cw1.locktime}).`
}

// one opcode per line, so a long data push wraps on its own line instead
// of running into its neighbours
const scriptOpcodes = (value: unknown): string => {
  const cw1 = cw1Of(value)
  if (!cw1) return ''
  try {
    return opcodesOf(cw1.script).split(' ').join('\n')
  } catch {
    return `undecodable script: ${bytesToHex(cw1.script)}`
  }
}

const scriptLocktimeSequence = (value: unknown): string => {
  const cw1 = cw1Of(value)
  if (!cw1) return ''
  const locktime =
    cw1.locktime === 0
      ? '0 (none)'
      : cw1.locktime < LOCKTIME_THRESHOLD
        ? `${cw1.locktime} (block height)`
        : `${cw1.locktime} (${formatUnlock(cw1.locktime)})`
  const sequence = `${cw1.sequence} (0x${cw1.sequence.toString(16).padStart(8, '0')})`
  return `locktime: ${locktime}\nsequence: ${sequence}`
}

const scriptWitnessLabel = (value: unknown): string => {
  const n = cw1Of(value)?.witness.length ?? 0
  return `Witness stack (${n} ${n === 1 ? 'item' : 'items'})`
}

const scriptWitness = (value: unknown): string => {
  const cw1 = cw1Of(value)
  if (!cw1) return ''
  return cw1.witness.length > 0
    ? cw1.witness.map(w => bytesToHex(w)).join('\n')
    : 'empty - this leaf needs nothing pushed to satisfy it'
}

const scriptControlBlockLabel = (value: unknown): string => {
  const cb = cw1Of(value)?.controlBlock
  if (!cb || cb.length === 0) return 'Control block'
  const depth = Math.max(0, (cb.length - 33) / 32)
  const version = (cb[0]! & 0xfe).toString(16).padStart(2, '0')
  return `Control block (${depth}-deep merkle path, leaf version 0x${version})`
}

const scriptControlBlock = (value: unknown): string => {
  const cw1 = cw1Of(value)
  return cw1 ? bytesToHex(cw1.controlBlock) : ''
}

const scriptOutputKey = (value: unknown): string => {
  const k1 = secretOf(value)
  return (
    (k1 && outputKeyOfCw1(k1)) ??
    'Malformed control block - could not derive an output key.'
  )
}

// Same verifyNoteSignature call BearerCard.tsx's own offlineVerified check
// makes, just against a mintPubkey typed in here rather than this wallet's
// own trusted-mints registry: this addon stays a pure text transform (see
// the file's own header comment) with no wallet-state reads of its own, so
// it works the same for a note from a mint this device has never seen -
// paste the mint's advertised mintPubkey (Mint page's mint-list entry, or
// the note issuer's own disclosure) alongside the note to check it.
// verifyNoteSignature itself dispatches on k1's own shape (legacy preimage
// vs ck1 signature).
const noteVerifiedDisplay = (value: unknown, mintPubkey: unknown): string => {
  const url = noteUrlOf(value)
  if (!url) return '-'
  const sig = noteSignature(url)
  if (!sig) return 'No signature attached - cannot verify offline.'
  const k1 = noteK1(url)
  const amount = noteDeclaredAmount(url)
  if (!k1 || amount === null) return 'Malformed note URL.'
  const key = String(mintPubkey ?? '').trim()
  if (!key) {
    return "Signature attached - enter the mint's public key above to verify it."
  }
  return verifyNoteSignature(k1, amount, sig, key)
    ? 'Verified - signature matches the mint key entered above.'
    : 'NOT verified - signature does not match the mint key entered above.'
}

const isBolt11Value = (value: unknown): boolean =>
  isBolt11Invoice(stripScheme(value))

const BOLT11_NETWORK_LABELS: Record<string, string> = {
  bc: 'mainnet',
  tb: 'testnet',
  bcrt: 'regtest',
  tbs: 'signet',
  sb: 'signet'
}

const bolt11NetworkDisplay = (value: unknown): string => {
  const match = stripScheme(value)
    .trim()
    .toLowerCase()
    .match(/^ln(bc|tb|bcrt|tbs|sb)/)
  return match ? (BOLT11_NETWORK_LABELS[match[1]] ?? match[1]) : '-'
}

const bolt11AmountDisplay = (value: unknown): string => {
  const msat = decodeBolt11AmountMsat(stripScheme(value))
  return msat === null
    ? 'Any amount'
    : `${Math.floor(msat / 1000).toLocaleString()} sats`
}

const bolt11HashDisplay = (value: unknown): string =>
  decodeBolt11PaymentHash(stripScheme(value)) ??
  'Could not decode payment hash.'

const block = (helper: string): UiNode => ({
  type: 'Text',
  value: {helper, args: [{var: 'input'}]},
  style: 'response-block'
})

const noteUi: UiNode[] = [
  {type: 'Text', value: 'LNURLcash Note', style: 'subheading'},
  {type: 'Text', value: {helper: 'noteKindDisplay', args: [{var: 'input'}]}},
  {
    type: 'Text',
    value: {
      cat: ['Amount: ', {helper: 'noteAmountDisplay', args: [{var: 'input'}]}]
    }
  },
  {
    type: 'Text',
    value: {
      cat: ['Mint: ', {helper: 'noteOriginDisplay', args: [{var: 'input'}]}]
    }
  },
  {type: 'Text', value: 'k1 (the note secret)'},
  block('noteK1Display'),
  {type: 'Text', value: "c (the mint's offline signature)"},
  block('noteSigDisplay'),
  {
    type: 'Input',
    bind: 'mintPubkey',
    label: "Mint's public key (optional, to verify the signature)"
  },
  {
    type: 'Text',
    value: {
      helper: 'noteVerifiedDisplay',
      args: [{var: 'input'}, {var: 'mintPubkey'}]
    }
  }
]

const scriptUi: UiNode[] = [
  {type: 'Text', value: 'Script (cw1)', style: 'subheading'},
  {type: 'Text', value: {helper: 'scriptSummary', args: [{var: 'input'}]}},
  {
    type: 'Show',
    when: {helper: 'scriptUnlock', args: [{var: 'input'}]},
    children: [
      {type: 'Text', value: {helper: 'scriptUnlock', args: [{var: 'input'}]}}
    ]
  },
  {type: 'Text', value: 'Opcodes (decoded from the leaf script itself)'},
  block('scriptOpcodes'),
  {type: 'Text', value: 'Claimed locktime / sequence'},
  block('scriptLocktimeSequence'),
  {type: 'Text', value: {helper: 'scriptWitnessLabel', args: [{var: 'input'}]}},
  block('scriptWitness'),
  {
    type: 'Text',
    value: {helper: 'scriptControlBlockLabel', args: [{var: 'input'}]}
  },
  block('scriptControlBlock'),
  {type: 'Text', value: 'Derived output key (Q) - what this leaf commits to'},
  block('scriptOutputKey')
]

const bech32DecoderManifest: AddonManifest = {
  id: 'bech32-decoder',
  name: 'Bech32 Decoder',
  version: '1',
  icon: 'code',
  description:
    'Decode an LNURL (or lightning: URI) to its plain URL, encode a plain URL to bech32, or inspect a pasted lnurlcash note URL, note secret (ck1, cw1 script) or bolt11 invoice - detects which one automatically.',
  permissions: [],
  nav: {position: 'right', icon: 'code', label: 'Decode'},
  state: {
    input: '',
    mintPubkey: ''
  },
  ui: {
    type: 'View',
    children: [
      {type: 'Text', value: 'Bech32 Decoder', style: 'heading'},
      {
        type: 'Input',
        bind: 'input',
        label:
          'LNURL, lightning: URI, note URL or secret (ck1, cw1), bolt11 invoice, or a plain https:// URL'
      },
      {
        type: 'Show',
        when: {helper: 'isDecodable', args: [{var: 'input'}]},
        children: [
          {type: 'Text', value: 'Decoded URL', style: 'subheading'},
          {
            type: 'Text',
            value: {helper: 'decodeLnurl', args: [{var: 'input'}]},
            style: 'response-block'
          },
          {type: 'Text', value: `Tag (HRP): ${LNURL_HRP}`},
          {
            type: 'Text',
            value: {
              cat: [
                'Payload size: ',
                {helper: 'decodedUrlByteSize', args: [{var: 'input'}]}
              ]
            }
          }
        ]
      },
      {
        type: 'Show',
        when: {helper: 'hasNote', args: [{var: 'input'}]},
        children: noteUi
      },
      {
        type: 'Show',
        when: {helper: 'isBareSecret', args: [{var: 'input'}]},
        children: [
          {type: 'Text', value: 'Note secret', style: 'subheading'},
          {
            type: 'Text',
            value: {helper: 'noteKindDisplay', args: [{var: 'input'}]}
          }
        ]
      },
      {
        type: 'Show',
        when: {helper: 'isScriptPath', args: [{var: 'input'}]},
        children: scriptUi
      },
      {
        type: 'Show',
        when: {helper: 'isBolt11Value', args: [{var: 'input'}]},
        children: [
          {type: 'Text', value: 'Bolt11 Invoice', style: 'subheading'},
          {
            type: 'Text',
            value: {
              cat: [
                'Network: ',
                {helper: 'bolt11NetworkDisplay', args: [{var: 'input'}]}
              ]
            }
          },
          {
            type: 'Text',
            value: {
              cat: [
                'Amount: ',
                {helper: 'bolt11AmountDisplay', args: [{var: 'input'}]}
              ]
            }
          },
          {
            type: 'Text',
            value: {
              cat: [
                'Payment hash: ',
                {helper: 'bolt11HashDisplay', args: [{var: 'input'}]}
              ]
            }
          }
        ]
      },
      {
        type: 'Show',
        when: {helper: 'looksLikeUrl', args: [{var: 'input'}]},
        children: [
          {type: 'Text', value: 'Bech32-encoded LNURL', style: 'subheading'},
          {
            type: 'Text',
            value: {helper: 'encodeLnurl', args: [{var: 'input'}]}
          },
          {type: 'Text', value: `Tag (HRP): ${LNURL_HRP}`},
          {
            type: 'Text',
            value: {
              cat: [
                'Payload size: ',
                {helper: 'encodedUrlByteSize', args: [{var: 'input'}]}
              ]
            }
          }
        ]
      },
      {
        type: 'Show',
        when: {
          and: [
            {gt: [{helper: 'stringLength', args: [{var: 'input'}]}, 0]},
            {
              helper: 'not',
              args: [{helper: 'isDecodable', args: [{var: 'input'}]}]
            },
            {
              helper: 'not',
              args: [{helper: 'looksLikeUrl', args: [{var: 'input'}]}]
            },
            {
              helper: 'not',
              args: [{helper: 'isBolt11Value', args: [{var: 'input'}]}]
            },
            {
              helper: 'not',
              args: [{helper: 'isBareSecret', args: [{var: 'input'}]}]
            }
          ]
        },
        children: [
          {
            type: 'Text',
            value:
              "Doesn't look like an LNURL, a note URL or secret, a bolt11 invoice, or a plain https:// URL."
          }
        ]
      }
    ]
  }
}

const bech32DecoderHelpers: Record<string, AddonHelper> = {
  isDecodable: isDecodable as AddonHelper,
  decodeLnurl: decodeLnurl as AddonHelper,
  looksLikeUrl: looksLikeUrl as AddonHelper,
  encodeLnurl: encodeLnurl as AddonHelper,
  decodedUrlByteSize: decodedUrlByteSize as AddonHelper,
  encodedUrlByteSize: encodedUrlByteSize as AddonHelper,
  hasNote: hasNote as AddonHelper,
  isBareSecret: isBareSecret as AddonHelper,
  noteKindDisplay: noteKindDisplay as AddonHelper,
  noteAmountDisplay: noteAmountDisplay as AddonHelper,
  noteK1Display: noteK1Display as AddonHelper,
  noteSigDisplay: noteSigDisplay as AddonHelper,
  noteOriginDisplay: noteOriginDisplay as AddonHelper,
  noteVerifiedDisplay: noteVerifiedDisplay as AddonHelper,
  isScriptPath: isScriptPath as AddonHelper,
  scriptSummary: scriptSummary as AddonHelper,
  scriptUnlock: scriptUnlock as AddonHelper,
  scriptOpcodes: scriptOpcodes as AddonHelper,
  scriptLocktimeSequence: scriptLocktimeSequence as AddonHelper,
  scriptWitnessLabel: scriptWitnessLabel as AddonHelper,
  scriptWitness: scriptWitness as AddonHelper,
  scriptControlBlockLabel: scriptControlBlockLabel as AddonHelper,
  scriptControlBlock: scriptControlBlock as AddonHelper,
  scriptOutputKey: scriptOutputKey as AddonHelper,
  isBolt11Value: isBolt11Value as AddonHelper,
  bolt11NetworkDisplay: bolt11NetworkDisplay as AddonHelper,
  bolt11AmountDisplay: bolt11AmountDisplay as AddonHelper,
  bolt11HashDisplay: bolt11HashDisplay as AddonHelper,
  stringLength: ((value: unknown) =>
    String(value ?? '').trim().length) as AddonHelper
}

export const bech32DecoderAddon: Addon = {
  manifest: bech32DecoderManifest,
  helpers: bech32DecoderHelpers
}
