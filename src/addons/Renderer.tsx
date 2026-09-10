import type {Component, JSX} from 'solid-js'
import {Show, For} from 'solid-js'
import {createStore, produce} from 'solid-js/store'
import {useWallet} from '../WalletContext'
import {useDevice} from '../DeviceContext'
import {requireDeviceClient} from '../deviceOrchestration'
import {notify, NotifyKind} from '../helpers'
import Qr from '../components/Qr'
import {evaluate, type EvalContext} from './expr'
import {VERBS, type VerbContext} from './verbs'
import {GLOBAL_HELPERS} from './globalHelpers'
import type {Action, Addon, Expr, UiNode} from './types'

export type AddonRendererProps = {
  addon: Addon
  mode: 'run' | 'settings'
  // 'settings' mode persists through these instead of an in-memory store,
  // so a holder's addon preferences survive a reload - same shape
  // addonSettingsStore.ts's factory returns
  settingsStore?: [
    () => Record<string, unknown>,
    (value: Record<string, unknown>) => void
  ]
  // 'run' mode: the caller (AddonRun.tsx) merges the addon's persisted
  // settings over manifest.state's defaults before mount, e.g. so a raffle
  // run starts with the holder's usual `showAmount`/`paper` preference -
  // it's a one-time seed, not a live binding, so it can be freely
  // overridden per-run without writing back to the settings store
  initialState?: Record<string, unknown>
}

// vars carried through the render tree - the store's own fields at the
// root, plus (inside a For) the current item and a way to write back to it.
// __indexOf is Solid's own <For> index accessor, kept as a live function
// rather than a resolved number - <For> reuses a persisting item's render
// call across a reorder (e.g. removing an earlier tier), so a number
// captured once at render time would go stale the moment a sibling item is
// removed; see resolveExpr's special case for "index" below.
type Vars = Record<string, unknown> & {
  __writeItem?: (field: string, value: unknown) => void
  __indexOf?: () => number
}

