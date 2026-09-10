# Addons

> **Alpha, since v0.11.0.** This is a new code path through the wallet's
> core note-splitting logic. An addon can split and tag your notes on your
> behalf - if you don't understand what an addon's declared permissions
> actually let it do, don't enable it. There is no backend here that can
> freeze or reverse anything: a bug in this system, or in an addon built on
> top of it, can cost real funds with no recovery path. Read this file
> before writing or reviewing one.

## What an addon actually is

An addon is **JSON data that this file's own trusted renderer interprets -
never code that runs.** There is no scripting language, no `eval`, no
sandboxed VM. A manifest describes a UI tree (a fixed set of components), a
small pure expression grammar for binding/computed values, and a fixed
allowlist of host-implemented "verbs" for anything that actually touches a
note. If a manifest can't express something with these three things, the
fix is to extend the fixed vocabulary (in this directory, reviewed like any
other code change) - not to add a way to run arbitrary logic.

This design choice is deliberate, not a limitation we plan to lift later:
see the design rationale saved as a Claude Code plan at
`/home/user/.claude/plans/witty-swimming-willow.md` if you want the full
reasoning (Shopify Liquid / JSONLogic / object-capability precedent, and why
a real interpreter was rejected for a wallet with no backend to recover
from a mistake).

## File layout

```
src/addons/
  types.ts          # AddonManifest, UiNode, Expr, Action - the DSL's shape
  expr.ts           # evaluate() - the safe expression evaluator
  verbs.ts          # VERBS - the only way a manifest can touch real notes
  globalHelpers.ts   # helpers available to every addon (arithmetic, sat/msat)
  Renderer.tsx        # AddonRenderer - maps a manifest onto real Solid components
  icons.ts            # icon name -> component map (manifests never import icons directly)
  registry.ts         # ADDONS (bundled) + allAddons() (bundled + custom)
  enabled.ts           # which addons a holder turned on (localStorage)
  settingsStore.ts     # per-addon persisted settings (localStorage)
  customAddons.ts       # holder-authored/edited addon manifests (localStorage)
  validate.ts            # validateManifest() - structural checks for a custom manifest
  starterTemplate.ts      # the "+ New custom addon" starting-point JSON
  raffle/                 # the one bundled addon that exists today - a worked example
    lottery.ts               # pure prize-tier/shuffle math, no wallet access
    pdf.ts                    # PDF rendering (pdf-lib/qrcode, dynamically imported)
    manifest.ts               # the actual AddonManifest + helpers for this addon
```

Plus the pages that use all this: `src/pages/Settings.tsx`'s "Addons" column
(enable/disable, permissions list, and the custom-addon builder/editor - see
"Custom addons (the builder)" below) and `src/pages/AddonRun.tsx` (runs one
addon's `ui`, at `/addons/:addonId`).

## The manifest

```ts
type AddonManifest = {
  id: string // stable, never changes - used for storage keys and tags
  name: string
  version: string
  icon: string // key into icons.ts
  description?: string
  permissions: {verb: string; scope?: string; reason: string}[]
  nav?: {
    position: 'left' | 'right'
    label: string
    icon: string
    route?: string
  }
  state: Record<string, JsonValue> // page-local, in-memory, reset per visit
  ui: UiNode
  settings?: {
    state: Record<string, JsonValue> // persisted per addon, across reloads
    ui: UiNode // rendered in Settings.tsx - see "Settings sections" below
  }
}
```

- **`permissions`** is shown to the holder in plain language on `/settings`
  before they turn the addon on. It's not currently enforced at runtime
  against the manifest's own `ui`/verbs (there's exactly one, first-party,
  reviewed manifest today) - it exists so a human reviewing or enabling an
  addon can tell what it's for. Keep it accurate.
- **`nav`** puts a link in the navbar while the addon is enabled -
  `'left'` joins Wallet/Mint/Vault (always-labeled), `'right'` joins
  Docs/Activity/Settings (icon, label on mobile). Omit it if the addon
  doesn't need its own nav entry.
- **`state`** is the addon's own page - seeded from `manifest.state`, then
  (for `'run'` mode specifically) overridden by whatever `AddonRun.tsx`
  merges in before mount (a fresh `runId`, the holder's persisted
  `settings`). It's just a plain object; `Renderer.tsx` wraps it in a Solid
  `createStore`.

## The UI tree (`UiNode`)

A fixed component vocabulary, deliberately named after Solid's own
control-flow primitives so `Renderer.tsx` maps each node onto a real Solid
component instead of reinventing rendering:

| Type         | Purpose                                                            |
| ------------ | ------------------------------------------------------------------ |
| `View`       | a `<div>`; `style` picks a CSS class (`addon-<style>`)             |
| `Text`       | renders one `Expr` as text                                         |
| `Input`      | text/number/checkbox, two-way bound via `bind`                     |
| `NotePicker` | pick a held note; binds `{id, amountSat}` - never the note's url   |
| `Button`     | `onClick` runs one `Action`                                        |
| `For`        | iterate an array `Expr`; `item`/`index` in scope for its children  |
| `Show`       | render children when an `Expr` is truthy                           |
| `QrDisplay`  | renders an `Expr`'s value as a QR code (wraps `components/Qr.tsx`) |

