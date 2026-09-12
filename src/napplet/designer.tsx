import {createSignal, onCleanup, onMount, For, Show} from 'solid-js'
import {render} from 'solid-js/web'
import Banknote from './Banknote'
import {
  DEFAULT_DESIGN,
  DESIGN_CONVENTION,
  parseDesign,
  readArtwork
} from './design'
import type {NoteDesign} from './design'
import {pushNoteDesign} from './note-interface'
import './style.css'
import './designer.css'

function Designer() {
  const [design, setDesign] = createSignal<NoteDesign>({...DEFAULT_DESIGN})
  const [amount, setAmount] = createSignal('21')
  const [message, setMessage] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [incoming, setIncoming] = createSignal<NoteDesign | null>(null)
  const [exported, setExported] = createSignal('')
  let subscription: {close(): void} | undefined
  let edited = false
  onMount(() => {
    const host = window.napplet
    subscription = host?.inc?.on(DESIGN_CONVENTION, event => {
      try {
        const data = event.payload as {design?: unknown} | undefined
        if (data?.design === undefined) return
        if (incoming() || busy()) {
          setMessage(
            'Finish the current request before opening another design.'
          )
          return
        }
        setIncoming(parseDesign(data.design))
      } catch {
        setMessage('The requested design could not be opened.')
      }
    })
    host?.storage
      ?.getItem('bearer-design:v1')
      .then(raw => {
        if (raw && !edited) setDesign(parseDesign(JSON.parse(raw)))
      })
      .catch(() =>
        setMessage('Saved draft unavailable. You can still design and export.')
      )
  })
  onCleanup(() => subscription?.close())
  const update = (change: Partial<NoteDesign>): void => {
    edited = true
    setDesign({...design(), ...change})
    setExported('')
  }
  const upload = async (file: File): Promise<void> => {
    setBusy(true)
    setMessage('')
    try {
      update({image: await readArtwork(file)})
    } catch (error) {
      setMessage((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const save = async (push = false): Promise<void> => {
    setBusy(true)
    try {
      const clean = parseDesign(design())
      if (window.napplet?.storage)
        await window.napplet.storage.setItem(
          'bearer-design:v1',
          JSON.stringify(clean)
        )
      if (push) {
        const api = window.napplet?.intent
        if (!api)
          throw new Error(
            'Your shell does not support sending designs. Export the JSON instead.'
          )
        await pushNoteDesign(api, clean)
        setMessage('Design sent for review. Check Wallet to apply it.')
      } else {
        setExported(JSON.stringify(clean, null, 2))
        setMessage('Design ready to save as JSON.')
      }
    } catch (error) {
      setMessage((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div class="app studio">
      <header>
        <div class="wordmark">
          <span class="logo">✳</span>
          <span>
            Notes
            <small>LNURLCASH · NOTE DESIGNER</small>
          </span>
        </div>
        <span class="studio-label">MAKE YOUR SATS YOURS</span>
      </header>
      <main>
        <p class="eyebrow">A SMALL NOTE. A PERSONAL TOUCH.</p>
        <h1>Make something worth holding.</h1>
        <p class="intro">
          Turn an image, a colour and a few words into your own bearer note.
        </p>
        <Show when={incoming()}>
          <section
            class="request"
            role="dialog"
            aria-label="Review design request"
          >
            <h2>Open a received design?</h2>
            <p>This replaces the design currently on your canvas.</p>
            <button
              class="primary"
              disabled={busy()}
              onClick={() => {
                update(incoming()!)
                setIncoming(null)
                setMessage('')
              }}
            >
              Open received design
            </button>
            <button onClick={() => setIncoming(null)}>Dismiss</button>
          </section>
        </Show>
        <div class="studio-grid">
          <section class="preview-stage">
            <div class="preview-caption">
              <span>LIVE PREVIEW</span>
              <span>01 / FRONT</span>
            </div>
            <Banknote
              amount={
                Math.max(0, Math.min(2100000000, Number(amount()) || 0)) * 1000
              }
              issuer="your.mint"
              serial="DESIGN01"
              design={design()}
              specimen
            />
            <div class="preview-foot">
              A design preview, ready for your own collection.
              <br />
              This design contains no bearer secret or spendable QR.
            </div>
          </section>
          <section class="panel studio-controls">
            <h2>The details</h2>
            <label>
              Note heading
              <input
                maxlength="48"
                value={design().title}
                onInput={e => update({title: e.currentTarget.value})}
              />
            </label>
            <label>
              A line of your own
              <input
                maxlength="100"
                value={design().subtitle}
                onInput={e => update({subtitle: e.currentTarget.value})}
              />
            </label>
            <label>
              Preview denomination (sats)
              <input
                type="number"
                min="0"
                max="2100000000"
                value={amount()}
                onInput={e => setAmount(e.currentTarget.value)}
              />
            </label>
            <div class="field-label">Choose a palette</div>
            <div class="palettes">
              <For
                each={[
                  {name: 'Linen', ink: '#174c3a', paper: '#f3ecd3'},
                  {name: 'Copper', ink: '#743e29', paper: '#f4dfc4'},
                  {name: 'Midnight', ink: '#263b66', paper: '#e4eaf2'},
                  {name: 'Rose', ink: '#763d59', paper: '#f5e3e8'}
                ]}
              >
                {palette => (
                  <button
                    title={palette.name}
                    aria-label={`${palette.name} palette`}
                    classList={{chosen: design().ink === palette.ink}}
                    style={{background: palette.paper, color: palette.ink}}
                    onClick={() =>
                      update({ink: palette.ink, paper: palette.paper})
                    }
                  >
                    ₿<small>{palette.name}</small>
                  </button>
                )}
              </For>
            </div>
            <div class="color-fields">
              <label>
                Ink
                <input
                  type="color"
                  value={design().ink}
                  onInput={e => update({ink: e.currentTarget.value})}
                />
              </label>
              <label>
                Paper
                <input
                  type="color"
                  value={design().paper}
                  onInput={e => update({paper: e.currentTarget.value})}
                />
              </label>
            </div>
            <label class="upload-zone">
              {design().image ? 'Replace artwork' : '+ Add your own artwork'}
              <input
                aria-label="Upload artwork"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={busy()}
                onChange={e => {
                  const file = e.currentTarget.files?.[0]
                  if (file) void upload(file)
                }}
              />
              <small>PNG, JPG or WebP · resized locally</small>
            </label>
            <Show when={design().image}>
              <button class="quiet" onClick={() => update({image: undefined})}>
                Remove image
              </button>
            </Show>
            <div class="studio-buttons">
              <button
                class="primary"
                disabled={busy() || !window.napplet?.intent}
                onClick={() => void save(true)}
              >
                Send to Wallet
              </button>
              <button disabled={busy()} onClick={() => void save()}>
                Export design
              </button>
            </div>
          </section>
        </div>
        <Show when={message()}>
          <p class="notice" role="status">
            {message()}
          </p>
        </Show>
        <Show when={exported()}>
          <label>
            Design JSON
            <textarea
              class="backup"
              readonly
              value={exported()}
              onFocus={e => e.currentTarget.select()}
            />
          </label>
        </Show>
      </main>
      <footer>Notes · LNURLcash · MIT licensed</footer>
    </div>
  )
}

render(() => <Designer />, document.getElementById('root')!)
