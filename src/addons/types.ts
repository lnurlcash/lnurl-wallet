// The addon DSL: an addon is data a trusted renderer interprets, never code
// that runs. See /home/user/.claude/plans/witty-swimming-willow.md for the
// full design rationale - this file is just the shape of that data.

export type JsonValue =
  string | number | boolean | null | JsonValue[] | {[key: string]: JsonValue}

// a small, pure, side-effect-free expression grammar (JSONLogic-shaped) - no
// user-defined functions, no imperative loops, no way to reach JS globals,
// eval, or the DOM. `helper` is the only escape hatch, and it only ever
// dispatches into a fixed, host-provided allowlist (see Renderer.tsx) - an
// addon can request a helper by name, never supply one.
//
// A plain array or object (one with none of the operator keys below) is a
// literal *container*, not a literal value on its own - each element/field
// is itself evaluated as an Expr (see expr.ts's evaluate). This is what
// lets e.g. note.split's `tickets` arg be written as a literal array of
// `{amountMsat: Expr, tags: [...]}` objects without needing a helper to
// build the whole structure. A literal object meant this way must not use
// `var`/`cat`/`and`/`gt`/`lte`/`helper` as one of its own field names -
// those are always read as the corresponding operator instead.
// note: a literal object (one with none of the operator keys) is also a
// valid Expr at runtime (see evaluate()) - not spelled out as its own
// union member here because TypeScript's structural typing would make it
// overlap with every operator shape below and defeat their discriminated-
// union narrowing (`'var' in expr` and friends). The specific shapes below
// remain the documented, type-checked ones to author against; a plain
// object literal is a deliberate, runtime-only escape hatch.
export type Expr =
  | string
  | number
  | boolean
  | null
  | Expr[]
  | {var: string}
  | {cat: Expr[]}
  | {and: Expr[]}
  | {gt: [Expr, Expr]}
  | {lte: [Expr, Expr]}
  | {helper: string; args: Expr[]}

// the only ways an event handler can affect anything: write to the addon's
// own declared state (never anyone else's), or invoke one pre-approved,
// host-implemented verb. There is no generic "run this code" action.
export type Action =
  | {action: 'set'; path: string; value: Expr}
  | {action: 'push'; path: string; value: Expr}
  | {action: 'removeAt'; path: string; index: Expr}
  | {verb: string; args: Record<string, Expr>; result?: string}

// fixed component vocabulary (v1: exactly what the raffle addon needs) -
// deliberately named after Solid's own control-flow primitives (Show/For)
// so the renderer maps a node onto a real Solid component/control-flow
// construct instead of reinventing rendering.
export type UiNode =
  | {type: 'View'; style?: string; children?: UiNode[]}
  | {type: 'Text'; value: Expr; style?: string}
  | {
      type: 'Input'
      bind: string
      kind?: 'text' | 'number' | 'checkbox'
      label?: string
    }
  | {
      type: 'NotePicker'
      bind: string
      filter?: {spent?: boolean}
      label?: string
    }
  | {type: 'Button'; label: string; onClick: Action}
  | {type: 'For'; each: Expr; children: UiNode[]}
  | {type: 'Show'; when: Expr; children: UiNode[]}
  | {type: 'QrDisplay'; value: Expr}

export type Permission = {verb: string; scope?: string; reason: string}

export type AddonNavEntry = {
  // left = .nav-links style (Wallet/Mint/Vault - always-labeled); right =
  // .nav-persistent style (Docs/Activity/Settings - icon, label on mobile)
  position: 'left' | 'right'
  label: string
  icon: string // key into icons.ts's fixed name -> component map
  route?: string // defaults to `/addons/${id}`
}

export type AddonManifest = {
  id: string
  name: string
  version: string
  icon: string
  description?: string
  permissions: Permission[]
  nav?: AddonNavEntry
  // page-local, in-memory, reset every time the addon's own page is opened
  state: Record<string, JsonValue>
  ui: UiNode
  // an addon MAY contribute a section to the Settings page - its own
  // separately-persisted state, rendered with a renderer that never wires
  // up a verb dispatcher at all (see Renderer.tsx), so a settings section
  // is structurally incapable of moving funds, by construction not by
  // convention
  settings?: {
    state: Record<string, JsonValue>
    ui: UiNode
  }
}

// pure functions only - no wallet/device access, no network, no DOM (one
// exception: PDF generation is legitimately async, so helpers may return a
// promise - evaluate() below awaits it either way). Each addon supplies its
// own (e.g. raffle's tierPreset/planTickets), looked up by name the same
// way verbs are, and never callable except via a `{helper, args}`
// expression node.
export type AddonHelper = (...args: never[]) => unknown | Promise<unknown>

export type Addon = {
  manifest: AddonManifest
  helpers: Record<string, AddonHelper>
}
