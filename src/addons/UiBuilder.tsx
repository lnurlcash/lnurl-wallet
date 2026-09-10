import type {Component} from 'solid-js'
import {createSignal, createMemo, Index, For, Show} from 'solid-js'
import type {Action, Expr, UiNode} from './types'
import {VERBS} from './verbs'
import {
  type NodePath,
  type ExprMode,
  type ActionMode,
  getNodeAt,
  childrenOf,
  isContainer,
  pathEquals,
  replaceNodeAt,
  insertChildAt,
  removeNodeAt,
  moveNode,
  defaultNodeFor,
  describeNode,
  inferExprMode,
  defaultExprFor,
  inferActionMode,
  defaultActionFor
} from './uiTree'

export type UiBuilderProps = {
  ui: UiNode
  onChange: (next: UiNode) => void
}

const NODE_TYPES: UiNode['type'][] = [
  'View',
  'Text',
  'Input',
  'NotePicker',
  'Button',
  'For',
  'Show',
  'QrDisplay'
]

// pure documentation, not a schema - the actual args stay a scoped JSON
// blob either way (see UiBuilder's own README-level comment above the
// ActionEditor's "Run verb" tier). Closes most of "looks guided, isn't"
// for a few lines, without pretending to validate anything
const VERB_HINTS: Record<string, string> = {
  'note.query':
    'args: {scope?: "spent:false" | "spent:true" | "tag:<value>"} - returns [{id, amountSat}]',
  'note.split':
    'args: {note: <a bearer-id Expr>, tickets: [{amountMsat, tags?: string[]}]}',
  'file.download':
    'args: {filename: <string Expr>, content: <string or bytes Expr>}'
}

type Row = {path: NodePath; node: UiNode; depth: number}

const flatten = (node: UiNode, path: NodePath, depth: number, out: Row[]) => {
  out.push({path, node, depth})
  childrenOf(node)?.forEach((child, i) =>
    flatten(child, [...path, i], depth + 1, out)
  )
}

// --- Expr sub-editor: Literal / Field / Advanced(JSON), see uiTree.ts's
// ExprMode - kept to exactly these three tiers on purpose, see
// src/addons/README.md / this session's plan for why a full visual
// composer for and/gt/lte/cat/helper is deliberately out of scope ---
type ExprEditorProps = {
  expr: Expr
  onChange: (next: Expr) => void
  label?: string
}

