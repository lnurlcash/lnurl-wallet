import {createSignal, Show} from 'solid-js'
import type {Note} from './vault'
import type {Wallet} from './wallet'

/** Show secondary actions only for the note the holder has selected. */
export default function NoteTools(props: {
  note: Note
  wallet: Wallet
  busy: boolean
  run(action: () => Promise<void>): Promise<void>
}) {
  const [label, setLabel] = createSignal(props.note.label ?? '')
  const run = (action: () => Promise<void>) => void props.run(action)
  return (
    <div class="note-tools">
      <label>
        Note label
        <input
          maxlength="200"
          value={label()}
          onInput={e => setLabel(e.currentTarget.value)}
        />
      </label>
      <button
        disabled={props.busy}
        onClick={() => run(() => props.wallet.annotate(props.note.id, label()))}
      >
        Save label
      </button>
      <Show when={props.note.verifyUrl}>
        <button
          disabled={props.busy}
          onClick={() =>
            run(async () => {
              if (!(await props.wallet.settlement(props.note.id)))
                throw new Error('Invoice has not settled yet.')
            })
          }
        >
          Verify settlement
        </button>
      </Show>
      <Show when={props.note.proof}>
        <details>
          <summary>Payment proof</summary>
          <p>Verified against the invoice payment hash.</p>
          <textarea readonly value={props.note.proof} />
        </details>
      </Show>
      <Show
        when={!['spent', 'shared'].includes(props.note.status)}
        fallback={
          <>
            <button
              disabled={props.busy}
              onClick={() =>
                run(() => props.wallet.mark(props.note.id, 'unspent'))
              }
            >
              Recheck as unspent
            </button>
            <button
              disabled={props.busy}
              onClick={() =>
                run(() => props.wallet.mark(props.note.id, 'hide'))
              }
            >
              Archive from collection
            </button>
          </>
        }
      >
        <button
          disabled={props.busy}
          onClick={() => run(() => props.wallet.mark(props.note.id, 'spent'))}
        >
          Mark as handed over
        </button>
      </Show>
    </div>
  )
}
