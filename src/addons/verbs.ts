import type {DeviceClient} from '../device'
import type {Bearer} from '../storage'
import type {WalletContextType} from '../WalletContext'
import {parseLabelTags} from '../noteTags'
import {
  serverOf,
  resolveLnurlInput,
  lnurlFetch,
  encodeCp1,
  requireNoteK1,
  rotateNoteWithHash,
  verifyNoteSignatureHash,
  noteSignature,
  settleNote,
  withNewK1,
  AmbiguousMintError
} from '../lnurlcash'
import {copyToClipboard} from '../helpers'
import {splitBearerIntoAmounts, type SplitTarget} from '../noteSplitting'
import {hexToBytes} from '@noble/hashes/utils.js'

// the subset of WalletContext/DeviceContext a verb is allowed to touch -
// never the raw AES key, never DeviceContext's own `client` beyond the
// accessor/guard pair every split already goes through
export type VerbContext = {
  bearers: () => Bearer[]
  addBearer: WalletContextType['addBearer']
  updateBearer: WalletContextType['updateBearer']
  removeBearer: WalletContextType['removeBearer']
  logActivity: WalletContextType['logActivity']
  deviceClient: () => DeviceClient | null
  requireDeviceClient: (client: DeviceClient | null) => DeviceClient
  // which addon is actually calling - set by Renderer.tsx from the
  // manifest being rendered, never something an addon's own args could
  // supply or override, so note.split's own tagging below is a host
  // guarantee, not something every addon has to remember to do itself
  addon: {id: string; name: string}
}

export type VerbHandler = (
  args: Record<string, unknown>,
  ctx: VerbContext
) => Promise<unknown>

// a note reference an addon holds is always an opaque bearer id, never the
// note's real url/k1 - resolving it back to the real Bearer happens only
// here, host-side
const resolveNote = (ctx: VerbContext, ref: unknown): Bearer => {
  const bearer = ctx.bearers().find(b => b.id === ref)
  if (!bearer) throw new Error('That note is no longer available.')
  return bearer
}

// every note.split output is unconditionally tagged with the calling
// addon's name and a stable `addon-<id>` tag, on top of whatever tags the
// addon itself asked for - a host guarantee (this runs regardless of what
// an addon's manifest does or doesn't ask for), not something every addon
// has to remember to do itself, so Wallet.tsx's tag filter can always find
// "everything this addon made" by id (survives a display-name change) or
// by name (more readable)
export const buildTicketLabel = (
  tags: string[] | undefined,
  addon: {id: string; name: string}
): string =>
  [...(tags ?? []), addon.name, `addon-${addon.id}`]
    .map(tag => `[${tag}]`)
    .join('')

// `scope` is a tiny fixed mini-language, not a query language an addon
// could use to reach anything unintended: "spent:false"/"spent:true", or
// "tag:<value>" against noteTags.ts's own bracket convention
const matchesScope = (bearer: Bearer, scope?: string): boolean => {
  if (!scope) return true
  const [key, value] = scope.split(':')
  if (key === 'spent') return Boolean(bearer.spent) === (value === 'true')
  if (key === 'tag') {
    return parseLabelTags(bearer.label || '').tags.includes(
      encodeURIComponent(value ?? '')
    )
  }
  return false
}

