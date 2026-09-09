import {describe, expect, it} from 'vitest'

import {decodeTag, parseLabelTags} from './noteTags'

describe('parseLabelTags', () => {
  it('parses leading bracketed tags off a label', () => {
    const {tags, text} = parseLabelTags('[tag1][tag2][tag3]label example')
    expect(tags).toEqual(['tag1', 'tag2', 'tag3'])
    expect(text).toBe('label example')
  })

  it('url-encodes tag content', () => {
    const {tags} = parseLabelTags('[tag-123111] label')
    expect(tags).toEqual(['tag-123111'])

    const {tags: spaced} = parseLabelTags('[my tag] label')
    expect(spaced).toEqual(['my%20tag'])
    expect(decodeTag(spaced[0]!)).toBe('my tag')
  })

  it('returns no tags for a plain label', () => {
    const {tags, text} = parseLabelTags('just a label')
    expect(tags).toEqual([])
    expect(text).toBe('just a label')
  })

  it('handles a label that is only tags', () => {
    const {tags, text} = parseLabelTags('[a][b]')
    expect(tags).toEqual(['a', 'b'])
    expect(text).toBe('')
  })

  it('ignores an empty bracket', () => {
    const {tags, text} = parseLabelTags('[][a]rest')
    expect(tags).toEqual(['a'])
    expect(text).toBe('rest')
  })

  it('only strips a leading run of tags, not brackets mid-label', () => {
    const {tags, text} = parseLabelTags('[a]middle [not-a-tag] end')
    expect(tags).toEqual(['a'])
    expect(text).toBe('middle [not-a-tag] end')
  })
})
