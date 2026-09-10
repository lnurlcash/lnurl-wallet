import type {DeviceClient} from '../device'
import type {Bearer} from '../storage'
import type {WalletContextType} from '../WalletContext'
import {parseLabelTags} from '../noteTags'
import {serverOf} from '../lnurlcash'
import {msatToSats} from '../helpers'
import {splitBearerIntoAmounts, type SplitTarget} from '../noteSplitting'

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
    const tickets = args.tickets as {amountMsat: number; tags?: string[]}[]
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
    return parts.map(p => ({
      id: p.id,
      url: p.url,
      label: parseLabelTags(p.label || '').text,
      amountSat: msatToSats(p.amount)
    }))
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
  }
}
