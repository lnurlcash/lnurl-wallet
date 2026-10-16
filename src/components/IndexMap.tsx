import type {Component} from 'solid-js'
import {For, Show, createMemo, createSignal} from 'solid-js'

import type {IndexStatus} from '../recovery'

export type IndexMapCells = Record<number, IndexStatus>

export type IndexMapProps = {
  label: string
  cells: IndexMapCells
  // the index being probed right now, outlined while a scan runs
  current?: number | null
}

type CellState = IndexStatus | 'unchecked'

const STATE_LABEL: Record<CellState, string> = {
  recovered: 'recovered now',
  held: 'already in wallet',
  spent: 'spent',
  unknown: 'unknown (gap)',
  unchecked: 'not checked'
}

const LEGEND: CellState[] = [
  'recovered',
  'held',
  'spent',
  'unknown',
  'unchecked'
]

// A defrag-style picture of one derivation counter after (and during) a
// recovery scan: one cell per index from 0 up to the highest probed, so
// runs of unknown indices - the gaps a gap limit has to bridge - and
// anything left unchecked below a custom start index are visible at a
// glance. Identity is never color alone: the legend names each state with
// its count, and hovering/focusing a cell reads out its index and state.
const IndexMap: Component<IndexMapProps> = props => {
  const [hovered, setHovered] = createSignal<number | null>(null)

  const indices = createMemo(() => {
    const keys = Object.keys(props.cells).map(Number)
    if (keys.length === 0) return []
    const top = Math.max(...keys, props.current ?? 0)
    return Array.from({length: top + 1}, (_, i) => i)
  })

  const stateOf = (index: number): CellState =>
    props.cells[index] ?? 'unchecked'

  const counts = createMemo(() => {
    const out: Record<CellState, number> = {
      recovered: 0,
      held: 0,
      spent: 0,
      unknown: 0,
      unchecked: 0
    }
    for (const status of Object.values(props.cells)) out[status]++
    out.unchecked = indices().length - Object.keys(props.cells).length
    return out
  })

  const readout = () => {
    const index = hovered()
    if (index === null) return null
    return `#${index}: ${STATE_LABEL[stateOf(index)]}`
  }

  return (
    <Show when={indices().length > 0}>
      <div class="index-map">
        <p class="bearer-label">
          {props.label} · indices 0–{indices().length - 1}
        </p>
        <div class="index-map-grid" onMouseLeave={() => setHovered(null)}>
          <For each={indices()}>
            {index => (
              <span
                class={`index-cell index-cell-${stateOf(index)}`}
                classList={{'index-cell-current': props.current === index}}
                tabindex="0"
                title={`#${index}: ${STATE_LABEL[stateOf(index)]}`}
                aria-label={`Index ${index}: ${STATE_LABEL[stateOf(index)]}`}
                onMouseEnter={() => setHovered(index)}
                onFocus={() => setHovered(index)}
              />
            )}
          </For>
        </div>
        <p class="index-map-legend">
          <For each={LEGEND}>
            {state => (
              <Show when={state !== 'unchecked' || counts().unchecked > 0}>
                <span class="index-map-key">
                  <span class={`index-cell index-cell-${state}`} />
                  {STATE_LABEL[state]} {counts()[state]}
                </span>
              </Show>
            )}
          </For>
        </p>
        <p class="bearer-hint index-map-readout">
          {readout() ?? 'Hover a cell to see its index.'}
        </p>
      </div>
    </Show>
  )
}
export default IndexMap
