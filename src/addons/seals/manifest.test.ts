import {describe, expect, it} from 'vitest'
import {schnorr} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex} from '@noble/hashes/utils.js'
import {base64} from '@scure/base'
import {GLOBAL_HELPERS} from '../globalHelpers'
import {imageDataUrl} from '../imageData'
import type {UiNode} from '../types'
import {VERBS} from '../verbs'
import {sealsAddon} from './manifest'
import {sealEnvelopeOf, stripSealEnvelope} from './picture'
import {
  decodeSealConsignment,
  encodeSealConsignment,
  nextState,
  type SealState
} from './seals'

// real 8x8 files written by Pillow 12.1.1
const PNG = base64.decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAG0lEQVR4nGNkYGBQYBDARCwMCgIMDFjQ4JQAAIWuBc6DYRwvAAAAAElFTkSuQmCC'
)
const JPG = base64.decode(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCrpHhn7v7v9KKKKITdisux9f2C1P/Z'
)

// what an ImagePicker binds for a file
const picked = (name: string, bytes: Uint8Array) => ({
  name,
  type: name.endsWith('.png') ? 'image/png' : 'image/jpeg',
  size: bytes.length,
  dataUrl: imageDataUrl(bytes)!
})

const keypair = () => {
  const secretKey = schnorr.utils.randomSecretKey()
  return {
    secretKeyHex: bytesToHex(secretKey),
    pubkeyHex: bytesToHex(schnorr.getPublicKey(secretKey))
  }
}

const helper = (name: string) =>
  sealsAddon.helpers[name] as (...args: unknown[]) => any

const LOCKED = {urlTemplate: 'https://mint.example.com/w', amountMsat: 1000}

describe('the seals manifest is wired to things that exist', () => {
  // every {helper} an Expr names, every verb an Action calls, anywhere in
  // the tree - a typo in a name only shows at click time otherwise
  const namesIn = (
    value: unknown,
    found = {helpers: new Set<string>(), verbs: new Set<string>()}
  ) => {
    if (Array.isArray(value)) {
      for (const item of value) namesIn(item, found)
    } else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      if (typeof record.helper === 'string') found.helpers.add(record.helper)
      if (typeof record.verb === 'string') found.verbs.add(record.verb)
      for (const item of Object.values(record)) namesIn(item, found)
    }
    return found
  }
  const ui: UiNode = sealsAddon.manifest.ui
  const {helpers, verbs} = namesIn(ui)

  it('names only helpers it defines, or global ones', () => {
    const known = {...GLOBAL_HELPERS, ...sealsAddon.helpers}
    expect([...helpers].filter(name => !(name in known))).toEqual([])
    expect(helpers.size).toBeGreaterThan(20)
  })

  it('calls only verbs that exist, and declares a permission for each', () => {
    expect([...verbs].filter(name => !(name in VERBS))).toEqual([])
    const declared = new Set(sealsAddon.manifest.permissions.map(p => p.verb))
    expect([...verbs].filter(name => !declared.has(name))).toEqual([])
  })

  it('reads only state it declares at the top of a path', () => {
    const vars = new Set<string>()
    const collect = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(collect)
      else if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>
        if (typeof record.var === 'string') vars.add(record.var.split('.')[0]!)
        if (typeof record.bind === 'string')
          vars.add(record.bind.split('.')[0]!)
        if (typeof record.result === 'string') vars.add(record.result)
        Object.values(record).forEach(collect)
      }
    }
    collect(ui)
    // `item` is a For/List's own loop variable
    vars.delete('item')
    expect(
      [...vars].filter(name => !(name in sealsAddon.manifest.state))
    ).toEqual([])
  })
})