const ExprEditor: Component<ExprEditorProps> = props => {
  const [mode, setMode] = createSignal<ExprMode>(inferExprMode(props.expr))
  // the Advanced textarea's own buffer - NEVER derived from props.expr on
  // every render (that would fight the user's typing on any syntactically
  // incomplete intermediate JSON) - seeded once per mount/tab-switch, then
  // only ever updated by this field's own onInput
  const [advancedText, setAdvancedText] = createSignal(
    JSON.stringify(props.expr, null, 2)
  )
  const [advancedError, setAdvancedError] = createSignal(false)

  const switchMode = (next: ExprMode) => {
    if (next === 'advanced') {
      setAdvancedText(JSON.stringify(props.expr, null, 2))
      setAdvancedError(false)
    } else if (inferExprMode(props.expr) !== next) {
      props.onChange(defaultExprFor(next))
    }
    setMode(next)
  }

  const literalType = (): 'string' | 'number' | 'boolean' => {
    if (typeof props.expr === 'number') return 'number'
    if (typeof props.expr === 'boolean') return 'boolean'
    return 'string'
  }

  const fieldPath = (): string => {
    const v = props.expr
    return typeof v === 'object' &&
      v !== null &&
      !Array.isArray(v) &&
      'var' in v
      ? String(v.var ?? '')
      : ''
  }

  return (
    <div class="addon-field">
      <Show when={props.label}>{props.label}</Show>
      <div class="btns">
        <button
          type="button"
          classList={{active: mode() === 'literal'}}
          onClick={() => switchMode('literal')}
        >
          Literal
        </button>
        <button
          type="button"
          classList={{active: mode() === 'field'}}
          onClick={() => switchMode('field')}
        >
          Field
        </button>
        <button
          type="button"
          classList={{active: mode() === 'advanced'}}
          onClick={() => switchMode('advanced')}
        >
          Advanced
        </button>
      </div>

      <Show when={mode() === 'literal'}>
        <div class="btns">
          <button
            type="button"
            classList={{active: literalType() === 'string'}}
            onClick={() => props.onChange('')}
          >
            Text
          </button>
          <button
            type="button"
            classList={{active: literalType() === 'number'}}
            onClick={() => props.onChange(0)}
          >
            Number
          </button>
          <button
            type="button"
            classList={{active: literalType() === 'boolean'}}
            onClick={() => props.onChange(false)}
          >
            Yes/No
          </button>
        </div>
        <Show
          when={literalType() === 'boolean'}
          fallback={
            <input
              type={literalType() === 'number' ? 'number' : 'text'}
              value={props.expr == null ? '' : String(props.expr)}
              onInput={e =>
                props.onChange(
                  literalType() === 'number'
                    ? Number(e.currentTarget.value)
                    : e.currentTarget.value
                )
              }
            />
          }
        >
          <input
            type="checkbox"
            checked={Boolean(props.expr)}
            onChange={e => props.onChange(e.currentTarget.checked)}
          />
        </Show>
      </Show>

      <Show when={mode() === 'field'}>
        <input
          type="text"
          placeholder="dotted.path"
          value={fieldPath()}
          onInput={e => props.onChange({var: e.currentTarget.value})}
        />
      </Show>

      <Show when={mode() === 'advanced'}>
        <textarea
          class="addon-builder-textarea addon-builder-textarea-small"
          spellcheck={false}
          rows={4}
          value={advancedText()}
          onInput={e => {
            const text = e.currentTarget.value
            setAdvancedText(text)
            try {
              const parsed: unknown = JSON.parse(text)
              setAdvancedError(false)
              props.onChange(parsed as Expr)
            } catch {
              setAdvancedError(true)
            }
          }}
        />
        <Show when={advancedError()}>
          <p class="warning">Invalid JSON - not saved yet.</p>
        </Show>
      </Show>
    </div>
  )
}

// --- Action sub-editor: Path action (set/push) / Run verb / Advanced(JSON) ---
type ActionEditorProps = {
  action: Action
  onChange: (next: Action) => void
}

