// Pure tree helpers backing the Visual tab of the addon builder
// (Settings.tsx -> UiBuilder.tsx). No Solid imports - these operate on
// plain UiNode trees the exact same way validate.ts's isUiNode walks them,
// just for editing rather than validating. Every mutation returns a NEW
// tree (structural sharing of untouched subtrees) rather than mutating in
// place - see uiTree.test.ts's frozen-fixture checks for why that's
// enforced, not just documented.
import type {Action, Expr, UiNode} from './types'

export type NodePath = number[]

export const isContainer = (
  node: UiNode
): node is Extract<UiNode, {type: 'View' | 'For' | 'Show'}> =>
  node.type === 'View' || node.type === 'For' || node.type === 'Show'

export const childrenOf = (node: UiNode): UiNode[] | undefined =>
  isContainer(node) ? (node.children ?? []) : undefined

export const getNodeAt = (root: UiNode, path: NodePath): UiNode | undefined => {
  let node: UiNode | undefined = root
  for (const index of path) {
    if (!node) return undefined
    node = childrenOf(node)?.[index]
  }
  return node
}

export const pathEquals = (
  a: NodePath,
  b: NodePath | null | undefined
): boolean => !!b && a.length === b.length && a.every((v, i) => v === b[i])

// path=[] replaces the root outright. Throws on a path that doesn't
// resolve - the UI must never hold a stale path (see UiBuilder.tsx's
// selection-tracking, which keeps selectedPath in lockstep with every
// mutation specifically so this never happens from a user action)
export const replaceNodeAt = (
  root: UiNode,
  path: NodePath,
  next: UiNode
): UiNode => {
  if (path.length === 0) return next
  if (!isContainer(root)) {
    throw new Error('replaceNodeAt: path continues past a leaf node')
  }
  const [index, ...rest] = path as [number, ...number[]]
  const child = root.children?.[index]
  if (child === undefined) {
    throw new Error(`replaceNodeAt: no node at path segment ${index}`)
  }
  const children = (root.children ?? []).slice()
  children[index] = replaceNodeAt(child, rest, next)
  return {...root, children}
}

export const insertChildAt = (
  root: UiNode,
  containerPath: NodePath,
  child: UiNode,
  index?: number
): {tree: UiNode; path: NodePath} => {
  const container = getNodeAt(root, containerPath)
  if (!container || !isContainer(container)) {
    throw new Error('insertChildAt: target path is not a container node')
  }
  const children = (container.children ?? []).slice()
  const insertAt = index === undefined ? children.length : index
  children.splice(insertAt, 0, child)
  const tree = replaceNodeAt(root, containerPath, {...container, children})
  return {tree, path: [...containerPath, insertAt]}
}

// throws on path=[] - the outliner must never render a delete button on
// the root row; this is defense in depth for that
export const removeNodeAt = (root: UiNode, path: NodePath): UiNode => {
  if (path.length === 0)
    throw new Error('removeNodeAt: cannot remove the root node')
  const parentPath = path.slice(0, -1)
  const index = path[path.length - 1]!
  const parent = getNodeAt(root, parentPath)
  if (!parent || !isContainer(parent)) {
    throw new Error('removeNodeAt: parent path is not a container node')
  }
  const children = (parent.children ?? []).slice()
  children.splice(index, 1)
  return replaceNodeAt(root, parentPath, {...parent, children})
}

// swaps with the previous/next sibling. Returns the SAME tree reference at
// a boundary (first child moved up, or last moved down) so the caller can
// skip onChange (and skip touching selection) on a no-op move
export const moveNode = (
  root: UiNode,
  path: NodePath,
  dir: 'up' | 'down'
): {tree: UiNode; path: NodePath} => {
  if (path.length === 0) return {tree: root, path}
  const parentPath = path.slice(0, -1)
  const index = path[path.length - 1]!
  const parent = getNodeAt(root, parentPath)
  if (!parent || !isContainer(parent)) {
    throw new Error('moveNode: parent path is not a container node')
  }
  const swapWith = dir === 'up' ? index - 1 : index + 1
  const siblings = parent.children ?? []
  if (swapWith < 0 || swapWith >= siblings.length) return {tree: root, path}
  const children = siblings.slice()
  ;[children[index], children[swapWith]] = [
    children[swapWith]!,
    children[index]!
  ]
  const tree = replaceNodeAt(root, parentPath, {...parent, children})
  return {tree, path: [...parentPath, swapWith]}
}

