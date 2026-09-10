import {describe, expect, it} from 'vitest'
import type {AddonManifest, UiNode} from './types'
import {raffleManifest} from './raffle/manifest'
import {STARTER_TEMPLATE} from './starterTemplate'
import {validateManifest} from './validate'
import {
  getNodeAt,
  isContainer,
  childrenOf,
  pathEquals,
  replaceNodeAt,
  insertChildAt,
  removeNodeAt,
  moveNode,
  defaultNodeFor,
  describeNode,
  describeExprShort,
  inferExprMode,
  defaultExprFor,
  inferActionMode,
  defaultActionFor,
  isSafeUiNode
} from './uiTree'

// recursively freezes a UiNode tree - replaceNodeAt/insertChildAt/
// removeNodeAt/moveNode must never mutate their input, only ever build a
// new tree, so a frozen fixture throws immediately in strict mode if any
// of them ever regress into mutating in place
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

const minimalManifest = (ui: UiNode): unknown => ({
  id: 'test-addon',
  name: 'Test Addon',
  version: '1',
  icon: 'pricetags',
  permissions: [],
  state: {},
  ui
})

const fixture: UiNode = deepFreeze({
  type: 'View',
  children: [
    {type: 'Text', value: 'Hello'},
    {
      type: 'Show',
      when: true,
      children: [{type: 'Text', value: 'Shown'}]
    },
    {
      type: 'Button',
      label: 'Click',
      onClick: {action: 'set', path: 'x', value: 1}
    }
  ]
})

describe('getNodeAt / childrenOf / isContainer', () => {
  it('resolves the root at an empty path', () => {
    expect(getNodeAt(fixture, [])).toBe(fixture)
  })

  it('resolves nested paths', () => {
    expect(getNodeAt(fixture, [0])).toEqual({type: 'Text', value: 'Hello'})
    expect(getNodeAt(fixture, [1, 0])).toEqual({type: 'Text', value: 'Shown'})
  })

  it('returns undefined for an out-of-range index', () => {
    expect(getNodeAt(fixture, [99])).toBeUndefined()
  })

  it('returns undefined for a path continuing past a leaf', () => {
    expect(getNodeAt(fixture, [0, 0])).toBeUndefined()
  })

  it('identifies containers vs leaves', () => {
    expect(isContainer(fixture)).toBe(true)
    expect(isContainer({type: 'Text', value: 'x'})).toBe(false)
    expect(childrenOf({type: 'View', children: undefined as any})).toEqual([])
    expect(childrenOf({type: 'Text', value: 'x'})).toBeUndefined()
  })

  it('resolves nested paths against the real raffle manifest tree', () => {
    const ui = raffleManifest.ui
    expect(getNodeAt(ui, [])).toBe(ui)
    // [6] = For each tiers; [6,0] = the tier row View; [6,0,3] = its Remove button
    const removeBtn = getNodeAt(ui, [6, 0, 3])
    expect(removeBtn).toMatchObject({type: 'Button', label: 'Remove'})
    // [10,0] = the "Run raffle" button behind the funding Show
    const runBtn = getNodeAt(ui, [10, 0])
    expect(runBtn).toMatchObject({type: 'Button', label: 'Run raffle'})
    // [11,1,0] = the per-ticket View inside the results For
    const ticketView = getNodeAt(ui, [11, 1, 0])
    expect(ticketView).toMatchObject({type: 'View', style: 'ticket'})
  })
})

describe('pathEquals', () => {
  it('compares by value, not reference', () => {
    expect(pathEquals([1, 2], [1, 2])).toBe(true)
    expect(pathEquals([], [])).toBe(true)
    expect(pathEquals([1, 2], [1, 3])).toBe(false)
    expect(pathEquals([1, 2], [1])).toBe(false)
    expect(pathEquals([1], null)).toBe(false)
    expect(pathEquals([1], undefined)).toBe(false)
  })
})

describe('replaceNodeAt', () => {
  it('replaces the root at path=[]', () => {
    const next: UiNode = {type: 'Text', value: 'new root'}
    expect(replaceNodeAt(fixture, [], next)).toBe(next)
  })

  it('replaces a nested node without mutating the frozen input', () => {
    const next: UiNode = {type: 'Text', value: 'Replaced'}
    const result = replaceNodeAt(fixture, [1, 0], next)
    expect(result).not.toBe(fixture)
    expect(getNodeAt(result, [1, 0])).toEqual(next)
    // untouched sibling subtrees are structurally shared, not deep-cloned
    expect(getNodeAt(result, [0])).toBe(getNodeAt(fixture, [0]))
    expect(getNodeAt(result, [2])).toBe(getNodeAt(fixture, [2]))
  })

  it('throws on an unresolvable path', () => {
    expect(() =>
      replaceNodeAt(fixture, [0, 0], {type: 'Text', value: 'x'})
    ).toThrow()
    expect(() =>
      replaceNodeAt(fixture, [99], {type: 'Text', value: 'x'})
    ).toThrow()
  })
})

