import {describe, expect, it, vi} from 'vitest'
import {DEFAULT_DESIGN} from './design'
import {parseWalletIntent} from './intents'
import {
  NOTE_DESIGN_CONVENTION,
  noteDesignMessage,
  parseNoteDesignMessage,
  pushNoteDesign
} from './note-interface'

const api = () => ({
  available: vi.fn(async () => ({
    archetype: 'wallet',
    available: true,
    hasDefault: true,
    candidates: [
      {
        dTag: 'test-wallet',
        actions: ['design'],
        conventions: [NOTE_DESIGN_CONVENTION]
      }
    ]
  })),
  open: vi.fn(async () => ({
    ok: true,
    handled: true,
    archetype: 'wallet',
    action: 'design'
  }))
})

describe('note design interface', () => {
  it('transfers appearance only and stages a typed wallet request', () => {
    const envelope = noteDesignMessage({
      ...DEFAULT_DESIGN,
      ...{amount: 999999, k1: 'secret'}
    })
    expect(envelope.design).toEqual(DEFAULT_DESIGN)
    expect(
      parseWalletIntent(NOTE_DESIGN_CONVENTION, envelope, 'notes')
    ).toEqual({
      action: 'design',
      design: DEFAULT_DESIGN,
      sender: 'notes'
    })
    for (const bad of [
      null,
      {},
      {...envelope, version: 2},
      {...envelope, kind: 'bearer'},
      {
        ...envelope,
        design: {...DEFAULT_DESIGN, image: 'https://tracker.example/pixel'}
      }
    ]) {
      expect(() => parseNoteDesignMessage(bad)).toThrow()
    }
  })

  it('dispatches once with focus disabled and no hardcoded wallet dependency', async () => {
    const host = api()
    await pushNoteDesign(host, DEFAULT_DESIGN)
    expect(host.open).toHaveBeenCalledExactlyOnceWith(
      'wallet',
      noteDesignMessage(DEFAULT_DESIGN),
      {
        convention: NOTE_DESIGN_CONVENTION,
        behavior: {focus: false, reuse: true}
      }
    )
  })

  it('does not dispatch to an absent or incompatible wallet', async () => {
    const host = api()
    host.available.mockResolvedValue({
      archetype: 'wallet',
      available: true,
      hasDefault: true,
      candidates: [
        {
          dTag: 'old-wallet',
          actions: ['pay'],
          conventions: ['napplet:wallet/pay']
        }
      ]
    })
    await expect(pushNoteDesign(host, DEFAULT_DESIGN)).rejects.toThrow(
      'No wallet'
    )
    expect(host.open).not.toHaveBeenCalled()
    host.available.mockResolvedValue({
      archetype: 'wallet',
      available: false,
      hasDefault: false,
      candidates: []
    })
    await expect(pushNoteDesign(host, DEFAULT_DESIGN)).rejects.toThrow(
      'No wallet'
    )
    expect(host.open).not.toHaveBeenCalled()
    host.available.mockRejectedValue(new Error('offline'))
    await expect(pushNoteDesign(host, DEFAULT_DESIGN)).rejects.toThrow(
      'offline'
    )
    expect(host.open).not.toHaveBeenCalled()
  })

  it('reports failed delivery without retrying or claiming success', async () => {
    const host = api()
    host.open.mockResolvedValue({
      ok: true,
      handled: false,
      archetype: 'wallet',
      action: 'design'
    })
    await expect(pushNoteDesign(host, DEFAULT_DESIGN)).rejects.toThrow(
      'could not be delivered'
    )
    expect(host.open).toHaveBeenCalledTimes(1)
  })
})
