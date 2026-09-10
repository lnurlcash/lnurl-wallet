// Error taxonomy shared by every network-touching function in this kit -
// see request.ts for where each of these actually gets thrown.

// a request whose outcome is unknown: the failure happened in a window
// where it may already have reached and been processed by the service - a
// timeout, a dropped connection, an unparseable response, or a 200 that
// didn't carry the expected confirmation. Distinct from a parsed
// {"status":"ERROR"} rejection (definitive: processed and refused) and from
// failures before anything was sent (offline mode, a URL this wallet won't
// fetch). For a mutating callback request the difference is fund-critical:
// treating an ambiguous failure as "nothing happened" can discard the fresh
// secrets of outputs the service in fact minted - see AmbiguousMutationError
export class AmbiguousMintError extends Error {}

// an AmbiguousMintError from rotate/split/merge, carrying the fresh
// wallet-generated secrets whose hashes the uncertain request disclosed -
// the only copies of the possibly-minted outputs. Order matches the
// primitive's result shape: [rotated] / [split-off, change] / [merged]
export class AmbiguousMutationError extends AmbiguousMintError {
  readonly newSecrets: string[]
  constructor(message: string, newSecrets: string[]) {
    super(message)
    this.newSecrets = newSecrets
  }
}

// the definitive counterpart: a parsed {"status":"ERROR"} the SERVICE sent,
// carrying its `reason` exactly as it arrived - empty string included.
// Kept separate from `message` (display text, which falls back to this
// wallet's own wording when SERVICE says nothing) because classifyNoteError
// decides a note's fate by matching that text, and must only ever match
// words SERVICE actually said
export class ServiceError extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(reason || 'The service rejected the request without saying why.')
    this.reason = reason
    this.name = 'ServiceError'
  }
}

// thrown for the exact {"status":"ERROR","reason":"pending"} case (see
// meltNote) - distinct from any other Error so callers polling a mid-melt
// note (MeltDialog.tsx) can tell "still in flight, try again shortly" apart from
// every other failure, which instead means the k1 is gone for good
export class PendingNoteError extends Error {
  constructor() {
    super(
      'This note has another operation in progress - try again in a moment.'
    )
    this.name = 'PendingNoteError'
  }
}

// thrown when SERVICE reports the k1 as unambiguously already spent (burned
// by a prior melt/rotate/split/merge, or replayed after one of those) -
// distinct from NoteUnknownError below because SERVICE is authoritative
// here: a wallet holding this k1 locally can safely lock it as spent
// without asking, the same as if it had just melted it itself
export class NoteSpentError extends Error {
  constructor(reason: string) {
    super(`This note has already been spent (service says: "${reason}").`)
    this.name = 'NoteSpentError'
  }
}

// Thrown when SERVICE reports an unknown note.  For privacy, a hash lookup
// uses this same response for burned and never-issued identifiers, so it is a
// definitive "not outstanding" verdict but not proof the note never existed.
// It remains distinct from a raw-k1 NoteSpentError for honest local wording.
export class NoteUnknownError extends Error {
  constructor(reason: string) {
    super(
      `The service doesn't recognize this note (service says: "${reason}").`
    )
    this.name = 'NoteUnknownError'
  }
}

// SERVICE's own wording for "this k1 is dead" varies by implementation and
// by endpoint - the informational GET can afford to distinguish "Note
// already spent." from "Unknown note.", while the mutating callback (an
// atomic, possibly multi-k1 request) can only ever say something like
// "Invalid or already spent k1." since it can't tell which case applies to
// which k1. Classified here so every note-specific call site gets a
// consistent, typed error instead of each re-parsing raw reason text.
// Only what SERVICE actually said is matched. Anything else - a transport
// failure, an unparseable body, a rejection carrying no reason at all -
// is no evidence about the note either way and passes through
// unclassified, so probeBurnedNote reads it as 'unknown' and callers keep
// every secret they hold.
export const classifyNoteError = (err: Error): Error => {
  if (!(err instanceof ServiceError)) return err
  const reason = err.reason
  if (/spent/i.test(reason)) return new NoteSpentError(reason)
  if (/unknown|not found/i.test(reason)) return new NoteUnknownError(reason)
  return err
}
