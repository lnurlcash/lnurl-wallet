import type {DeviceClient} from '../device'
import type {Bearer} from '../storage'
import type {WalletContextType} from '../WalletContext'
import {parseLabelTags} from '../noteTags'
import {
  serverOf,
  resolveLnurlInput,
  isLightningAddress,
  lnurlFetch,
  encodeCp1,
  decodeCp1,
  decodeCx1,
  deriveNotePubkey,
  NOTE_PURPOSE_WALLET,
  parseInternalTransferHint,
  requireNoteK1,
  rotateNoteWithHash,
  verifyNoteSignatureForKey,
  noteSignature,
  settleNote,
  withNewK1,
  AmbiguousMintError,
  fetchNoteInfoByPubkey,
  generateOutputSecret,
  hashK1,
  outputKeyOfCw1,
  noteMintOf
} from '../lnurlcash'
import {copyToClipboard} from '../helpers'
import {splitBearerIntoAmounts, type SplitTarget} from '../noteSplitting'
import {hexToBytes, bytesToHex} from '@noble/hashes/utils.js'
import {parseBetReceipt, buildRedeemCw1} from './betlocker/betlock'
import {parseHtlcReceipt, buildClaimCw1} from './htlc/htlc'
import {
  fetchOraclePubkey,
  fetchOracleEvents,
  fetchOracleAnnouncement,
  fetchOracleAttestation
} from './dlc/oracleClient'
import {
  redeemCurrentStateCw1,
  nextState,
  planSealLock,
  type SealState
} from './seals/seals'
import {fetchAddressSummary, fetchAddressUtxos} from './electrs/electrsClient'

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
      .map(b => ({
        id: b.id,
        amountSat: Math.floor(b.amount / 1000),
        mint: noteMintOf(b.url)
      }))
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

  // LUD-25: burns the chosen note and re-mints it as `cp1<pubkeyHex>` - a
  // taproot output key Q this wallet does not itself control, e.g. the
  // musig2 addon's own MuSig2 aggregate group pubkey, or a Q committing to
  // script leaves (timelocker, betlocker, htlc, seals). Redeemable by a ck1
  // (a BIP-340 signature by Q over the spend sighash, see
  // src/lib/signature.ts), or a cw1 revealing any leaf committed under Q -
  // the mint accepts both for every note, so no kind needs choosing.
  // Once this returns, this wallet no longer holds a spendable secret for
  // that value on its own. request.ts's own
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
        'A vault-backed note cannot be locked to a pubkey yet - key-path notes are browser-only for now.'
      )
    }
    const pubkeyHex = String(args.pubkeyHex ?? '')
      .trim()
      .toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(pubkeyHex)) {
      throw new Error('Not a valid 32-byte x-only pubkey.')
    }
    const target = encodeCp1(hexToBytes(pubkeyHex))
    const k1 = requireNoteK1(bearer.url)
    let signature: string | undefined
    try {
      const result = await rotateNoteWithHash(bearer.callback, k1, target)
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
      ? verifyNoteSignatureForKey(
          pubkeyHex,
          bearer.amount,
          signature,
          bearer.mintPubkey
        )
      : false
    // the burn already landed server-side (the mutation above returned
    // OK) - this wallet's own copy of the old secret is now worthless
    // either way, verified or not. Marked spent rather than removed, same
    // convention every other burn in this wallet follows (MeltDialog,
    // TransferDialog, noteSplitting's own remainder, "mark spent" on
    // BearerCard/Wallet.tsx) - it stays visible in history instead of
    // silently vanishing from the list.
    await ctx.updateBearer(bearer.id, {spent: true})
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
      // the domain every signature spending this note is bound to (see
      // src/lib/spend.ts) - its mint's host, never secret
      mint: noteMintOf(bearer.url),
      signature,
      pubkeyVerified,
      // bearer.url's OWN k1 is already burned/worthless by this point -
      // safe to hand back as a plain host/path template, same "old k1
      // gets silently overwritten next" pattern Wallet.tsx's own combine/
      // split already rely on (see withNewK1)
      urlTemplate: bearer.url
    }
  },

  // The redeem half of the betlocker addon: `receiptUrl` is a bet receipt
  // (host/path/certificate/announcement, no k1 - see betlock.ts's own
  // betReceiptUrl/parseBetReceipt), `outcome`/`signatureHex` are what the
  // oracle actually published. buildRedeemCw1 does the real work (verifies
  // the attestation, builds and signs the script-path spend) and throws
  // its own specific reason on anything that doesn't check out; this verb
  // is just the network round trip around it, same shape as
  // note.lockToPubkey/note.claim.
  //
  // Order matters (a rotate is irreversible): the replacement note is
  // saved to the wallet FIRST, unverified, and only removed again on a
  // DEFINITIVE refusal - same reasoning as every other redeem-by-rotate
  // flow in this wallet (see receive.ts's own receiveIntoWallet). This is
  // a genuine race (see betlock.ts's own top comment): the mint may
  // already have paid out to whoever redeemed first, in which case this
  // fails as an ordinary rotate refusal, not something special to bets.
  'note.redeemBet': async (args, ctx) => {
    const receipt = parseBetReceipt(args.receiptUrl)
    if (!receipt) {
      throw new Error('Not a valid bet receipt.')
    }
    // only meaningful (and only ever required) when the receipt itself
    // names a counterparty - buildRedeemCw1 enforces that, this verb never
    // second-guesses it. Never logged, never sent anywhere but into the
    // local signing call below.
    const redeemerSecretKeyHex = String(args.redeemerSecretKeyHex ?? '').trim()
    const cw1 = buildRedeemCw1(
      receipt,
      {
        outcome: String(args.outcome ?? '').trim(),
        signatureHex: String(args.signatureHex ?? '').trim()
      },
      redeemerSecretKeyHex || undefined
    )
    const outputKeyHex = outputKeyOfCw1(cw1)
    if (!outputKeyHex) {
      throw new Error(
        "Internal error: could not derive this bet's own output key."
      )
    }
    const info = await fetchNoteInfoByPubkey(
      receipt.urlTemplate,
      encodeCp1(hexToBytes(outputKeyHex))
    )
    const amountMsat = info.maxWithdrawable
    const newK1 = generateOutputSecret(serverOf(info.callback), false)
    const saved = await ctx.addBearer({
      url: withNewK1(receipt.urlTemplate, newK1, amountMsat),
      callback: info.callback,
      amount: amountMsat,
      verified: false
    })
    let signature: string | undefined
    try {
      signature = (await rotateNoteWithHash(info.callback, cw1, hashK1(newK1)))
        .signature
    } catch (err) {
      if (err instanceof AmbiguousMintError) {
        throw new Error(
          `${(err as Error).message} The redemption may or may not have landed - a replacement note was saved to your wallet; refresh it on the Wallet page to find out. Do not retry until you have.`
        )
      }
      ctx.removeBearer(saved.id)
      throw err
    }
    await ctx.updateBearer(saved.id, {
      url: withNewK1(receipt.urlTemplate, newK1, amountMsat, signature),
      verified: true
    })
    ctx.logActivity(
      'mint',
      `Redeemed a ${amountMsat} msat DLC bet at ${serverOf(receipt.urlTemplate)} via an addon.`
    )
    return {id: saved.id, amountMsat}
  },

  // The HTLC addon's own redeem step - same shape as note.redeemBet just
  // above (build the real cw1, look up the note by its output key, save a
  // placeholder bearer, rotate, then confirm), with buildClaimCw1's
  // preimage+claimant-secret check standing in for buildRedeemCw1's
  // attestation check.
  'note.redeemHtlc': async (args, ctx) => {
    const receipt = parseHtlcReceipt(args.receiptUrl)
    if (!receipt) {
      throw new Error('Not a valid HTLC receipt.')
    }
    const cw1 = buildClaimCw1(
      receipt,
      String(args.preimageHex ?? '').trim(),
      String(args.claimSecretKeyHex ?? '').trim()
    )
    const outputKeyHex = outputKeyOfCw1(cw1)
    if (!outputKeyHex) {
      throw new Error(
        "Internal error: could not derive this lock's own output key."
      )
    }
    const info = await fetchNoteInfoByPubkey(
      receipt.urlTemplate,
      encodeCp1(hexToBytes(outputKeyHex))
    )
    const amountMsat = info.maxWithdrawable
    const newK1 = generateOutputSecret(serverOf(info.callback), false)
    const saved = await ctx.addBearer({
      url: withNewK1(receipt.urlTemplate, newK1, amountMsat),
      callback: info.callback,
      amount: amountMsat,
      verified: false
    })
    let signature: string | undefined
    try {
      signature = (await rotateNoteWithHash(info.callback, cw1, hashK1(newK1)))
        .signature
    } catch (err) {
      if (err instanceof AmbiguousMintError) {
        throw new Error(
          `${(err as Error).message} The redemption may or may not have landed - a replacement note was saved to your wallet; refresh it on the Wallet page to find out. Do not retry until you have.`
        )
      }
      ctx.removeBearer(saved.id)
      throw err
    }
    await ctx.updateBearer(saved.id, {
      url: withNewK1(receipt.urlTemplate, newK1, amountMsat, signature),
      verified: true
    })
    ctx.logActivity(
      'mint',
      `Redeemed a ${amountMsat} msat HTLC note at ${serverOf(receipt.urlTemplate)} via an addon.`
    )
    return {id: saved.id, amountMsat}
  },

  // The Seals addon's own transition step: reveals the CURRENT state (the
  // hashlock's own preimage, via redeemCurrentStateCw1) and signs with
  // the current owner's key to redeem the current leaf, in the SAME mint
  // call rotating directly into the NEXT state's own cp1 output - never a
  // plain secret, unlike note.redeemBet above. Deliberately its own verb
  // rather than reusing note.redeemBet (always rotates to a plain bearer
  // secret) or note.lockToPubkey (only ever rotates a note THIS wallet
  // already holds via requireNoteK1, never an externally-constructed
  // cw1). No note is added to this wallet's own Bearer list here - the
  // NEXT state's note isn't something the transitioning party can
  // meaningfully "hold" (redeeming it later needs the NEXT owner's own
  // secret key, which this call never sees) - see seals/manifest.ts's own
  // top comment on why the consignment itself is what carries custody
  // forward, not this wallet's Bearer storage.
  'seal.transition': async args => {
    const urlTemplate = String(args.urlTemplate ?? '').trim()
    const currentState = args.currentState as SealState
    const ownerSecretKeyHex = String(args.ownerSecretKeyHex ?? '').trim()
    const nextOwnerPubkeyHex = String(args.nextOwnerPubkeyHex ?? '').trim()
    const amountMsat = Number(args.amountMsat)
    if (!urlTemplate || !currentState) {
      throw new Error('Missing this seal’s own note or current state.')
    }
    const cw1 = redeemCurrentStateCw1(
      currentState,
      ownerSecretKeyHex,
      urlTemplate
    )
    const currentOutputKeyHex = outputKeyOfCw1(cw1)
    if (!currentOutputKeyHex) {
      throw new Error(
        "Internal error: could not derive this seal's own current output key."
      )
    }
    const info = await fetchNoteInfoByPubkey(
      urlTemplate,
      encodeCp1(hexToBytes(currentOutputKeyHex))
    )
    const next = nextState(currentState, nextOwnerPubkeyHex)
    const nextOutputKeyHex = planSealLock(next).outputKeyHex
    try {
      await rotateNoteWithHash(
        info.callback,
        cw1,
        encodeCp1(hexToBytes(nextOutputKeyHex))
      )
    } catch (err) {
      if (err instanceof AmbiguousMintError) {
        throw new Error(
          `${(err as Error).message} The transition may or may not have landed - check with the next owner before retrying, and do not sign a second transition until you know which.`
        )
      }
      throw err
    }
    return {
      urlTemplate,
      amountMsat: info.maxWithdrawable,
      state: next
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
  },

  // Betlocker's own "browse a real oracle" verbs - read-only GETs against
  // a DLC oracle service's public REST API (oracleClient.ts), same
  // posture as lnurl.fetch just above: no note/secret/wallet-state
  // access, never mutates anything the oracle tracks, just asks it what
  // it published. Deliberately NOT available to the sibling `dlc`
  // Playground addon - see its manifest's own top comment on why
  // permissions: [] there is load-bearing.
  'oracle.fetchPubkey': async args => {
    const baseUrl = String(args.baseUrl ?? '').trim()
    if (!baseUrl) throw new Error("Enter the oracle's URL first.")
    return fetchOraclePubkey(baseUrl)
  },

  'oracle.fetchEvents': async args => {
    const baseUrl = String(args.baseUrl ?? '').trim()
    if (!baseUrl) throw new Error("Enter the oracle's URL first.")
    return fetchOracleEvents(baseUrl)
  },

  'oracle.fetchAnnouncement': async args => {
    const baseUrl = String(args.baseUrl ?? '').trim()
    const eventId = String(args.eventId ?? '').trim()
    if (!baseUrl || !eventId) {
      throw new Error("Enter the oracle's URL and pick an event first.")
    }
    return fetchOracleAnnouncement(baseUrl, eventId)
  },

  'oracle.fetchAttestation': async args => {
    const baseUrl = String(args.baseUrl ?? '').trim()
    const eventId = String(args.eventId ?? '').trim()
    if (!baseUrl || !eventId) {
      throw new Error("Missing the oracle's URL or this bet's event id.")
    }
    return fetchOracleAttestation(baseUrl, eventId)
  },

  // Electrs addon's own "browse a real chain indexer" verbs - read-only
  // GETs against a holder-chosen electrs/esplora-compatible REST server
  // (electrsClient.ts), same posture as oracle.fetch*/lnurl.fetch above:
  // no note/secret/wallet-state access, never mutates anything the server
  // tracks, just asks it about a plain onchain address.
  'electrs.address': async args => {
    const baseUrl = String(args.baseUrl ?? '').trim()
    const address = String(args.address ?? '').trim()
    if (!baseUrl || !address) {
      throw new Error("Enter the server's URL and an address first.")
    }
    return fetchAddressSummary(baseUrl, address)
  },

  'electrs.utxos': async args => {
    const baseUrl = String(args.baseUrl ?? '').trim()
    const address = String(args.address ?? '').trim()
    if (!baseUrl || !address) {
      throw new Error("Enter the server's URL and an address first.")
    }
    return fetchAddressUtxos(baseUrl, address)
  },

  // resolves a THIRD PARTY's LUD-25 pubkey from a cp1/cx1 address, a full
  // Lightning Address, or a registered username - the MuSig2 addon's "add
  // an external pubkey" flow, for a co-signer who has never handed over a
  // raw 33-byte compressed hex. A full Lightning Address (any domain, e.g.
  // "alice@example.com") is tried first and needs nothing else - it names
  // its own mint. `mintNote` (one of THIS wallet's own notes) only matters
  // for the bare-username fallback below, which has no domain of its own,
  // so it's resolved as "username@<that note's own mint>" - the
  // participant must be registered at the SAME mint the chosen note
  // already belongs to, not just anywhere. cp1/cx1 need no domain at all
  // (both are self-contained) and resolve identically regardless of which
  // note (if any usable one exists) was picked.
  //
  // Every path returns the SAME shape - a bare 33-byte compressed hex
  // string, exactly what externalPubkeyInput/addExternalParticipant
  // already accepts verbatim - manifest.ts writes this straight into that
  // field via `result` (Renderer.tsx's runAction does a raw
  // setStore(path, result), no subfield extraction, so this must be the
  // plain string itself, never an object wrapping it), so the
  // pre-existing "Add external pubkey" button and its validation are
  // reused unchanged; this verb only ever fills the box, it never itself
  // adds a participant.
  //
  // cp1 and any derived cx1 pubkey are x-only (BIP-340) - compressed as
  // `02 || x`, never `03 || x`: every note key in this document's own
  // derivation (Seed & derivation, both the top-level `sk_i` formula and
  // a registered branch's own `sk_0`) is already normalized to the
  // even-y point before its x-only form is ever published, so `02` is
  // the one BIP-340 convention (and MuSig2/BIP-327 verification) already
  // assumes for it - never a guess between the two.
  'note.resolveAddressPubkey': async (args, ctx) => {
    const address = String(args.address ?? '').trim()
    if (!address) {
      throw new Error(
        'Enter a cp1/cx1 address, a Lightning Address, or a username first.'
      )
    }

    const cp1 = decodeCp1(address)
    if (cp1) return `02${bytesToHex(cp1)}`

    const cx1 = decodeCx1(address)
    if (cx1) {
      // index 0 - the branch's own "first secret" (Seed & derivation),
      // the closest thing to a stable per-branch identity key; unlike a
      // payment there is no "next unused" to race against here, so
      // there's no reason to prefer any other index
      const pubkey = deriveNotePubkey(
        cx1.pubkeyXOnly,
        cx1.chainCode,
        NOTE_PURPOSE_WALLET,
        0
      )
      return `02${bytesToHex(pubkey)}`
    }

    // shared by the full-Lightning-Address path (any domain) and the
    // bare-username-at-a-known-mint path below - both end the same way,
    // once the actual "user@domain" string to resolve is in hand: fetch
    // its payRequest, read the LUD-25 branch it may have
    // registered (parseInternalTransferHint), and derive that branch's
    // own stable index-0 pubkey (same reasoning as the cx1 branch above)
    const resolveLud25Pubkey = async (
      lookupAddress: string,
      displayAddress: string
    ): Promise<string> => {
      const url = resolveLnurlInput(lookupAddress)
      if (!url) throw new Error(`Could not resolve ${displayAddress}.`)
      const body = (await lnurlFetch(url)) as {
        tag?: string
        metadata?: string
      }
      if (body?.tag !== 'payRequest') {
        throw new Error(
          `${displayAddress} did not resolve to a payable address.`
        )
      }
      const hint = parseInternalTransferHint(String(body.metadata ?? ''))
      if (!hint) {
        throw new Error(
          `${displayAddress} hasn't published a LUD-25 address (no text/xpub metadata) - they'd need to register a Lightning Address there first, or hand you their pubkey/cp1/cx1 directly.`
        )
      }
      const pubkey = deriveNotePubkey(
        hint.cx1.pubkeyXOnly,
        hint.cx1.chainCode,
        NOTE_PURPOSE_WALLET,
        0
      )
      return `02${bytesToHex(pubkey)}`
    }

    // a full Lightning Address (any domain) resolves entirely on its own -
    // unlike the bare-username path below, it never needs mintNote to
    // supply a domain
    if (isLightningAddress(address)) {
      return resolveLud25Pubkey(address, address)
    }

    // mirrors the mint's own _USERNAME_PATTERN (router.py) - same shape
    // guard addressRegistry.ts's own copy applies to a stored record,
    // just here against an about-to-be-looked-up one
    if (!/^[a-z0-9_.-]{1,32}$/.test(address.toLowerCase())) {
      throw new Error(
        'Not a valid compressed pubkey (paste it directly instead), cp1/cx1 address, Lightning Address, or username.'
      )
    }
    if (!args.mintNote) {
      throw new Error(
        `Pick one of your notes above first, to choose which mint to look "${address}" up at.`
      )
    }
    const bearer = resolveNote(ctx, args.mintNote)
    const domain = serverOf(bearer.url)
    const fullAddress = `${address.toLowerCase()}@${domain}`
    return resolveLud25Pubkey(fullAddress, fullAddress)
  }
}
