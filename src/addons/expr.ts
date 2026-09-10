import type {AddonHelper, Expr} from './types'

export type EvalContext = {
  // flat lookup root for `{var}` paths - state merged with any special
  // bindings the renderer injects (e.g. the current `item` inside a For)
  vars: Record<string, unknown>
  helpers: Record<string, AddonHelper>
}

// property names that could reach off the plain data object and into the
// JS prototype chain - a `var`/`set` path is manifest-authored text, so this
// closes that off defensively even though today's only manifest is our own
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export const getPath = (root: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined) return undefined
    if (FORBIDDEN_KEYS.has(key)) return undefined
    if (typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, root)

const stringify = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value)

// Evaluates one node of the fixed expression grammar - see types.ts's Expr.
// No eval/Function/dynamic property access beyond getPath above, and no way
// to invoke anything not already present in ctx.helpers.
//
// Deliberately synchronous: this runs inside Solid's reactive tracking
// (Show's `when`, Text's `value`, For's `each`) as well as inside action
// handlers, and an async function only tracks the reads that happen before
// its first `await` - awaiting here would silently break Show/Text
// reactivity. The one helper that's genuinely async (PDF generation) is
// only ever used as the direct, top-level value of an action's arg/value -
// never nested inside another expression - so it surfaces here as an
// ordinary (unawaited) Promise return value, and the action dispatcher
// (Renderer.tsx) is the one place that awaits a possible Promise result,
// after evaluation has already finished.
export const evaluate = (expr: Expr, ctx: EvalContext): unknown => {
  if (expr === null || typeof expr !== 'object') return expr

  // a literal container (see types.ts's Expr) - each element/field is
  // itself an Expr, evaluated recursively; checked before the operator
  // keys below only for arrays (an operator is always a plain object, so
  // an array can never accidentally match one)
  if (Array.isArray(expr)) return expr.map(item => evaluate(item, ctx))

  if ('var' in expr) return getPath(ctx.vars, expr.var)

  if ('cat' in expr) {
    return expr.cat.map(part => stringify(evaluate(part, ctx))).join('')
  }

  if ('and' in expr) {
    return expr.and.every(part => Boolean(evaluate(part, ctx)))
  }

  if ('gt' in expr) {
    const [a, b] = expr.gt
    return Number(evaluate(a, ctx)) > Number(evaluate(b, ctx))
  }

  if ('lte' in expr) {
    const [a, b] = expr.lte
    return Number(evaluate(a, ctx)) <= Number(evaluate(b, ctx))
  }

  if ('helper' in expr) {
    const fn = ctx.helpers[expr.helper]
    if (!fn) {
      throw new Error(`Addon references an unknown helper: ${expr.helper}`)
    }
    const args = expr.args.map(arg => evaluate(arg, ctx))
    return fn(...(args as never[]))
  }

  // none of the operator keys matched - a plain literal object, each field
  // evaluated recursively (see types.ts's Expr doc comment)
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(expr)) {
    result[key] = evaluate(value as Expr, ctx)
  }
  return result
}