// an unconfigured node, if saved by accident, must be inert rather than
// surprising - Button never defaults to a verb call, Show defaults to
// hidden, For defaults to a literal empty array (not {var:''}, which would
// silently depend on undefined ?? [] fallback behavior elsewhere)
export const defaultNodeFor = (type: UiNode['type']): UiNode => {
  switch (type) {
    case 'View':
      return {type: 'View', children: []}
    case 'Text':
      return {type: 'Text', value: 'Text'}
    case 'Input':
      return {type: 'Input', bind: '', kind: 'text'}
    case 'NotePicker':
      return {type: 'NotePicker', bind: '', filter: {spent: false}}
    case 'Button':
      return {
        type: 'Button',
        label: 'Button',
        onClick: {action: 'set', path: '', value: ''}
      }
    case 'For':
      return {type: 'For', each: [], children: []}
    case 'Show':
      return {type: 'Show', when: false, children: []}
    case 'QrDisplay':
      return {type: 'QrDisplay', value: ''}
  }
}

export const describeExprShort = (expr: Expr): string => {
  if (expr === null) return 'null'
  if (typeof expr === 'string') return `"${expr}"`
  if (typeof expr === 'number' || typeof expr === 'boolean') return String(expr)
  if (Array.isArray(expr)) return `[${expr.length}]`
  if ('var' in expr) return `{${expr.var}}`
  if ('cat' in expr) return 'cat(...)'
  if ('and' in expr) return 'and(...)'
  if ('gt' in expr) return 'gt(...)'
  if ('lte' in expr) return 'lte(...)'
  if ('helper' in expr) return `${expr.helper}(...)`
  return '{...}'
}

export const describeNode = (node: UiNode): string => {
  switch (node.type) {
    case 'View':
      return node.style ? `View (${node.style})` : 'View'
    case 'Text':
      return `Text: ${describeExprShort(node.value)}`
    case 'Input':
      return `Input -> ${node.bind || '(unbound)'} (${node.kind ?? 'text'})`
    case 'NotePicker':
      return `NotePicker -> ${node.bind || '(unbound)'}`
    case 'Button':
      return `Button: "${node.label}"`
    case 'For':
      return `For each ${describeExprShort(node.each)}`
    case 'Show':
      return `Show when ${describeExprShort(node.when)}`
    case 'QrDisplay':
      return `QrDisplay ${describeExprShort(node.value)}`
  }
}

export type ExprMode = 'literal' | 'field' | 'advanced'

export const inferExprMode = (expr: Expr): ExprMode => {
  if (
    expr === null ||
    typeof expr === 'string' ||
    typeof expr === 'number' ||
    typeof expr === 'boolean'
  ) {
    return 'literal'
  }
  if (!Array.isArray(expr) && 'var' in expr && typeof expr.var === 'string') {
    return 'field'
  }
  return 'advanced'
}

export const defaultExprFor = (mode: ExprMode): Expr => {
  switch (mode) {
    case 'literal':
      return ''
    case 'field':
      return {var: ''}
    case 'advanced':
      // an empty literal-container object - the most neutral possible
      // "advanced" starting point (see types.ts's Expr doc comment: an
      // object with none of the operator keys is a valid Expr at runtime,
      // just not spelled out in the union - so this needs the same escape
      // hatch cast the doc comment describes)
      return {} as Expr
  }
}

export type ActionMode = 'set' | 'verb' | 'advanced'

export const inferActionMode = (action: Action): ActionMode => {
  if ('verb' in action) return 'verb'
  if (action.action === 'set' || action.action === 'push') return 'set'
  return 'advanced'
}

export const defaultActionFor = (
  mode: ActionMode,
  verbNames: string[]
): Action => {
  switch (mode) {
    case 'set':
      return {action: 'set', path: '', value: ''}
    case 'verb': {
      // 'note.query' specifically (the read-only verb) when it's available,
      // not whichever key of VERBS happens to iterate first - that order
      // is incidental, not a designed guarantee
      const verb = verbNames.includes('note.query')
        ? 'note.query'
        : (verbNames[0] ?? '')
      return {verb, args: {}}
    }
    case 'advanced':
      return {action: 'removeAt', path: '', index: 0}
  }
}

const UI_NODE_TYPES = new Set([
  'View',
  'Text',
  'Input',
  'NotePicker',
  'Button',
  'For',
  'Show',
  'QrDisplay'
])

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// deliberately shallow (NOT validateManifest-grade - doesn't check
// Expr/Action shapes at all) - just enough that every function above, and
// UiBuilder.tsx's recursive walk, is crash-proof against a hand-mangled
// `ui` value. Recurses into `children` because a bad grandchild would
// still crash the outliner otherwise.
export const isSafeUiNode = (v: unknown): v is UiNode => {
  if (!isPlainObject(v)) return false
  if (typeof v.type !== 'string' || !UI_NODE_TYPES.has(v.type)) return false
  if ('children' in v && v.children !== undefined) {
    if (!Array.isArray(v.children)) return false
    return v.children.every(isSafeUiNode)
  }
  return true
}
