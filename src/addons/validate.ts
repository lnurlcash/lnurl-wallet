// Structural validation for a hand-authored/edited manifest (see the addon
// builder on Addons.tsx) - this is the one place untrusted-ish JSON (a
// holder's own typed/pasted text) turns into something Renderer.tsx will
// walk. A custom addon still runs through the exact same renderer as the
// bundled ones and still has no code-injection surface (it's checked here
// to BE data, never code) - this only guards against a malformed shape
// crashing the renderer with a confusing error, or referencing a verb that
// doesn't exist.
import {VERBS} from './verbs'
import type {AddonManifest, UiNode} from './types'

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isJsonValue = (v: unknown, path: string): string | null => {
  if (
    v === null ||
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean'
  ) {
    return null
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const err = isJsonValue(v[i], `${path}[${i}]`)
      if (err) return err
    }
    return null
  }
  if (isPlainObject(v)) {
    for (const [key, value] of Object.entries(v)) {
      const err = isJsonValue(value, `${path}.${key}`)
      if (err) return err
    }
    return null
  }
  return `${path} must be a plain JSON value`
}

// a plain array/object with none of the operator keys is a literal
// container - each element/field is itself an Expr (see types.ts's Expr
// doc comment on why this exists: note.split's `tickets` arg, mainly)
const isExpr = (v: unknown, path: string): string | null => {
  if (
    v === null ||
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean'
  ) {
    return null
  }
  if (Array.isArray(v)) return isExprArray(v, path)
  if (!isPlainObject(v))
    return `${path} must be an expression object, array, or literal`
  if ('var' in v)
    return typeof v.var === 'string' ? null : `${path}.var must be a string`
  if ('cat' in v) return isExprArray(v.cat, `${path}.cat`)
  if ('and' in v) return isExprArray(v.and, `${path}.and`)
  if ('gt' in v) return isExprPair(v.gt, `${path}.gt`)
  if ('lte' in v) return isExprPair(v.lte, `${path}.lte`)
  if ('helper' in v) {
    if (typeof v.helper !== 'string') return `${path}.helper must be a string`
    return isExprArray(v.args, `${path}.args`)
  }
  for (const [key, value] of Object.entries(v)) {
    const err = isExpr(value, `${path}.${key}`)
    if (err) return err
  }
  return null
}

const isExprArray = (v: unknown, path: string): string | null => {
  if (!Array.isArray(v)) return `${path} must be an array`
  for (let i = 0; i < v.length; i++) {
    const err = isExpr(v[i], `${path}[${i}]`)
    if (err) return err
  }
  return null
}

const isExprPair = (v: unknown, path: string): string | null => {
  if (!Array.isArray(v) || v.length !== 2)
    return `${path} must be a 2-element array`
  return isExpr(v[0], `${path}[0]`) ?? isExpr(v[1], `${path}[1]`)
}

