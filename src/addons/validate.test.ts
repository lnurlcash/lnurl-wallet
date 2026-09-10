import {describe, expect, it} from 'vitest'

import {validateManifest} from './validate'

const MINIMAL = {
  id: 'my-addon',
  name: 'My Addon',
  version: '1',
  icon: 'pricetags',
  permissions: [],
  state: {},
  ui: {type: 'View', children: []}
}

describe('validateManifest', () => {
  it('accepts a minimal valid manifest', () => {
    expect(validateManifest(MINIMAL)).toEqual(MINIMAL)
  })

  it('accepts the full raffle-shaped manifest', () => {
    const manifest = {
      ...MINIMAL,
      description: 'does a thing',
      nav: {position: 'right', icon: 'pricetags', label: 'Thing'},
      settings: {state: {x: 1}, ui: {type: 'Text', value: 'hi'}},
      permissions: [{verb: 'note.split', reason: 'splits a note'}],
      ui: {
        type: 'View',
        children: [
          {type: 'Text', value: {cat: ['a', {var: 'b'}]}},
          {
            type: 'For',
            each: {var: 'tiers'},
            children: [{type: 'Input', bind: 'item.count'}]
          },
          {
            type: 'Show',
            when: {and: [{var: 'x'}, {gt: [{var: 'y'}, 0]}]},
            children: [{type: 'QrDisplay', value: {var: 'url'}}]
          },
          {
            type: 'Button',
            label: 'Go',
            onClick: {
              verb: 'note.split',
              args: {
                note: {var: 'sourceNote.id'},
                tickets: {helper: 'plan', args: []}
              },
              result: 'results'
            }
          }
        ]
      }
    }
    expect(() => validateManifest(manifest)).not.toThrow()
  })

  it('rejects a non-object', () => {
    expect(() => validateManifest('not an object')).toThrow(/JSON object/)
  })

  it('rejects an id with invalid characters', () => {
    expect(() => validateManifest({...MINIMAL, id: 'My Addon!'})).toThrow(/id/)
  })

  it('rejects a missing name', () => {
    const {name: _name, ...rest} = MINIMAL
    expect(() => validateManifest(rest)).toThrow(/name/)
  })

  it('rejects an onClick verb that does not exist', () => {
    const manifest = {
      ...MINIMAL,
      ui: {
        type: 'View',
        children: [
          {type: 'Button', label: 'Go', onClick: {verb: 'note.steal', args: {}}}
        ]
      }
    }
    expect(() => validateManifest(manifest)).toThrow(/unknown verb/)
  })

  it('rejects an unrecognized UI node type', () => {
    const manifest = {...MINIMAL, ui: {type: 'ScriptTag', src: 'evil.js'}}
    expect(() => validateManifest(manifest)).toThrow(/type/)
  })

  it('rejects a malformed expression (an operator key with the wrong shape)', () => {
    const manifest = {
      ...MINIMAL,
      ui: {type: 'Text', value: {var: 123}}
    }
    expect(() => validateManifest(manifest)).toThrow(/var must be a string/)
  })

  it('accepts a literal object/array with no operator key as a literal container', () => {
    const manifest = {
      ...MINIMAL,
      ui: {type: 'Text', value: {amountMsat: {var: 'x'}, tags: ['a', 'b']}}
    }
    expect(() => validateManifest(manifest)).not.toThrow()
  })

  it('rejects non-JSON values in state', () => {
    const manifest = {...MINIMAL, state: {fn: () => {}}}
    expect(() => validateManifest(manifest)).toThrow(/JSON value/)
  })
})
