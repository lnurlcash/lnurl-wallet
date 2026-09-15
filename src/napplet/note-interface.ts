import type {intent} from '@napplet/sdk'
import {parseDesign} from './design'
import type {NoteDesign} from './design'

export const NOTE_DESIGN_CONVENTION = 'napplet:wallet/design'
export type NoteDesignMessage = {
  kind: 'lnurlcash/note-design'
  version: 1
  design: NoteDesign
}

/** Export a versioned appearance-only payload, excluding denomination and bearer secrets. */
export const noteDesignMessage = (design: NoteDesign): NoteDesignMessage => ({
  kind: 'lnurlcash/note-design',
  version: 1,
  design: parseDesign(design)
})

/** Reject unsupported contracts before any wallet storage changes. */
export const parseNoteDesignMessage = (payload: unknown): NoteDesign => {
  const value = payload as Partial<NoteDesignMessage> | null
  if (!value || value.kind !== 'lnurlcash/note-design' || value.version !== 1) {
    throw new Error('Unsupported note design interface.')
  }
  return parseDesign(value.design)
}

/** Dispatch a design without focusing or navigating to the receiving wallet. */
export const pushNoteDesign = async (
  api: Pick<typeof intent, 'available' | 'open'>,
  design: NoteDesign
): Promise<void> => {
  const payload = noteDesignMessage(design)
  const available = await api.available('wallet')
  if (
    !available.available ||
    !available.candidates.some(candidate =>
      candidate.conventions.includes(NOTE_DESIGN_CONVENTION)
    )
  )
    throw new Error(
      'No wallet with the note interface is available in this shell.'
    )
  const result = await api.open('wallet', payload, {
    convention: NOTE_DESIGN_CONVENTION,
    behavior: {focus: false, reuse: true}
  })
  if (!result.ok || !result.handled) {
    throw new Error(
      result.error || 'The design could not be delivered. Please retry.'
    )
  }
}
