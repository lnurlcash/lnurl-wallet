import type {Addon} from './types'
import {raffleAddon} from './raffle/manifest'
import {currencyAddon} from './currency/manifest'
import {bech32DecoderAddon} from './bech32Decoder/manifest'
import {customAddonManifests} from './customAddons'

// bundled addons - ship in this app's own reviewed source, not fetched
// from anywhere.
export const ADDONS: Addon[] = [raffleAddon, currencyAddon, bech32DecoderAddon]

const BUNDLED_IDS = new Set(ADDONS.map(a => a.manifest.id))
export const isBundledAddon = (id: string): boolean => BUNDLED_IDS.has(id)

// bundled + holder-authored custom addons (see customAddons.ts and the
// builder on Addons.tsx), merged - a custom addon never gets its own
// `helpers` module (that's TS code; only the fixed built-in operators/
// verbs are available to one), and a custom addon's id can never shadow a
// bundled one (enforced at save time in Addons.tsx, not here). This is a
// plain function, not a cached value, so it stays reactive when called
// directly inside JSX (see addons/README.md's note on Renderer.tsx's own
// reactivity rule - the same "read inline, don't precompute" rule applies
// to every consumer of this list, not just Renderer.tsx).
export const allAddons = (): Addon[] => [
  ...ADDONS,
  ...customAddonManifests().map(manifest => ({manifest, helpers: {}}))
]

export const findAddon = (id: string): Addon | undefined =>
  allAddons().find(a => a.manifest.id === id)