const AddonRenderer: Component<AddonRendererProps> = props => {
  const wallet = useWallet()
  const {client: deviceClient} = useDevice()
  // global helpers first, so an addon's own (e.g. raffle's tierPreset)
  // could in principle shadow one by name, though none do today
  const helpers = {...GLOBAL_HELPERS, ...props.addon.helpers}

  const initial =
    props.mode === 'settings'
      ? (props.settingsStore?.[0]() ??
        props.addon.manifest.settings?.state ??
        {})
      : (props.initialState ?? props.addon.manifest.state)

  const [store, setStore] = createStore<Record<string, unknown>>(
    structuredClone(initial)
  )

  // 'settings' mode has no verb table at all - a verb action there is
  // structurally inert, not just discouraged, so a settings section can
  // never move funds regardless of what its manifest asks for
  const runVerb = async (
    name: string,
    rawArgs: Record<string, Expr>,
    vars: Vars
  ): Promise<unknown> => {
    if (props.mode === 'settings') {
      throw new Error('Settings cannot perform wallet actions.')
    }
    const handler = VERBS[name]
    if (!handler) throw new Error(`Unknown addon verb: ${name}`)
    const args: Record<string, unknown> = {}
    for (const [key, expr] of Object.entries(rawArgs)) {
      const value = resolveExpr(expr, vars)
      args[key] = value instanceof Promise ? await value : value
    }
    const ctx: VerbContext = {
      bearers: wallet.bearers,
      addBearer: wallet.addBearer,
      updateBearer: wallet.updateBearer,
      removeBearer: wallet.removeBearer,
      logActivity: wallet.logActivity,
      deviceClient,
      requireDeviceClient,
      // identifies the addon actually rendering right now - never
      // addon-suppliable (it comes from props.addon, not args), so a
      // verb's own tagging guarantees (see note.split) can't be spoofed
      addon: {id: props.addon.manifest.id, name: props.addon.manifest.name}
    }
    return handler(args, ctx)
  }

  const persistSettings = () => {
    if (props.mode === 'settings') props.settingsStore?.[1]({...store})
  }

  const runAction = async (action: Action, vars: Vars): Promise<void> => {
    try {
      if ('verb' in action) {
        const result = await runVerb(action.verb, action.args, vars)
        if (action.result) setStore(action.result, result)
        return
      }
      const path = action.path.split('.')
      if (action.action === 'set') {
        const value = resolveExpr(action.value, vars)
        setStore(...(path as [string]), value)
      } else if (action.action === 'push') {
        const value = resolveExpr(action.value, vars)
        setStore(
          produce(s => {
            const arr = path.reduce<any>((acc, key) => acc[key], s)
            arr.push(value)
          })
        )
      } else if (action.action === 'removeAt') {
        const index = Number(resolveExpr(action.index, vars))
        setStore(
          produce(s => {
            const arr = path.reduce<any>((acc, key) => acc[key], s)
            arr.splice(index, 1)
          })
        )
      }
      persistSettings()
    } catch (err) {
      notify((err as Error).message, NotifyKind.ERROR)
    }
  }

  const evalCtx = (vars: Vars): EvalContext => ({vars, helpers})

  // like evaluate(), but resolves {"var": "index"} against <For>'s own
  // live index accessor when one is in scope, instead of a plain lookup -
  // see Vars's own comment on __indexOf for why a snapshotted number isn't
  // safe here
  const resolveExpr = (expr: Expr, vars: Vars): unknown => {
    if (
      typeof expr === 'object' &&
      expr !== null &&
      'var' in expr &&
      expr.var === 'index' &&
      vars.__indexOf
    ) {
      return vars.__indexOf()
    }
    return evaluate(expr, evalCtx(vars))
  }

  // reads a possibly-dotted bind path, resolving "item.<field>" against the
  // current For item rather than the root store
  const readBind = (bind: string, vars: Vars): unknown =>
    resolveExpr({var: bind}, vars)

  const writeBind = (bind: string, value: unknown, vars: Vars): void => {
    if (bind.startsWith('item.') && vars.__writeItem) {
      vars.__writeItem(bind.slice('item.'.length), value)
    } else {
      setStore(...(bind.split('.') as [string]), value)
    }
    persistSettings()
  }

  const renderChildren = (children: UiNode[] | undefined, vars: Vars) => (
    <For each={children ?? []}>{child => renderNode(child, vars)}</For>
  )

  const renderNode = (node: UiNode, vars: Vars): JSX.Element => {
    switch (node.type) {
      case 'View':
        return (
          <div classList={{[`addon-${node.style}`]: !!node.style}}>
            {renderChildren(node.children, vars)}
          </div>
        )

      case 'Text':
        return (
          <p classList={{[`addon-${node.style}`]: !!node.style}}>
            {String(resolveExpr(node.value, vars) ?? '')}
          </p>
        )

      case 'Input': {
        // NOT precomputed to a plain const - Solid's fine-grained
        // reactivity for a JSX attribute only kicks in for reads that
        // happen inline, textually inside the JSX expression itself
        // (compiled into a reactive getter); a value dereferenced into a
        // local variable first is a one-time snapshot that never updates
        // again, e.g. a preset button changing `tiers` would never be
        // reflected back into these rendered inputs
        const readRaw = () => readBind(node.bind, vars)
        if (node.kind === 'checkbox') {
          return (
            <label class="addon-field">
              <input
                type="checkbox"
                checked={Boolean(readRaw())}
                onChange={e =>
                  writeBind(node.bind, e.currentTarget.checked, vars)
                }
              />
              {node.label ? <>&nbsp;{node.label}</> : null}
            </label>
          )
        }
        return (
          <label class="addon-field">
            <Show when={node.label}>{node.label}</Show>
            <input
              type={node.kind === 'number' ? 'number' : 'text'}
              value={readRaw() == null ? '' : String(readRaw())}
              onInput={e => {
                const v = e.currentTarget.value
                writeBind(
                  node.bind,
                  node.kind === 'number' ? Number(v) : v,
                  vars
                )
              }}
            />
          </label>
        )
      }

      case 'NotePicker': {
        const bearers = wallet.bearers()
        const options = bearers.filter(b =>
          node.filter?.spent === undefined
            ? true
            : Boolean(b.spent) === node.filter.spent
        )
        // the bound value is {id, amountSat} - a small opaque-enough
        // summary resolved once at selection time - never the note's real
        // url/k1, and never a bare id an addon would need a wallet-reading
        // helper to make sense of (keeps every helper genuinely pure, no
        // wallet access at all). Read lazily (see the Input case above) -
        // not precomputed - so this stays in sync if state changes some
        // other way (e.g. a future "clear form" action)
        const readSelected = () =>
          readBind(node.bind, vars) as {id: string} | null
        return (
          <label class="addon-field">
            <Show when={node.label}>{node.label}</Show>
            <select
              value={readSelected()?.id ?? ''}
              onChange={e => {
                const id = e.currentTarget.value
                const found = id ? bearers.find(b => b.id === id) : undefined
                writeBind(
                  node.bind,
                  found
                    ? {id: found.id, amountSat: Math.floor(found.amount / 1000)}
                    : null,
                  vars
                )
              }}
            >
              <option value="">Select a note...</option>
              <For each={options}>
                {b => (
                  <option value={b.id}>
                    {Math.floor(b.amount / 1000).toLocaleString()} sats
                  </option>
                )}
              </For>
            </select>
          </label>
        )
      }

      case 'Button':
        return (
          <button
            type="button"
            onClick={() => void runAction(node.onClick, vars)}
          >
            {node.label}
          </button>
        )

      case 'For': {
        // two-way item binding only works when the list comes straight
        // from a top-level state field (a plain `{"var": "path"}`) - the
        // renderer then knows exactly where to write an edited field back.
        // A computed/derived list (e.g. a helper's return value) still
        // renders fine, it just isn't editable in place - not needed by
        // anything in v1 (raffle only edits `tiers`, a direct state field;
        // `results` is read-only). Inspects the Expr's static shape, not
        // its evaluated value, so this is a plain (non-reactive) check.
        const basePath =
          typeof node.each === 'object' &&
          node.each !== null &&
          'var' in node.each
            ? node.each.var
            : null
        return (
          // the each expression is evaluated directly in this JSX
          // position (not precomputed to a variable first, see the Input
          // case's own note above) so <For> re-runs when the underlying
          // store array actually changes
          <For each={(resolveExpr(node.each, vars) as unknown[]) ?? []}>
            {(item, index) => {
              // `item` stays the store's own live element reference
              // (reactive field-by-field) rather than a spread snapshot,
              // which would freeze every field at its value when this
              // callback last ran. `index` is exposed only through
              // __indexOf (resolveExpr's special case), never as a plain
              // snapshot - <For> reuses a persisting item's callback
              // across a reorder, so a number captured here would go
              // stale the moment an earlier sibling is removed
              const itemVars: Vars = {
                ...vars,
                item: item as object,
                __indexOf: index,
                __writeItem: basePath
                  ? (field, value) => {
                      setStore(
                        produce(s => {
                          const arr = (s as Record<string, unknown[]>)[
                            basePath
                          ] as Record<string, unknown>[]
                          arr[index()]![field] = value
                        })
                      )
                      persistSettings()
                    }
                  : undefined
              }
              return renderChildren(node.children, itemVars)
            }}
          </For>
        )
      }

      case 'Show':
        return (
          <Show when={Boolean(resolveExpr(node.when, vars))}>
            {renderChildren(node.children, vars)}
          </Show>
        )

      case 'QrDisplay':
        return <Qr value={String(resolveExpr(node.value, vars) ?? '')} />
    }
  }

  const ui =
    props.mode === 'settings'
      ? props.addon.manifest.settings?.ui
      : props.addon.manifest.ui

  return (
    <div class="addon-root">
      <Show when={ui}>{node => renderNode(node(), store)}</Show>
    </div>
  )
}
export default AddonRenderer
