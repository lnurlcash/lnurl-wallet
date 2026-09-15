import {For, Show} from 'solid-js'
import type {NoteDesign} from './design'
import './banknote.css'

/** Render decorative bearer artwork without putting a spendable secret in the card. */
export default function Banknote(props: {
  amount: number
  issuer: string
  serial: string
  design: NoteDesign
  specimen?: boolean
}) {
  return (
    <div
      class="banknote"
      style={{
        '--note-ink': props.design.ink,
        '--note-paper': props.design.paper
      }}
    >
      <div class="banknote-border" />
      <svg class="guilloche" viewBox="0 0 600 260" aria-hidden="true">
        <For each={Array.from({length: 18}, (_, i) => i * 10)}>
          {angle => (
            <ellipse
              cx="265"
              cy="135"
              rx="158"
              ry="52"
              transform={`rotate(${angle} 265 135)`}
            />
          )}
        </For>
      </svg>
      <span class="corner tl">₿</span>
      <span class="corner tr">₿</span>
      <div class="banknote-heading">{props.design.title}</div>
      <Show when={props.design.image}>
        <img
          class="banknote-art"
          src={props.design.image}
          alt="Custom note artwork"
        />
      </Show>
      <div
        class="banknote-value"
        classList={{'with-art': !!props.design.image}}
      >
        <strong
          style={{
            'font-size': `${Math.min(
              props.design.image ? 10 : 12,
              (props.design.image ? 76 : 110) /
                (props.amount / 1000).toLocaleString('en-US').length
            )}cqw`
          }}
        >
          {(props.amount / 1000).toLocaleString('en-US', {
            maximumFractionDigits: 3
          })}
        </strong>
        <span>SATOSHIS</span>
      </div>
      <div class="banknote-seal">
        <span>LN</span>
        <small>
          BEARER
          <br />
          ASSET
        </small>
      </div>
      <div class="banknote-subtitle">{props.design.subtitle}</div>
      <div class="banknote-bottom">
        <span>№ {props.serial.slice(0, 8).toUpperCase()}</span>
        <span>{props.issuer}</span>
      </div>
      <Show when={props.specimen}>
        <div class="specimen">DESIGN PREVIEW · NO FUNDS</div>
      </Show>
    </div>
  )
}