const ActionEditor: Component<ActionEditorProps> = props => {
  const verbNames = Object.keys(VERBS)
  const [mode, setMode] = createSignal<ActionMode>(
    inferActionMode(props.action)
  )
  const [advancedText, setAdvancedText] = createSignal(
    JSON.stringify(props.action, null, 2)
  )
  const [advancedError, setAdvancedError] = createSignal(false)
  const [argsText, setArgsText] = createSignal(
    'verb' in props.action ? JSON.stringify(props.action.args, null, 2) : '{}'
  )
  const [argsError, setArgsError] = createSignal(false)

  // mode()==='set'/'verb' is only ever reached via switchMode below, which
  // always brings props.action's shape along with it in the same update -
  // safe to cast rather than re-derive a runtime guard for every read
  const asPathAction = () =>
    props.action as Extract<Action, {action: 'set' | 'push'}>
  const asVerbAction = () => props.action as Extract<Action, {verb: string}>

  const switchMode = (next: ActionMode) => {
    if (next === 'advanced') {
      setAdvancedText(JSON.stringify(props.action, null, 2))
      setAdvancedError(false)
      setMode(next)
      return
    }
    if (inferActionMode(props.action) !== next) {
      const fresh = defaultActionFor(next, verbNames)
      props.onChange(fresh)
      if (next === 'verb' && 'verb' in fresh) {
        setArgsText(JSON.stringify(fresh.args, null, 2))
        setArgsError(false)
      }
    } else if (next === 'verb') {
      setArgsText(JSON.stringify(asVerbAction().args, null, 2))
      setArgsError(false)
    }
    setMode(next)
  }

  return (
    <div class="addon-field">
      <div class="btns">
        <button
          type="button"
          classList={{active: mode() === 'set'}}
          onClick={() => switchMode('set')}
        >
          Path action
        </button>
        <button
          type="button"
          classList={{active: mode() === 'verb'}}
          onClick={() => switchMode('verb')}
        >
          Run verb
        </button>
        <button
          type="button"
          classList={{active: mode() === 'advanced'}}
          onClick={() => switchMode('advanced')}
        >
          Advanced
        </button>
      </div>

      <Show when={mode() === 'set'}>
        <div class="btns">
          <button
            type="button"
            classList={{active: asPathAction().action === 'set'}}
            onClick={() => props.onChange({...asPathAction(), action: 'set'})}
          >
            Set
          </button>
          <button
            type="button"
            classList={{active: asPathAction().action === 'push'}}
            onClick={() => props.onChange({...asPathAction(), action: 'push'})}
          >
            Push
          </button>
        </div>
        <label>Path (state key, dotted for nested)</label>
        <input
          type="text"
          value={asPathAction().path}
          onInput={e =>
            props.onChange({...asPathAction(), path: e.currentTarget.value})
          }
        />
        <ExprEditor
          label="Value"
          expr={asPathAction().value}
          onChange={value => props.onChange({...asPathAction(), value})}
        />
      </Show>

      <Show when={mode() === 'verb'}>
        <label>Verb</label>
        <select
          value={asVerbAction().verb}
          onChange={e =>
            props.onChange({...asVerbAction(), verb: e.currentTarget.value})
          }
        >
          <For each={verbNames}>
            {name => <option value={name}>{name}</option>}
          </For>
        </select>
        <Show when={VERB_HINTS[asVerbAction().verb]}>
          <p class="addon-form-note">{VERB_HINTS[asVerbAction().verb]}</p>
        </Show>
        <label>Args (JSON)</label>
        <textarea
          class="addon-builder-textarea addon-builder-textarea-small"
          spellcheck={false}
          rows={4}
          value={argsText()}
          onInput={e => {
            const text = e.currentTarget.value
            setArgsText(text)
            try {
              const args: unknown = JSON.parse(text)
              setArgsError(false)
              props.onChange({
                ...asVerbAction(),
                args: args as Record<string, Expr>
              })
            } catch {
              setArgsError(true)
            }
          }}
        />
        <Show when={argsError()}>
          <p class="warning">Invalid JSON - not saved yet.</p>
        </Show>
        <label>
          Result (optional - state key to store the verb's return value)
        </label>
        <input
          type="text"
          value={asVerbAction().result ?? ''}
          onInput={e =>
            props.onChange({
              ...asVerbAction(),
              result: e.currentTarget.value || undefined
            })
          }
        />
      </Show>

      <Show when={mode() === 'advanced'}>
        <textarea
          class="addon-builder-textarea addon-builder-textarea-small"
          spellcheck={false}
          rows={6}
          value={advancedText()}
          onInput={e => {
            const text = e.currentTarget.value
            setAdvancedText(text)
            try {
              const parsed: unknown = JSON.parse(text)
              setAdvancedError(false)
              props.onChange(parsed as Action)
            } catch {
              setAdvancedError(true)
            }
          }}
        />
        <Show when={advancedError()}>
          <p class="warning">Invalid JSON - not saved yet.</p>
        </Show>
      </Show>
    </div>
  )
}

const AddChildPicker: Component<{
  onAdd: (type: UiNode['type']) => void
}> = props => {
  const [type, setType] = createSignal<UiNode['type']>('View')
  return (
    <>
      <select
        value={type()}
        onChange={e => setType(e.currentTarget.value as UiNode['type'])}
      >
        <For each={NODE_TYPES}>{t => <option value={t}>{t}</option>}</For>
      </select>
      <button
        type="button"
        class="icon-btn"
        onClick={() => props.onAdd(type())}
      >
        Add child
      </button>
    </>
  )
}

type NodeInspectorProps = {
  ui: UiNode
  path: NodePath
  onChange: (next: UiNode) => void
  onAddChild: (type: UiNode['type']) => void
  onDelete: () => void
  onMove: (dir: 'up' | 'down') => void
}

// remounted fresh exactly when the selected path changes (see UiBuilder's
// keyed Show below) - never as a side effect of editing the currently
// selected node itself, which is what keeps this component's own field-
// level state (which Expr/Action tab is showing) from silently carrying
// over onto a differently-shaped node
const NodeInspector: Component<NodeInspectorProps> = props => {
  const node = createMemo(() => getNodeAt(props.ui, props.path) as UiNode)
  const update = (next: UiNode) =>
    props.onChange(replaceNodeAt(props.ui, props.path, next))

  // a node's type never changes while it stays selected in this design -
  // only add/delete/move touch structure, and all three follow selection
  // to the affected node's new path rather than leaving a stale path
  // pointed at a since-changed shape (see uiTree.ts's moveNode/
  // insertChildAt/removeNodeAt contracts) - so it's safe to switch on the
  // type ONCE here rather than inside a reactive expression, which keeps
  // each field's own DOM (and focus) stable across edits to sibling
  // fields on the same node. Every individual field value below is still
  // read live through `node()` calls inline in JSX, so it stays reactive
  const type = node().type

  const fields = () => {
    switch (type) {
      case 'View': {
        const n = () => node() as Extract<UiNode, {type: 'View'}>
        return (
          <>
            <label>Style (optional)</label>
            <input
              type="text"
              value={n().style ?? ''}
              onInput={e =>
                update({...n(), style: e.currentTarget.value || undefined})
              }
            />
          </>
        )
      }
      case 'Text': {
        const n = () => node() as Extract<UiNode, {type: 'Text'}>
        return (
          <>
            <label>Style (optional)</label>
            <input
              type="text"
              value={n().style ?? ''}
              onInput={e =>
                update({...n(), style: e.currentTarget.value || undefined})
              }
            />
            <ExprEditor
              label="Value"
              expr={n().value}
              onChange={value => update({...n(), value})}
            />
          </>
        )
      }
      case 'Input': {
        const n = () => node() as Extract<UiNode, {type: 'Input'}>
        return (
          <>
            <label>Bind (state path)</label>
            <input
              type="text"
              value={n().bind}
              onInput={e => update({...n(), bind: e.currentTarget.value})}
            />
            <label>Kind</label>
            <select
              value={n().kind ?? 'text'}
              onChange={e =>
                update({
                  ...n(),
                  kind: e.currentTarget.value as 'text' | 'number' | 'checkbox'
                })
              }
            >
              <option value="text">text</option>
              <option value="number">number</option>
              <option value="checkbox">checkbox</option>
            </select>
            <label>Label (optional)</label>
            <input
              type="text"
              value={n().label ?? ''}
              onInput={e =>
                update({...n(), label: e.currentTarget.value || undefined})
              }
            />
          </>
        )
      }
      case 'NotePicker': {
        const n = () => node() as Extract<UiNode, {type: 'NotePicker'}>
        return (
          <>
            <label>Bind (state path)</label>
            <input
              type="text"
              value={n().bind}
              onInput={e => update({...n(), bind: e.currentTarget.value})}
            />
            <label>Filter</label>
            <select
              value={
                n().filter?.spent === undefined
                  ? 'any'
                  : n().filter!.spent
                    ? 'spent'
                    : 'unspent'
              }
              onChange={e => {
                const v = e.currentTarget.value
                update({
                  ...n(),
                  filter: v === 'any' ? undefined : {spent: v === 'spent'}
                })
              }}
            >
              <option value="any">Any</option>
              <option value="unspent">Unspent only</option>
              <option value="spent">Spent only</option>
            </select>
            <label>Label (optional)</label>
            <input
              type="text"
              value={n().label ?? ''}
              onInput={e =>
                update({...n(), label: e.currentTarget.value || undefined})
              }
            />
          </>
        )
      }
      case 'Button': {
        const n = () => node() as Extract<UiNode, {type: 'Button'}>
        return (
          <>
            <label>Label</label>
            <input
              type="text"
              value={n().label}
              onInput={e => update({...n(), label: e.currentTarget.value})}
            />
            <label>On click</label>
            <ActionEditor
              action={n().onClick}
              onChange={onClick => update({...n(), onClick})}
            />
          </>
        )
      }
      case 'For': {
        const n = () => node() as Extract<UiNode, {type: 'For'}>
        return (
          <ExprEditor
            label="Each (list to iterate)"
            expr={n().each}
            onChange={each => update({...n(), each})}
          />
        )
      }
      case 'Show': {
        const n = () => node() as Extract<UiNode, {type: 'Show'}>
        return (
          <ExprEditor
            label="When (condition)"
            expr={n().when}
            onChange={when => update({...n(), when})}
          />
        )
      }
      case 'QrDisplay': {
        const n = () => node() as Extract<UiNode, {type: 'QrDisplay'}>
        return (
          <ExprEditor
            label="Value"
            expr={n().value}
            onChange={value => update({...n(), value})}
          />
        )
      }
    }
  }

  return (
    <div>
      <p class="bearer-label">{describeNode(node())}</p>
      <div class="btns">
        <Show when={isContainer(node())}>
          <AddChildPicker onAdd={props.onAddChild} />
        </Show>
        <Show when={props.path.length > 0}>
          <button type="button" class="icon-btn" onClick={props.onDelete}>
            Delete
          </button>
          <button
            type="button"
            class="icon-btn"
            onClick={() => props.onMove('up')}
          >
            Move up
          </button>
          <button
            type="button"
            class="icon-btn"
            onClick={() => props.onMove('down')}
          >
            Move down
          </button>
        </Show>
      </div>

      {fields()}

      <p class="addon-form-note">
        Nested and/gt/lte/cat/helper expressions and verb args aren't visually
        composed here - use Advanced (JSON) for those.
      </p>
      <p class="addon-form-note">
        No in-place type conversion - delete and add a new node to change a
        node's type.
      </p>
    </div>
  )
}

const UiBuilder: Component<UiBuilderProps> = props => {
  const [selectedPath, setSelectedPath] = createSignal<NodePath>([])

  const rows = createMemo(() => {
    const out: Row[] = []
    flatten(props.ui, [], 0, out)
    return out
  })

  const addChild = (containerPath: NodePath, type: UiNode['type']) => {
    const {tree, path} = insertChildAt(
      props.ui,
      containerPath,
      defaultNodeFor(type)
    )
    props.onChange(tree)
    setSelectedPath(path)
  }

  const remove = (path: NodePath) => {
    if (path.length === 0) return
    props.onChange(removeNodeAt(props.ui, path))
    setSelectedPath(path.slice(0, -1))
  }

  const move = (path: NodePath, dir: 'up' | 'down') => {
    const result = moveNode(props.ui, path, dir)
    if (result.tree === props.ui) return
    props.onChange(result.tree)
    setSelectedPath(result.path)
  }

  return (
    <div class="ui-builder">
      <div class="ui-outliner">
        {/* <Index>, not <For>: Settings.tsx's patchDraft round-trips every
        edit through JSON.stringify/JSON.parse, so props.ui (and therefore
        every row object flatten() builds) gets a brand-new identity on
        every keystroke anywhere in the tree. A <For> keys by reference and
        would tear down/rebuild every row's DOM - including whatever input
        currently has focus - on every keystroke. <Index> is positionally
        stable regardless of value identity, which is correct here since
        insert/delete/move already reflow position anyway. */}
        <Index each={rows()}>
          {row => (
            <button
              type="button"
              class="ui-outliner-row"
              style={{'padding-left': `${row().depth * 16}px`}}
              classList={{selected: pathEquals(row().path, selectedPath())}}
              onClick={() => setSelectedPath(row().path)}
            >
              {describeNode(row().node)}
            </button>
          )}
        </Index>
      </div>
      <div class="ui-inspector">
        {/* keyed: remount specifically when the selected PATH changes (a
        click, or an add/delete/move that follows selection), never as a
        side effect of an edit inside the currently-selected node - see
        NodeInspector's own comment for why that distinction matters */}
        <Show when={selectedPath()} keyed>
          {path => (
            <NodeInspector
              ui={props.ui}
              path={path}
              onChange={props.onChange}
              onAddChild={type => addChild(path, type)}
              onDelete={() => remove(path)}
              onMove={dir => move(path, dir)}
            />
          )}
        </Show>
      </div>
    </div>
  )
}

export default UiBuilder
