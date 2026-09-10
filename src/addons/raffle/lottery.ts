// Ported from /home/user/repos/raffle/src/lib/lottery.ts (the
// `lnurlcash-lottery` project) - a lottery is a prize table (tiers of "this
// many tickets are worth this much") expanded into one bearer-note amount
// per physical ticket, then shuffled so a ticket's position on the printed
// sheet gives no hint of its value - the whole point of a raffle strip.
// Trimmed of the source project's ticket-pricing/haircut calculator, which
// this addon's manifest doesn't expose - otherwise close to verbatim.

export type PaperSize = 'a4' | 'letter'

export type PrizeTier = {
  id: string
  count: number
  amountSat: number
  label: string
}

export const newTier = (): PrizeTier => ({
  id: crypto.randomUUID(),
  count: 1,
  amountSat: 1000,
  label: ''
})

const tier = (count: number, amountSat: number, label = ''): PrizeTier => ({
  ...newTier(),
  count,
  amountSat,
  label
})

export type TierPresetId =
  'single-winner' | 'classic-raffle' | 'pyramid' | 'even-split'

const TIER_PRESET_BUILDERS: Record<TierPresetId, () => PrizeTier[]> = {
  'single-winner': () => [tier(1, 100000, 'Grand prize'), tier(49, 100)],
  'classic-raffle': () => [
    tier(1, 100000, 'Grand prize'),
    tier(3, 10000, 'Runner-up'),
    tier(46, 500)
  ],
  pyramid: () => [
    tier(1, 200000, 'Grand prize'),
    tier(5, 20000, 'Runner-up'),
    tier(20, 2000),
    tier(74, 200)
  ],
  'even-split': () => [tier(50, 1000)]
}

// exposed as the `tierPreset` DSL helper - replaces the whole tier list, a
// starting point to edit rather than fixed to any total
export const tierPreset = (id: TierPresetId): PrizeTier[] => {
  const build = TIER_PRESET_BUILDERS[id]
  if (!build) throw new Error(`Unknown raffle preset: ${id}`)
  return build()
}

export const ticketCount = (tiers: PrizeTier[]): number =>
  tiers.reduce((n, t) => n + Math.max(0, Math.floor(t.count)), 0)

export const totalAmountSat = (tiers: PrizeTier[]): number =>
  tiers.reduce(
    (n, t) => n + Math.max(0, Math.floor(t.count)) * Math.max(0, t.amountSat),
    0
  )

export type PlannedTicket = {
  index: number
  amountMsat: number
  tags: string[]
}

// Fisher-Yates using a CSPRNG - Math.random's bias would leak which tier a
// position was drawn from over enough lotteries, defeating the shuffle's
// only purpose
const secureShuffle = <T>(items: T[]): T[] => {
  const arr = items.slice()
  for (let i = arr.length - 1; i > 0; i--) {
    const bytes = crypto.getRandomValues(new Uint32Array(1))
    const j = bytes[0]! % (i + 1)
    ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
  }
  return arr
}

// exposed as the `planTickets` DSL helper - the single source of shuffled
// order for both a ticket's amount and its tags, so note.split's one call
// applies both consistently (see verbs.ts) instead of two independent
// shuffles risking inconsistent order
export const planTickets = (
  tiers: PrizeTier[],
  runId: string
): PlannedTicket[] => {
  const flat: {amountMsat: number; tierLabel: string}[] = []
  for (const t of tiers) {
    const count = Math.max(0, Math.floor(t.count))
    const amountMsat = Math.max(0, Math.floor(t.amountSat)) * 1000
    for (let i = 0; i < count; i++) {
      flat.push({amountMsat, tierLabel: t.label.trim()})
    }
  }
  return secureShuffle(flat).map((t, index) => ({
    index,
    amountMsat: t.amountMsat,
    tags: [
      `raffle:${runId}`,
      `tier:${t.tierLabel || Math.floor(t.amountMsat / 1000)}`
    ]
  }))
}
