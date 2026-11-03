import {describe, expect, it} from 'vitest'
import {
  classifyNoteError,
  NoteSpentError,
  NoteUnknownError,
  ServiceError
} from './errors'

describe('classifyNoteError', () => {
  it('reads LUD-25\'s "already in use" - a burned note - as spent', () => {
    for (const reason of ['already in use', ' Already in use ']) {
      expect(classifyNoteError(new ServiceError(reason))).toBeInstanceOf(
        NoteSpentError
      )
    }
  })

  it('still reads an older mint\'s "spent" reasons as spent', () => {
    expect(
      classifyNoteError(new ServiceError('Note already spent.'))
    ).toBeInstanceOf(NoteSpentError)
  })

  it('does not take a longer reason that merely mentions use as spent', () => {
    expect(
      classifyNoteError(new ServiceError('Unknown note, not in use'))
    ).not.toBeInstanceOf(NoteSpentError)
    expect(classifyNoteError(new ServiceError('Unknown note'))).toBeInstanceOf(
      NoteUnknownError
    )
  })
})
