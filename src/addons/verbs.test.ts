import {describe, expect, it} from 'vitest'

import {buildTicketLabel} from './verbs'
import {parseLabelTags} from '../noteTags'

const RAFFLE = {id: 'raffle', name: 'Raffle Tickets'}

describe('buildTicketLabel', () => {
  it('always tags with the addon name and a stable addon-<id> tag', () => {
    const label = buildTicketLabel(undefined, RAFFLE)
    const {tags} = parseLabelTags(label)
    expect(tags).toContain('addon-raffle')
    expect(tags).toContain('Raffle%20Tickets')
  })

  it('keeps the addon-supplied tags alongside the host-enforced ones', () => {
    const label = buildTicketLabel(['raffle:run-1', 'tier:Grand prize'], RAFFLE)
    const {tags} = parseLabelTags(label)
    expect(tags).toEqual([
      'raffle%3Arun-1',
      'tier%3AGrand%20prize',
      'Raffle%20Tickets',
      'addon-raffle'
    ])
  })

  it('cannot be spoofed by an addon-supplied tag with the same name', () => {
    // an addon can't remove or fake the host tag just by also asking for
    // one that looks like it - both simply end up present
    const label = buildTicketLabel(['addon-raffle'], RAFFLE)
    const {tags} = parseLabelTags(label)
    expect(tags.filter(t => t === 'addon-raffle')).toHaveLength(2)
  })
})
