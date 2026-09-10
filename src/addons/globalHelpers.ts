import type {AddonHelper} from './types'

// always available to every addon (bundled or custom), merged in ahead of
// an addon's own helpers by Renderer.tsx - the expression grammar itself
// has no arithmetic operators (see types.ts's Expr), so without at least
// this much, a custom/helper-less addon couldn't even convert a
// holder-entered sat amount into the msat note.split expects. Pure,
// side-effect-free, same rules as any other helper.
export const GLOBAL_HELPERS: Record<string, AddonHelper> = {
  satsToMsat: ((sats: number) => Math.round(Number(sats) * 1000)) as AddonHelper,
  msatToSats: ((msat: number) => Math.floor(Number(msat) / 1000)) as AddonHelper,
  add: ((...ns: number[]) => ns.reduce((sum, n) => sum + Number(n), 0)) as AddonHelper,
  sub: ((a: number, b: number) => Number(a) - Number(b)) as AddonHelper,
  mul: ((a: number, b: number) => Number(a) * Number(b)) as AddonHelper,
  div: ((a: number, b: number) => Number(a) / Number(b)) as AddonHelper,
  round: ((n: number) => Math.round(Number(n))) as AddonHelper
}
