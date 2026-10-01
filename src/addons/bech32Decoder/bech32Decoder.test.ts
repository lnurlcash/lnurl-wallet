import {describe, expect, it} from 'vitest'
import {toBech32Lnurl} from '../../lnurlcash'
import {planTimelock} from '../timelocker/timelock'
import {bech32DecoderAddon} from './manifest'

const h = bech32DecoderAddon.helpers as Record<
  string,
  (...args: unknown[]) => unknown
>

const NOW = 1_800_000_000
const unlockAt = new Date((NOW + 7 * 86400) * 1000)
  .toLocaleString('sv-SE', {hour12: false})
  .replace(' ', 'T')
  .slice(0, 16)
const plan = planTimelock(unlockAt, 1000, 'mint.test', NOW)
const NOTE_URL = `https://mint.test/w?k1=${plan.cw1}&amount=1000`

describe('bech32 decoder', () => {
  it('reads a bech32 note and decodes its cw1 script', () => {
    const lnurl = toBech32Lnurl(NOTE_URL)
    expect(h.decodeLnurl!(lnurl)).toBe(NOTE_URL)
    expect(h.hasNote!(lnurl)).toBe(true)
    expect(h.noteK1Display!(lnurl)).toBe(plan.cw1)
    expect(h.noteKindDisplay!(lnurl)).toMatch(/^Script-path note/)
    expect(h.isScriptPath!(lnurl)).toBe(true)
    expect(h.scriptUnlock!(lnurl)).toContain(`unix ${plan.locktime}`)
    expect(h.scriptOpcodes!(lnurl)).toContain('OP_CHECKLOCKTIMEVERIFY')
    expect(String(h.scriptOpcodes!(lnurl)).split('\n').length).toBeGreaterThan(
      1
    )
    expect(h.scriptOutputKey!(lnurl)).toBe(plan.outputKeyHex)
  })

  it('reads the same note pasted as a plain url or a bare cw1', () => {
    expect(h.noteK1Display!(NOTE_URL)).toBe(plan.cw1)
    expect(h.scriptOutputKey!(NOTE_URL)).toBe(plan.outputKeyHex)
    expect(h.isBareSecret!(plan.cw1)).toBe(true)
    expect(h.hasNote!(plan.cw1)).toBe(false)
    expect(h.scriptOutputKey!(plan.cw1)).toBe(plan.outputKeyHex)
  })

  it('shows no note or script for a non-note LNURL', () => {
    const lnurl = toBech32Lnurl('https://mint.test/.well-known/lnurlp/mint')
    expect(h.hasNote!(lnurl)).toBe(false)
    expect(h.isScriptPath!(lnurl)).toBe(false)
  })
})
