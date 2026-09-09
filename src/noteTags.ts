// a note's label may be prefixed with zero or more bracketed tags -
// "[tag1][tag2][tag3]rest of the label" - each tag's raw content is
// URL-encoded before use as its canonical id, so a tag containing "]",
// unicode, or stray whitespace can't break the bracket syntax or silently
// collide with a differently-spelled twin once decoded back for display
const TAG_PREFIX_RE = /^\[([^[\]]*)\]/

export type ParsedLabel = {
  tags: string[]
  text: string
}

export const parseLabelTags = (label: string): ParsedLabel => {
  let rest = label
  const tags: string[] = []
  for (;;) {
    const match = TAG_PREFIX_RE.exec(rest)
    if (!match) break
    const raw = match[1]!.trim()
    if (raw) tags.push(encodeURIComponent(raw))
    rest = rest.slice(match[0].length)
  }
  return {tags, text: rest.trim()}
}

export const decodeTag = (tag: string): string => {
  try {
    return decodeURIComponent(tag)
  } catch {
    return tag
  }
}