export const VERBS: Record<string, VerbHandler> = {
  'note.query': async (args, ctx) => {
    const scope = args.scope as string | undefined
    return ctx
      .bearers()
      .filter(b => matchesScope(b, scope))
      .map(b => ({id: b.id, amountSat: Math.floor(b.amount / 1000)}))
  },

  // splits one note into many, tagging each part atomically - see
  // noteSplitting.ts for the shared, hardened split/error-recovery logic
  // this wraps rather than reimplements, and buildTicketLabel above for
  // the tagging guarantee
  'note.split': async (args, ctx) => {
    const bearer = resolveNote(ctx, args.note)
    const tickets = args.tickets as {
      index?: number
      amountMsat: number
      tags?: string[]
    }[]
    const targets: SplitTarget[] = tickets.map(t => ({
      amountMsat: t.amountMsat,
      label: buildTicketLabel(t.tags, ctx.addon)
    }))
    const {parts} = await splitBearerIntoAmounts(bearer, targets, ctx)
    ctx.logActivity(
      'split',
      `Split ${serverOf(bearer.url)} into ${parts.length} notes via an addon.`,
      bearer.label
    )
    // splitBearerIntoAmounts returns one part per target, in the same
    // order (see its own doc comment) - so parts[i] is targets[i], which
    // is tickets[i], carrying whatever index the caller assigned (e.g.
    // planTickets's own shuffled print order) - falls back to plain array
    // position for a caller that never set one. amountSat is a plain
    // number here, not helpers.ts's own msatToSats (which formats a
    // locale STRING for on-screen display) - the raffle PDF sums these
    // arithmetically, not just prints them.
    return parts.map((p, i) => ({
      id: p.id,
      url: p.url,
      label: parseLabelTags(p.label || '').text,
      index: tickets[i]?.index ?? i,
      amountSat: Math.floor(p.amount / 1000)
    }))
  },

  // LUD-25 Part 2: burns the chosen note and re-mints it owned by a pubkey
  // commitment (cp1<pubkeyHex>) instead of a hash this wallet itself
  // controls - e.g. the musig2 addon's own MuSig2 aggregate group pubkey.
  // Once this returns, this wallet no longer holds a spendable secret for
  // that value on its own: only whoever can produce a valid ck1 (a
  // BIP-340 signature over "LNURLcash" from the pubkey's own private key -
  // see src/lib/signature.ts) can ever redeem it again. request.ts's own
  // mutationSignature already requires SOME well-shaped signature for a
  // cp1 output or throws; this additionally checks that signature actually
  // recovers to the note's own PINNED mint key, not just that it parses,
  // so a caller can tell "certified" apart from "merely well-formed".
  'note.lockToPubkey': async (args, ctx) => {
    const bearer = resolveNote(ctx, args.note)
    if (bearer.spent) {
      throw new Error('That note is already marked spent.')
    }
    if (!bearer.callback) {
      throw new Error(
        "That note hasn't been verified yet - refresh it on the Wallet page first."
      )
    }
    if (bearer.deviceId) {
      throw new Error(
        'A vault-backed note cannot be locked to a pubkey yet - LUD-25 Part 2 pubkey-based notes are browser-only for now.'
      )
    }
    const pubkeyHex = String(args.pubkeyHex ?? '')
      .trim()
      .toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(pubkeyHex)) {
      throw new Error('Not a valid 32-byte x-only pubkey.')
    }
    const cp1 = encodeCp1(hexToBytes(pubkeyHex))
    const k1 = requireNoteK1(bearer.url)
    let signature: string | undefined
    try {
      const result = await rotateNoteWithHash(bearer.callback, k1, cp1)
      signature = result.signature
    } catch (err) {
      if (err instanceof AmbiguousMintError) {
        throw new Error(
          `${(err as Error).message} This note's fate is uncertain - check it on the Wallet page (a refresh/rotate there will confirm whether it's still spendable) before retrying.`
        )
      }
      throw err
    }
    if (!signature) {
      throw new Error('The mint did not certify the locked pubkey.')
    }
    const pubkeyVerified = bearer.mintPubkey
      ? verifyNoteSignatureHash(
          pubkeyHex,
          bearer.amount,
          signature,
          bearer.mintPubkey
        )
      : false
    // the burn already landed server-side (the mutation above returned
    // OK) - this wallet's own copy of the old secret is now worthless
    // either way, verified or not
    ctx.removeBearer(bearer.id)
    ctx.logActivity(
      'spent',
      `Locked a ${bearer.amount} msat note at ${serverOf(bearer.url)} to a pubkey via an addon.`,
      bearer.label
    )
    return {
      amountMsat: bearer.amount,
      mintPubkey: bearer.mintPubkey ?? null,
      callback: bearer.callback,
      groupPubkeyHex: pubkeyHex,
      signature,
      pubkeyVerified,
      // bearer.url's OWN k1 is already burned/worthless by this point -
      // safe to hand back as a plain host/path template, same "old k1
      // gets silently overwritten next" pattern Wallet.tsx's own combine/
      // split already rely on (see withNewK1)
      urlTemplate: bearer.url
    }
  },

  // adds an already fully-known note (url/callback/amount[/mintPubkey])
  // straight into the wallet - the generic counterpart to
  // note.lockToPubkey above (or any other addon flow that assembles a
  // complete, ready note client-side, e.g. the musig2 addon's own
  // ck1-redemption step) rather than minting one through a payRequest.
  // Added unverified first, then a best-effort settle (the same
  // "confirmed spendable" round trip Wallet.tsx's own combine/split
  // already do) fills in the authoritative value and offline-verifiable
  // signature; a failed settle just leaves it unverified rather than
  // losing the note - a refresh on the Wallet page repairs it the same
  // way an interrupted combine/split already does.
  'note.claim': async (args, ctx) => {
    const url = typeof args.url === 'string' ? args.url : ''
    const callback = typeof args.callback === 'string' ? args.callback : ''
    const amountMsat = Number(args.amountMsat)
    const mintPubkey =
      typeof args.mintPubkey === 'string' ? args.mintPubkey : undefined
    if (!url || !callback || !Number.isFinite(amountMsat) || amountMsat <= 0) {
      throw new Error('Not enough information to claim this note yet.')
    }
    const added = await ctx.addBearer({
      url,
      callback,
      amount: amountMsat,
      verified: false,
      mintPubkey
    })
    ctx.logActivity(
      'mint',
      `Claimed a ${amountMsat} msat note at ${serverOf(url)} via an addon.`
    )
    let verified = false
    try {
      const k1 = requireNoteK1(url)
      const settled = await settleNote(
        url,
        k1,
        amountMsat,
        noteSignature(url) ?? undefined
      )
      await ctx.updateBearer(added.id, {
        url: withNewK1(url, settled.k1, settled.amountMsat, settled.signature),
        callback: settled.callback,
        amount: settled.amountMsat,
        verified: true
      })
      verified = true
    } catch {
      // leave it unverified rather than losing the claim - see this
      // verb's own top comment
    }
    return {id: added.id, verified}
  },

  'file.download': async args => {
    const filename = String(args.filename ?? 'download')
    const content = args.content
    const isBinary = content instanceof Uint8Array
    const bytes = isBinary
      ? content
      : new TextEncoder().encode(String(content ?? ''))
    // Uint8Array's TS type is generic over its backing buffer
    // (ArrayBufferLike), while BlobPart insists on a concrete ArrayBuffer -
    // a real gap in lib.dom.d.ts's typing, not an actual runtime mismatch
    const blob = new Blob([bytes as unknown as BlobPart], {
      type: isBinary ? 'application/pdf' : 'text/plain'
    })
    const url = URL.createObjectURL(blob)
    try {
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
    } finally {
      URL.revokeObjectURL(url)
    }
    return null
  },

  // same clipboard helper (and success/failure toast) every other copy
  // button in this wallet already uses - a UI convenience with no note/
  // secret/wallet-state access at all, same reasoning as file.download
  'clipboard.copy': async args => {
    await copyToClipboard(String(args.text ?? ''))
    return null
  },

  // LNURL Tools addon: resolves arbitrary LNURL-ish input (bech32, LUD-17
  // scheme, Lightning Address, plain https) and fetches it - the exact
  // same resolveLnurlInput/lnurlFetch this wallet's own Mint/Receive flows
  // already use, so it inherits the same SSRF allowlist (isAllowedServiceUrl)
  // and offline-mode guard for free. A read-only informational GET with no
  // note/secret/wallet-state access - this never mutates anything the
  // service tracks, only asks it what it is.
  'lnurl.fetch': async args => {
    const input = String(args.input ?? '').trim()
    if (!input) {
      throw new Error('Enter an LNURL, Lightning Address, or URL first.')
    }
    const url = resolveLnurlInput(input)
    if (!url) {
      throw new Error(
        'Not a recognizable LNURL, Lightning Address, lightning: URI, or https:// URL.'
      )
    }
    const body = await lnurlFetch(url)
    return {url, body}
  }
}