describe('issuing a picture seal', () => {
  const owner = keypair()

  it('takes the picture’s own sha256 as the asset id', () => {
    const plan = helper('prepareGenesis')(
      'Art #1',
      'one of one',
      owner.pubkeyHex,
      picked('art.png', PNG)
    )
    expect(plan.pictureHashHex).toBe(bytesToHex(sha256(PNG)))
    expect(plan.state.assetId).toBe(plan.pictureHashHex)
    expect(plan.state.ownerPubkeyHex).toBe(owner.pubkeyHex)
  })

  it('stays a plain seal, with a random id, when no picture is picked', () => {
    const a = helper('prepareGenesis')('Art #1', '', owner.pubkeyHex, null)
    const b = helper('prepareGenesis')('Art #1', '', owner.pubkeyHex)
    expect(a.pictureHashHex).toBe('')
    expect(a.state.assetId).toMatch(/^[0-9a-f]{64}$/)
    expect(a.state.assetId).not.toBe(b.state.assetId)
  })

  it('refuses a picked file it cannot read as a picture', () => {
    expect(() =>
      helper('prepareGenesis')('Art #1', '', owner.pubkeyHex, {
        name: 'x.gif',
        dataUrl: 'data:image/gif;base64,R0lGODlh'
      })
    ).toThrow(/JPG or PNG/)
  })

  it('writes the issued consignment into that very picture', () => {
    const picture = picked('art.jpg', JPG)
    const plan = helper('prepareGenesis')(
      'Art #1',
      '',
      owner.pubkeyHex,
      picture
    )
    const sealed = helper('issuedPicture')(picture, LOCKED, plan) as Uint8Array
    expect(stripSealEnvelope(sealed)!.picture).toEqual(JPG)
    const consignment = helper('issuedConsignment')(LOCKED, plan)
    expect(sealEnvelopeOf(sealed)).toEqual({consignment})
    expect(decodeSealConsignment(consignment)!.states[0]!.assetId).toBe(
      bytesToHex(sha256(JPG))
    )
    expect(helper('planMatchesPicture')(plan, picture)).toBe(true)
  })

  it('offers no picture download once another file is picked, or for a plain seal', () => {
    const plan = helper('prepareGenesis')(
      'Art #1',
      '',
      owner.pubkeyHex,
      picked('art.jpg', JPG)
    )
    const other = picked('other.png', PNG)
    expect(helper('planMatchesPicture')(plan, other)).toBe(false)
    expect(helper('issuedPicture')(other, LOCKED, plan)).toBeNull()
    expect(helper('planMatchesPicture')(plan, null)).toBe(false)
    const plain = helper('prepareGenesis')('Art #1', '', owner.pubkeyHex)
    expect(helper('planMatchesPicture')(plain, other)).toBe(false)
    expect(helper('planMatchesPicture')(null, other)).toBe(false)
  })

  it('names the file after the seal', () => {
    const name = (assetName: string, picture: unknown) =>
      helper('pictureFileName')(
        picture,
        helper('issuedConsignment')(
          LOCKED,
          helper('prepareGenesis')(assetName, '', owner.pubkeyHex)
        )
      )
    expect(name('Art #1', picked('a.jpg', JPG))).toBe('art-1.seal.jpg')
    expect(name('Ünïcode / Card: "17"', picked('a.png', PNG))).toBe(
      'n-code-card-17.seal.png'
    )
    expect(name('???', picked('a.png', PNG))).toBe('seal.seal.png')
    expect(helper('pictureFileName')(picked('a.jpg', JPG), 'nope')).toBe(
      'seal.seal.jpg'
    )
  })
})

