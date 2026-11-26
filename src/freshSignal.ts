import type {Accessor} from 'solid-js'
import {createSignal, getObserver} from 'solid-js'

// A signal whose reads always return the latest write. Solid 2 defers a
// plain signal's writes until the next microtask flush - `set(x); get()`
// still returns the previous value - which is right for UI (no tearing) but
// silently breaks the read-modify-write helpers the app's persisted
// module-level stores are built from (trustedMints.ts, addressRegistry.ts,
// ...): two updates in the same tick (a loop over held notes, a handler
// that adds then locks) would both start from the same stale list and the
// second would drop the first. Here a plain variable holds the value and
// the signal only carries change notifications, so imperative callers see
// every write immediately while reactive readers still re-run on flush,
// exactly as with a normal signal.
// T must not itself be a function - same rule as Solid's own setters, since
// a function argument is taken as an updater
export const createFreshSignal = <T>(
  initial: T
): [get: Accessor<T>, set: (next: T | ((prev: T) => T)) => T] => {
  let latest = initial
  // carries change notifications only - the value lives in `latest`
  const [version, setVersion] = createSignal(0)
  return [
    () => {
      // subscribe only where something can subscribe (JSX, a memo, an
      // effect's compute) - the imperative reads this exists for (event
      // handlers, effect callbacks, plain module code) just want the value
      if (getObserver()) version()
      return latest
    },
    next => {
      const value =
        typeof next === 'function' ? (next as (prev: T) => T)(latest) : next
      // same === short-circuit a plain signal applies before notifying
      if (!Object.is(value, latest)) {
        latest = value
        setVersion(v => v + 1)
      }
      return value
    }
  ]
}
