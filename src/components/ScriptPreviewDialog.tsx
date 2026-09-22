import type {Component} from 'solid-js'
import {Show, createMemo} from 'solid-js'
import {IoLockOpenSharp, IoTimeSharp, IoCopySharp} from 'solid-icons/io'
import {bytesToHex} from '@noble/hashes/utils.js'

import Dialog from './Dialog'
import {decodeCw1, outputKeyOfCw1} from '../lib/recoverableNotes'
import {identifyLeaf, opcodesOf} from '../addons/taproot/taproot'
import {copyToClipboard, formatDate} from '../helpers'

export type ScriptPreviewDialogProps = {
  cw1: string
  onClose: () => void
}

// BIP65: below this a CLTV number is a block height, at/above it a unix
// time - same threshold the timelocker addon's own timelock.ts uses, kept
// separate here (no wallet-wide-worthy shared constant exists yet) rather
// than importing from an addon's page-local module.
const LOCKTIME_THRESHOLD = 500_000_000

// A note whose own k1 is a cw1 (a ct1's script-path spend, see
// isValidK1/BearerCard.tsx's own "script" pill) carries a real, revealed
// Tapscript leaf - this shows exactly what it says, decoded from the SAME
// bytes the mint itself would check (identifyLeaf/opcodesOf, shared with
// the taproot addon rather than reimplemented), not a description taken on
// faith. Read-only: nothing here can move funds.
const ScriptPreviewDialog: Component<ScriptPreviewDialogProps> = props => {
  const cw1 = createMemo(() => decodeCw1(props.cw1))
  const outputKeyHex = createMemo(() => outputKeyOfCw1(props.cw1))
  const identified = createMemo(() => {
    const decoded = cw1()
    return decoded ? identifyLeaf(decoded.script) : null
  })
  const leafVersion = createMemo(() => {
    const decoded = cw1()
    return decoded && decoded.controlBlock.length > 0
      ? (decoded.controlBlock[0]! & 0xfe).toString(16).padStart(2, '0')
      : null
  })
  const merklePathDepth = createMemo(() => {
    const decoded = cw1()
    return decoded ? Math.max(0, (decoded.controlBlock.length - 33) / 32) : 0
  })

  // the one shape this wallet's own Timelocker addon produces - called out
  // by name rather than left as a generic "cltv leaf" match, since it's the
  // one a holder is most likely to actually be looking at
  const timelockUnlock = createMemo(() => {
    const leaf = identified()
    const decoded = cw1()
    if (!leaf || !decoded || leaf.template.id !== 'cltv') return null
    if (decoded.locktime < LOCKTIME_THRESHOLD) return null
    return decoded.locktime
  })

  return (
    <Dialog onClose={props.onClose}>
      <h4>
        <IoTimeSharp />
        &nbsp;Script preview
      </h4>
      <Show
        when={cw1()}
        fallback={<p>This isn't a well-formed script-path secret.</p>}
      >
        {decoded => (
          <>
            <Show when={timelockUnlock()}>
              {unlockAt => (
                <p>
                  <IoLockOpenSharp />
                  &nbsp;<strong>Timelock</strong> - redeemable once the mint's
                  own clock passes{' '}
                  <strong>{formatDate(unlockAt() * 1000)}</strong> (unix{' '}
                  {unlockAt()}), by whoever holds this note's secret.
                </p>
              )}
            </Show>
            <Show
              when={identified()}
              fallback={
                <p class="bearer-hint">
                  This leaf doesn't match any template this wallet recognises by
                  name - shown below exactly as decoded.
                </p>
              }
            >
              {leaf => (
                <Show when={leaf().template.id !== 'cltv' || !timelockUnlock()}>
                  <p>
                    <strong>{leaf().template.name}</strong> -{' '}
                    {leaf().template.description}
                  </p>
                </Show>
              )}
            </Show>

            <label>Opcodes (decoded from the leaf script itself)</label>
            <pre onClick={() => copyToClipboard(opcodesOf(decoded().script))}>
              {opcodesOf(decoded().script)}
            </pre>

            <label>Claimed locktime / sequence</label>
            <pre
              onClick={() =>
                copyToClipboard(`${decoded().locktime} / ${decoded().sequence}`)
              }
            >
              {decoded().locktime} / {decoded().sequence}
            </pre>

            <label>
              Witness stack ({decoded().witness.length}{' '}
              {decoded().witness.length === 1 ? 'item' : 'items'})
            </label>
            <Show
              when={decoded().witness.length > 0}
              fallback={
                <p class="bearer-hint">
                  Empty - this leaf needs nothing pushed to satisfy it (e.g. a
                  pure timelock).
                </p>
              }
            >
              <pre
                onClick={() =>
                  copyToClipboard(
                    decoded()
                      .witness.map(w => bytesToHex(w))
                      .join('\n')
                  )
                }
              >
                {decoded()
                  .witness.map(w => bytesToHex(w))
                  .join('\n')}
              </pre>
            </Show>

            <label>
              Control block ({merklePathDepth()}-deep merkle path
              {leafVersion() ? `, leaf version 0x${leafVersion()}` : ''})
            </label>
            <pre
              onClick={() =>
                copyToClipboard(bytesToHex(decoded().controlBlock))
              }
            >
              {bytesToHex(decoded().controlBlock)}
            </pre>

            <label>Derived output key (Q) - what this leaf commits to</label>
            <Show
              when={outputKeyHex()}
              fallback={
                <p class="bearer-hint">
                  Malformed control block - could not derive an output key.
                </p>
              }
            >
              {key => <pre onClick={() => copyToClipboard(key())}>{key()}</pre>}
            </Show>
            <p class="bearer-hint">
              <IoCopySharp />
              &nbsp;Click any block above to copy it. This is a read-only
              preview - nothing here can move funds.
            </p>
          </>
        )}
      </Show>
    </Dialog>
  )
}
export default ScriptPreviewDialog