describe('insertChildAt', () => {
  it('appends by default', () => {
    const {tree, path} = insertChildAt(fixture, [], {
      type: 'Text',
      value: 'new'
    })
    expect(path).toEqual([3])
    expect(getNodeAt(tree, [3])).toEqual({type: 'Text', value: 'new'})
    expect((tree as any).children).toHaveLength(4)
    // original untouched
    expect((fixture as any).children).toHaveLength(3)
  })

  it('inserts at an explicit index', () => {
    const {tree, path} = insertChildAt(
      fixture,
      [],
      {type: 'Text', value: 'new'},
      1
    )
    expect(path).toEqual([1])
    expect(getNodeAt(tree, [1])).toEqual({type: 'Text', value: 'new'})
    // what was at [1] shifted to [2]
    expect(getNodeAt(tree, [2])).toEqual(getNodeAt(fixture, [1]))
  })

  it('throws when the target path is not a container', () => {
    expect(() =>
      insertChildAt(fixture, [0], {type: 'Text', value: 'x'})
    ).toThrow()
  })
})

describe('removeNodeAt', () => {
  it('removes a node and shifts later siblings down', () => {
    const result = removeNodeAt(fixture, [1])
    expect((result as any).children).toHaveLength(2)
    // old index 2 (Button) is now index 1
    expect(getNodeAt(result, [1])).toEqual(getNodeAt(fixture, [2]))
  })

  it('throws on path=[] (cannot remove the root)', () => {
    expect(() => removeNodeAt(fixture, [])).toThrow()
  })
})

describe('moveNode', () => {
  it('swaps with the previous sibling on "up"', () => {
    const {tree, path} = moveNode(fixture, [1], 'up')
    expect(path).toEqual([0])
    expect(getNodeAt(tree, [0])).toEqual(getNodeAt(fixture, [1]))
    expect(getNodeAt(tree, [1])).toEqual(getNodeAt(fixture, [0]))
  })

  it('swaps with the next sibling on "down"', () => {
    const {tree, path} = moveNode(fixture, [0], 'down')
    expect(path).toEqual([1])
    expect(getNodeAt(tree, [1])).toEqual(getNodeAt(fixture, [0]))
  })

  it('is a no-op (same tree reference) at a boundary', () => {
    const up = moveNode(fixture, [0], 'up')
    expect(up.tree).toBe(fixture)
    expect(up.path).toEqual([0])
    const down = moveNode(fixture, [2], 'down')
    expect(down.tree).toBe(fixture)
    expect(down.path).toEqual([2])
  })

  it('is a no-op at path=[] (cannot move the root)', () => {
    const result = moveNode(fixture, [], 'up')
    expect(result.tree).toBe(fixture)
  })
})

describe('defaultNodeFor', () => {
  const types: UiNode['type'][] = [
    'View',
    'Text',
    'Input',
    'NotePicker',
    'Button',
    'For',
    'Show',
    'QrDisplay'
  ]

  it('produces a manifest-valid node for every type', () => {
    for (const type of types) {
      const node = defaultNodeFor(type)
      expect(node.type).toBe(type)
      expect(() => validateManifest(minimalManifest(node))).not.toThrow()
    }
  })

  it('never defaults Button to a verb call', () => {
    const button = defaultNodeFor('Button') as Extract<UiNode, {type: 'Button'}>
    expect('verb' in button.onClick).toBe(false)
  })

  it('defaults Show to hidden and For to an empty literal array', () => {
    expect((defaultNodeFor('Show') as any).when).toBe(false)
    expect((defaultNodeFor('For') as any).each).toEqual([])
  })
})