New components are added here, in this file, when a real need shows up -
never by an addon manifest.

### `bind` inside a `For`

`bind="item.count"` on an `Input` nested inside a `For each={{var: "tiers"}}`
writes back into that exact array element live - see `Renderer.tsx`'s
`__writeItem`. This only works when `each` is a plain `{"var": "path"}`
pointing at a real state field (so the renderer knows where to write back
to); a computed/derived list (e.g. a helper's return value) still renders,
it just isn't editable in place.

## The expression grammar (`Expr`)

Small, pure, side-effect-free, JSONLogic-shaped. **No user-defined
functions, no imperative loops as code, no way to reach JS globals, `eval`,
or the DOM.**

```
{"var": "path.to.value"}          -- read a value (dot path)
{"cat": [Expr, ...]}                -- string concatenation
{"and": [Expr, ...]}                -- boolean AND
{"gt": [Expr, Expr]}                 -- greater than
{"lte": [Expr, Expr]}                -- less than or equal
{"helper": "name", "args": [Expr]}   -- call a named, fixed helper
"a literal string/number/boolean/null value"
[Expr, ...]                          -- a literal array, each element evaluated
{"anyOtherKey": Expr, ...}            -- a literal object, each field evaluated
```

The last two exist so a manifest can build a structured value (most
notably `note.split`'s `tickets` arg - a list of `{amountMsat, tags}`
objects) directly out of literal JSON without needing a helper to
assemble it. A plain object is only ever read this way when it has
**none** of the operator keys above - don't name a literal field `var`,
`cat`, `and`, `gt`, `lte`, or `helper`, or it'll be read as that operator
instead. (This pair isn't a formal member of the `Expr` TypeScript type in
`types.ts` - adding it there made every operator shape structurally
overlap and broke their `'var' in expr`-style narrowing throughout
`expr.ts`. It's a deliberate, documented, runtime-only escape hatch;
`evaluate()`'s own fallback branch is where it's actually implemented.)

`{"var": "index"}` inside a `For` resolves against Solid's own live index
accessor rather than the tree, so it stays correct across a reorder (e.g.
removing an earlier item) - see `Renderer.tsx`'s `resolveExpr`.

**If you're editing `Renderer.tsx`:** never precompute the result of
`evaluate()`/`resolveExpr()` into a `const` before returning JSX. Solid's
fine-grained reactivity for a JSX attribute only tracks reads that happen
_inline, textually inside the JSX expression itself_ - dereferencing a
value into a plain variable first takes a one-time snapshot that silently
stops updating. Every existing case in `Renderer.tsx` calls
`resolveExpr(...)` directly inside the attribute/child position for this
reason; keep new ones the same way.

## Helpers

Pure functions an addon supplies (e.g. raffle's `tierPreset`/`planTickets`
in `raffle/lottery.ts`), called only via `{"helper": "name", "args": [...]}`.
A helper never gets wallet/device access, network access, or DOM access -
it takes plain data in, returns plain data (or a `Promise` of plain data;
see `raffle/pdf.ts` for the one legitimately-async helper, PDF generation,
dynamically `import()`-ed so `pdf-lib`/`qrcode` don't bloat the main bundle
for holders who never open an addon).

If a helper needs something a pure function can't do (reading wallet state,
touching the network, moving a note), that's a sign it should be a **verb**
instead, not a bigger helper.

### Global helpers

`globalHelpers.ts`'s `GLOBAL_HELPERS` are merged into _every_ addon's
helper lookup (bundled or custom), ahead of the addon's own - because the
expression grammar has no arithmetic operators, a custom addon (which has
no helpers of its own; see below) couldn't otherwise even convert a
holder-typed sat amount into the msat `note.split` expects:

- `satsToMsat(sats)` / `msatToSats(msat)`
- `add(...ns)`, `sub(a, b)`, `mul(a, b)`, `div(a, b)`, `round(n)`

Keep this list small and generic - anything addon-specific belongs in that
addon's own `helpers`, not here.

## Verbs - the only way to touch a real note

`verbs.ts`'s `VERBS` is the fixed, host-implemented allowlist:

- **`note.query`** - read notes (`bearers()`), filtered by a tiny fixed
  `scope` mini-language (`"spent:false"`, `"tag:<value>"`) - never a real
  query language, never returns a raw url.
- **`note.split`** - wraps `noteSplitting.ts`'s `splitBearerIntoAmounts`
  (the same hardened split/fee/error-recovery logic `Wallet.tsx`'s own
  multi-split UI uses - not a second implementation). **Every resulting
  note is unconditionally tagged** with the calling addon's name and a
  stable `addon-<id>` tag (see `buildTicketLabel`), on top of whatever tags
  the addon itself asked for - this is a host guarantee an addon cannot opt
  out of or spoof, so Wallet.tsx's own tag filter can always find
  "everything this addon made," by id (survives a name change) or by name.
- **`file.download`** - saves a `Blob` via a synthetic `<a download>`, same
  pattern `storage.ts`'s backup download already uses.