describe('managing a seal out of its picture', () => {
  const issuer = keypair()
  const holder = keypair()
  const picture = picked('art.png', PNG)
  const plan = helper('prepareGenesis')('Art #1', '', issuer.pubkeyHex, picture)
  const consignment = helper('issuedConsignment')(LOCKED, plan) as string
  const sealedPicture = picked(
    'art.seal.png',
    helper('issuedPicture')(picture, LOCKED, plan)
  )

  it('reads the consignment back out of a loaded picture', () => {
    expect(helper('consignmentOfPicture')(sealedPicture)).toBe(consignment)
    expect(helper('loadedPictureLine')(sealedPicture)).toMatch(
      /carries a seal’s consignment/
    )
    expect(helper('consignmentOfPicture')(picture)).toBe('')
    expect(helper('loadedPictureLine')(picture)).toMatch(/carries no seal/)
    expect(helper('consignmentOfPicture')(null)).toBe('')
    expect(helper('loadedPictureLine')(null)).toBe('')
  })

  it('answers the same for a picture however often it is asked', () => {
    // a picture is decoded and hashed once and remembered by its data URL -
    // across more pictures than are remembered at a time, too
    const pictures = [PNG, JPG].flatMap(bytes =>
      ['a', 'b', 'c'].map(text =>
        picked(
          `${text}.${bytes === PNG ? 'png' : 'jpg'}`,
          helper('issuedPicture')(
            picked('x', bytes),
            LOCKED,
            helper('prepareGenesis')(
              text,
              '',
              issuer.pubkeyHex,
              picked('x', bytes)
            )
          )
        )
      )
    )
    const answers = () =>
      pictures.map(loaded => [
        helper('consignmentOfPicture')(loaded),
        helper('loadedPictureLine')(loaded),
        helper('pictureMatches')(
          helper('consignmentOfPicture')(loaded),
          loaded
        ),
        helper('pictureMatches')(consignment, loaded)
      ])
    const first = answers()
    expect(answers()).toEqual(first)
    expect(new Set(first.map(answer => answer[0])).size).toBe(6)
    expect(first.every(answer => answer[2] === true)).toBe(true)
    // only the PNG ones are the picture THIS consignment's seal is about
    expect(first.map(answer => answer[3])).toEqual([
      true,
      true,
      true,
      false,
      false,
      false
    ])
  })

  it('says whether the loaded file is the seal’s own picture', () => {
    expect(helper('pictureMatches')(consignment, sealedPicture)).toBe(true)
    expect(helper('pictureMatches')(consignment, picture)).toBe(true)
    expect(helper('pictureMatchLine')(consignment, sealedPicture)).toMatch(
      new RegExp(
        `^✓ .*${bytesToHex(sha256(PNG))}.*not that it is the only seal`
      )
    )
    const other = picked('other.jpg', JPG)
    expect(helper('pictureMatches')(consignment, other)).toBe(false)
    expect(helper('pictureMatchLine')(consignment, other)).toMatch(
      /^✗ This is not the picture/
    )
    // nothing to say without both
    expect(helper('pictureMatchLine')(consignment, null)).toBe('')
    expect(helper('pictureMatchLine')('', sealedPicture)).toBe('')
  })

  // what verbs.ts's seal.transition answers with
  const transitionTo = (pubkeyHex: string) => ({
    urlTemplate: LOCKED.urlTemplate,
    amountMsat: LOCKED.amountMsat,
    state: nextState(plan.state as SealState, pubkeyHex),
    certificate: null
  })

  it('puts the new history into the picture for a named next owner - and no key', () => {
    const result = transitionTo(holder.pubkeyHex)
    expect(
      helper('canDownloadTransitioned')(
        sealedPicture,
        consignment,
        result,
        null
      )
    ).toBe(true)
    const next = helper('transitionedPicture')(
      sealedPicture,
      consignment,
      result,
      // a one-time key made earlier, but not what the seal moved to
      keypair()
    ) as Uint8Array
    const envelope = sealEnvelopeOf(next)!
    expect(envelope.claimSecretKeyHex).toBeUndefined()
    const states = decodeSealConsignment(envelope.consignment)!.states
    expect(states).toHaveLength(2)
    expect(states[1]!.ownerPubkeyHex).toBe(holder.pubkeyHex)
    expect(stripSealEnvelope(next)!.picture).toEqual(PNG)
    expect(helper('transitionedPictureLine')(result, null)).toMatch(
      /for the next owner/
    )
  })

  it('makes a bearer picture when the seal moved to the one-time key', () => {
    const claimKey = helper('newClaimKey')()
    expect(claimKey.secretKeyHex).toMatch(/^[0-9a-f]{64}$/)
    expect(
      bytesToHex(
        schnorr.getPublicKey(Buffer.from(claimKey.secretKeyHex, 'hex'))
      )
    ).toBe(claimKey.pubkeyHex)
    const result = transitionTo(claimKey.pubkeyHex)
    const bearer = helper('transitionedPicture')(
      sealedPicture,
      consignment,
      result,
      claimKey
    ) as Uint8Array
    const envelope = sealEnvelopeOf(bearer)!
    expect(envelope.claimSecretKeyHex).toBe(claimKey.secretKeyHex)
    expect(helper('transitionedPictureLine')(result, claimKey)).toMatch(
      /BEARER picture/
    )

    // whoever loads it is told so, and can take the key - for this very
    // consignment only
    const loaded = picked('art.seal.png', bearer)
    expect(helper('loadedPictureLine')(loaded)).toMatch(/bearer picture/)
    expect(helper('claimKeyOfPicture')(loaded, envelope.consignment)).toBe(
      claimKey.secretKeyHex
    )
    expect(helper('claimKeyOfPicture')(loaded, consignment)).toBe('')
    expect(helper('claimKeyOfPicture')(sealedPicture, consignment)).toBe('')
    expect(
      helper('canTransition')(envelope.consignment, claimKey.secretKeyHex)
    ).toBe(true)
  })

  it('shows a transition only under the consignment it extends', () => {
    const result = transitionTo(holder.pubkeyHex)
    expect(helper('transitionFollows')(consignment, result)).toBe(true)
    // the same result under the history it already produced, or another seal's
    const next = helper('nextConsignment')(consignment, result)
    expect(helper('transitionFollows')(next, result)).toBe(false)
    expect(helper('transitionFollows')(consignment, null)).toBe(false)
    expect(helper('transitionFollows')('', result)).toBe(false)
  })

  it('offers no picture when the file is not the seal’s, or the history does not follow', () => {
    const result = transitionTo(holder.pubkeyHex)
    const other = picked('other.jpg', JPG)
    expect(
      helper('canDownloadTransitioned')(other, consignment, result, null)
    ).toBe(false)
    expect(
      helper('canDownloadTransitioned')(null, consignment, result, null)
    ).toBe(false)
    expect(
      helper('canDownloadTransitioned')(sealedPicture, consignment, null, null)
    ).toBe(false)
    // a transition result left over from another seal
    const unrelated = encodeSealConsignment(LOCKED, [
      helper('prepareGenesis')('Art #2', '', issuer.pubkeyHex, picture).state
    ])
    expect(
      helper('canDownloadTransitioned')(sealedPicture, unrelated, result, null)
    ).toBe(false)
  })
})