describe('describeNode / describeExprShort', () => {
  it('describes every node type', () => {
    expect(describeNode({type: 'View', style: 'row', children: []})).toBe(
      'View (row)'
    )
    expect(describeNode({type: 'View', children: []})).toBe('View')
    expect(describeNode({type: 'Text', value: 'hi'})).toBe('Text: "hi"')
    expect(describeNode({type: 'Input', bind: 'x', kind: 'number'})).toBe(
      'Input -> x (number)'
    )
    expect(describeNode({type: 'Input', bind: ''})).toBe(
      'Input -> (unbound) (text)'
    )
    expect(describeNode({type: 'NotePicker', bind: 'note'})).toBe(
      'NotePicker -> note'
    )
    expect(
      describeNode({type: 'Button', label: 'Go', onClick: true as any})
    ).toBe('Button: "Go"')
    expect(
      describeNode({type: 'For', each: {var: 'items'}, children: []})
    ).toBe('For each {items}')
    expect(describeNode({type: 'Show', when: true, children: []})).toBe(
      'Show when true'
    )
    expect(describeNode({type: 'QrDisplay', value: {var: 'url'}})).toBe(
      'QrDisplay {url}'
    )
  })

  it('describes every Expr shape', () => {
    expect(describeExprShort(null)).toBe('null')
    expect(describeExprShort('hi')).toBe('"hi"')
    expect(describeExprShort(5)).toBe('5')
    expect(describeExprShort(true)).toBe('true')
    expect(describeExprShort([1, 2])).toBe('[2]')
    expect(describeExprShort({var: 'x'})).toBe('{x}')
    expect(describeExprShort({cat: []})).toBe('cat(...)')
    expect(describeExprShort({and: []})).toBe('and(...)')
    expect(describeExprShort({gt: [1, 2]})).toBe('gt(...)')
    expect(describeExprShort({lte: [1, 2]})).toBe('lte(...)')
    expect(describeExprShort({helper: 'foo', args: []})).toBe('foo(...)')
    expect(describeExprShort({} as any)).toBe('{...}')
  })
})

describe('inferExprMode / defaultExprFor', () => {
  it('infers literal for plain values', () => {
    for (const v of ['x', 5, true, null]) {
      expect(inferExprMode(v)).toBe('literal')
    }
  })

  it('infers field for a {var} shape', () => {
    expect(inferExprMode({var: 'x'})).toBe('field')
  })

  it('infers advanced for everything else', () => {
    expect(inferExprMode({and: []})).toBe('advanced')
    expect(inferExprMode({gt: [1, 2]})).toBe('advanced')
    expect(inferExprMode([1, 2])).toBe('advanced')
    expect(inferExprMode({} as any)).toBe('advanced')
  })

  it('defaultExprFor round-trips back through inferExprMode', () => {
    expect(inferExprMode(defaultExprFor('literal'))).toBe('literal')
    expect(inferExprMode(defaultExprFor('field'))).toBe('field')
    expect(inferExprMode(defaultExprFor('advanced'))).toBe('advanced')
  })
})

describe('inferActionMode / defaultActionFor', () => {
  it('infers set for both set and push', () => {
    expect(inferActionMode({action: 'set', path: 'x', value: 1})).toBe('set')
    expect(inferActionMode({action: 'push', path: 'x', value: 1})).toBe('set')
  })

  it('infers verb for a verb dispatch', () => {
    expect(inferActionMode({verb: 'note.query', args: {}})).toBe('verb')
  })

  it('infers advanced for removeAt', () => {
    expect(inferActionMode({action: 'removeAt', path: 'x', index: 0})).toBe(
      'advanced'
    )
  })

  it('prefers note.query when entering the verb tier fresh', () => {
    const action = defaultActionFor('verb', ['note.split', 'note.query'])
    expect((action as any).verb).toBe('note.query')
  })

  it('falls back to the first verb when note.query is unavailable', () => {
    const action = defaultActionFor('verb', ['file.download'])
    expect((action as any).verb).toBe('file.download')
  })

  it('does not crash on an empty verb list', () => {
    expect(() => defaultActionFor('verb', [])).not.toThrow()
  })
})

describe('isSafeUiNode', () => {
  it('accepts every node in the raffle manifest and starter template', () => {
    expect(isSafeUiNode(raffleManifest.ui)).toBe(true)
    expect(isSafeUiNode(raffleManifest.settings!.ui)).toBe(true)
    const starter = JSON.parse(STARTER_TEMPLATE) as AddonManifest
    expect(isSafeUiNode(starter.ui)).toBe(true)
  })

  it('rejects malformed shapes', () => {
    expect(isSafeUiNode({})).toBe(false)
    expect(isSafeUiNode({type: 'Bogus'})).toBe(false)
    expect(isSafeUiNode({type: 'View', children: 'nope'})).toBe(false)
    expect(isSafeUiNode({type: 'View', children: [{type: 'Bogus'}]})).toBe(
      false
    )
    expect(isSafeUiNode(null)).toBe(false)
    expect(isSafeUiNode('hello')).toBe(false)
  })
})