const isAction = (v: unknown, path: string): string | null => {
  if (!isPlainObject(v)) return `${path} must be an object`
  if ('verb' in v) {
    if (typeof v.verb !== 'string') return `${path}.verb must be a string`
    if (!(v.verb in VERBS))
      return `${path}.verb references an unknown verb: ${v.verb}`
    if (!isPlainObject(v.args)) return `${path}.args must be an object`
    for (const [key, expr] of Object.entries(v.args)) {
      const err = isExpr(expr, `${path}.args.${key}`)
      if (err) return err
    }
    if ('result' in v && typeof v.result !== 'string') {
      return `${path}.result must be a string`
    }
    return null
  }
  if (v.action === 'set' || v.action === 'push') {
    if (typeof v.path !== 'string') return `${path}.path must be a string`
    return isExpr(v.value, `${path}.value`)
  }
  if (v.action === 'removeAt') {
    if (typeof v.path !== 'string') return `${path}.path must be a string`
    return isExpr(v.index, `${path}.index`)
  }
  return `${path} is not a recognized action shape`
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

const isUiNode = (v: unknown, path: string): string | null => {
  if (!isPlainObject(v)) return `${path} must be an object`
  if (typeof v.type !== 'string' || !UI_NODE_TYPES.has(v.type)) {
    return `${path}.type must be one of ${[...UI_NODE_TYPES].join(', ')}`
  }
  switch (v.type as UiNode['type']) {
    case 'View':
      return v.children === undefined
        ? null
        : isUiNodeArray(v.children, `${path}.children`)
    case 'Text':
      return isExpr(v.value, `${path}.value`)
    case 'Input':
      return typeof v.bind === 'string' ? null : `${path}.bind must be a string`
    case 'NotePicker':
      return typeof v.bind === 'string' ? null : `${path}.bind must be a string`
    case 'Button':
      if (typeof v.label !== 'string') return `${path}.label must be a string`
      return isAction(v.onClick, `${path}.onClick`)
    case 'For':
      return (
        isExpr(v.each, `${path}.each`) ??
        isUiNodeArray(v.children, `${path}.children`)
      )
    case 'Show':
      return (
        isExpr(v.when, `${path}.when`) ??
        isUiNodeArray(v.children, `${path}.children`)
      )
    case 'QrDisplay':
      return isExpr(v.value, `${path}.value`)
  }
}

const isUiNodeArray = (v: unknown, path: string): string | null => {
  if (!Array.isArray(v)) return `${path} must be an array`
  for (let i = 0; i < v.length; i++) {
    const err = isUiNode(v[i], `${path}[${i}]`)
    if (err) return err
  }
  return null
}

const isPermission = (v: unknown, path: string): string | null => {
  if (!isPlainObject(v)) return `${path} must be an object`
  if (typeof v.verb !== 'string') return `${path}.verb must be a string`
  if (typeof v.reason !== 'string') return `${path}.reason must be a string`
  if ('scope' in v && typeof v.scope !== 'string')
    return `${path}.scope must be a string`
  return null
}

// intentionally loose about known-ness of `verb` here (unlike isAction) -
// a permission is documentation shown to a holder, not itself dispatched
const isPermissionArray = (v: unknown, path: string): string | null => {
  if (!Array.isArray(v)) return `${path} must be an array`
  for (let i = 0; i < v.length; i++) {
    const err = isPermission(v[i], `${path}[${i}]`)
    if (err) return err
  }
  return null
}

// returns a description of the first problem found, or null if the shape
// checks out - kept separate from validateManifest below so every check
// is a plain string return (no discriminated-union result object for
// callers to narrow), same "return null on success" convention every
// isXxx helper above already uses
const findManifestError = (data: unknown): string | null => {
  if (!isPlainObject(data)) return 'Manifest must be a JSON object.'
  if (typeof data.id !== 'string' || !/^[a-z0-9-]+$/.test(data.id)) {
    return 'id must be a lowercase string using only letters, numbers and hyphens.'
  }
  if (typeof data.name !== 'string' || !data.name.trim())
    return 'name is required.'
  if (typeof data.version !== 'string') return 'version must be a string.'
  if (typeof data.icon !== 'string') return 'icon must be a string.'
  if ('description' in data && typeof data.description !== 'string') {
    return 'description must be a string.'
  }

  const permErr = isPermissionArray(data.permissions, 'permissions')
  if (permErr) return permErr

  if ('nav' in data && data.nav !== undefined) {
    const nav = data.nav
    if (!isPlainObject(nav)) return 'nav must be an object.'
    if (nav.position !== 'left' && nav.position !== 'right') {
      return "nav.position must be 'left' or 'right'."
    }
    if (typeof nav.label !== 'string') return 'nav.label must be a string.'
    if (typeof nav.icon !== 'string') return 'nav.icon must be a string.'
    if ('route' in nav && typeof nav.route !== 'string')
      return 'nav.route must be a string.'
  }

  const stateErr = isJsonValue(data.state, 'state')
  if (!isPlainObject(data.state) || stateErr) {
    return stateErr ?? 'state must be a JSON object.'
  }

  const uiErr = isUiNode(data.ui, 'ui')
  if (uiErr) return uiErr

  if ('settings' in data && data.settings !== undefined) {
    const settings = data.settings
    if (!isPlainObject(settings)) return 'settings must be an object.'
    const settingsStateErr = isJsonValue(settings.state, 'settings.state')
    if (!isPlainObject(settings.state) || settingsStateErr) {
      return settingsStateErr ?? 'settings.state must be a JSON object.'
    }
    const settingsUiErr = isUiNode(settings.ui, 'settings.ui')
    if (settingsUiErr) return settingsUiErr
  }

  return null
}

// throws with a human-readable description of the first problem found,
// rather than returning a result object - mirrors this codebase's own
// requireNoteK1/requireDeviceClient convention for "validate or throw"
export const validateManifest = (data: unknown): AddonManifest => {
  const error = findManifestError(data)
  if (error) throw new Error(error)
  return data as AddonManifest
}