A verb's _implementation_ lives entirely here, in trusted host code. An
addon only ever supplies plain-data arguments (a note by opaque id, a list
of amounts) and gets plain-data results back - it cannot name or reach
`WalletContext`, the AES key, or `DeviceContext`'s raw `client`, because
those never appear anywhere in the manifest's own scope.

**Adding a verb** means adding a new fixed capability every addon can ask
to use - treat it with the same care as adding a new wallet-wide action, not
like adding a helper.

## Settings sections

`manifest.settings` lets an addon contribute a section to `/settings`,
persisted separately from the addon's own page state (`settingsStore.ts`,
one localStorage key per addon). `Renderer.tsx`'s `'settings'` mode **never
wires up a verb dispatcher at all** - a `verb` action found in a
`settings.ui` tree is structurally inert, not just discouraged. A settings
section can change what an addon remembers between visits; it cannot move
funds, by construction.

## Custom addons (the builder)

`/settings`'s "Addons" column has a "Build your own addon" card: a raw-JSON
editor (`Settings.tsx`), not a drag-and-drop tool - a manifest is data, so
the editor is exactly the data itself, validated before it's accepted.

- **Storage**: `customAddons.ts`, one localStorage array of `AddonManifest`
  (JSON only). A custom addon shows up in the same enable/disable list as
  bundled ones (`registry.ts`'s `allAddons()`), marked "custom," with
  **Edit** (reopens the editor pre-filled) and **Delete** buttons bundled
  addons don't get. Each addon's own `settings.ui` (if it has one) renders
  right inside its own card, inline, rather than as a separate section.
- **Validation**: `validate.ts`'s `validateManifest()` walks the whole
  shape - top-level fields, every `UiNode` recursively, every `Expr`
  recursively, every `Action` (rejecting an `onClick.verb` that isn't in
  `VERBS`) - and throws a specific, human-readable error on the first
  problem found, rather than a generic parse failure. It does **not**
  re-implement or duplicate any runtime logic; it only checks the shape
  matches what `Renderer.tsx`/`expr.ts` already expect.
- **No helpers**: a custom addon has no `helpers` module (that's TS code;
  a manifest can't ship one) - it gets `GLOBAL_HELPERS` and the fixed verb
  allowlist, same as any addon, but never an addon-specific helper like
  raffle's `planTickets`. If a custom addon idea needs more than
  `GLOBAL_HELPERS` + the literal-array/object Expr trick above can express,
  that's a sign it wants to become a real, reviewed, bundled addon instead.
- **Id collisions**: a custom addon's `id` can never match a bundled one's
  (`registry.ts`'s `isBundledAddon`) - it would otherwise be genuinely
  ambiguous which one a nav link/route/tag referred to.

**This is where "no code, only data" earns its keep.** A holder can, in
principle, paste in JSON someone else wrote (there's no technical barrier -
it's still just a `.txt`-shaped blob of data to copy around by hand). The
structural guarantee holds regardless of who wrote it: the worst a pasted
manifest can do is exactly what its own `permissions` list says, shown
before it's ever enabled - it cannot execute anything unexpected, because
there is nothing in it _to_ execute. What it doesn't get from being pasted
rather than bundled is review: nobody but the holder checked that its
`permissions` list is honest, or that its logic does something worth
enabling in the first place. Treat a pasted-in manifest exactly as
skeptically as you'd treat a stranger's shell script - the sandboxing here
is real, but it's not a substitute for reading what a thing claims to do
before turning it on.

## Distribution beyond copy/paste

A holder pasting JSON by hand (above) is manual and small-scale. Actually
_fetching_ a manifest from a URL, with pin-on-first-import and
staged-review-on-change (the way `trustedMints.ts` already handles the
identically-shaped problem for mint signing keys), is a deliberately
separate, not-yet-built initiative - see the plan doc's "Distribution &
trust" section for that design. Nothing about the current design blocks it
later; nothing here should be loosened to make it easier without doing
that work first.

## Adding a new addon

**As JSON, via the builder** - just write it against the shapes above
(`starterTemplate.ts` is a working starting point) and save it on `/settings`.
No code change needed unless it needs something `GLOBAL_HELPERS` and the
fixed verb allowlist can't express.

**As a new bundled addon** (when a custom one outgrows what helper-less
JSON can do - e.g. it needs its own pure logic like raffle's shuffle):

1. New directory `src/addons/<id>/` - a `manifest.ts` exporting an
   `Addon` (`{manifest, helpers}`), plus whatever pure logic modules the
   helpers need (see `raffle/lottery.ts` for the shape: no wallet imports,
   no network calls, `crypto.getRandomValues` and plain math only).
2. Add it to `registry.ts`'s `ADDONS` array.
3. Write accurate `permissions` - this is the only thing a holder sees
   before enabling it.
4. If it needs a new UI component or expression operator the fixed
   vocabulary doesn't have, extend `types.ts`/`Renderer.tsx`/`expr.ts`
   first, as their own reviewed change - don't work around a missing
   primitive by stuffing more logic into a "helper."
5. If it needs to touch notes in a way `note.query`/`note.split` can't
   express, that's a new verb in `verbs.ts`, not a new helper.
