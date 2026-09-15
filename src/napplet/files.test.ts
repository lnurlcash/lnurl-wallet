import {it, expect, vi, afterEach} from 'vitest'
import {base64} from '@scure/base'
import {readShellFile, saveShellFile} from './files'

afterEach(() => vi.unstubAllGlobals())

it('reads and writes backup bytes within the shell chunk limits', async () => {
  const source = new TextEncoder().encode('{"label":"Grüße"}')
  let saved = new Uint8Array()
  const fs = {
    info: async () => ({limits: {maxReadBytes: 3, maxWriteBytes: 4}}),
    pickFile: async () => ({
      entries: [{path: '/chosen.json', kind: 'file', size: source.length}]
    }),
    pickSaveFile: async () => ({
      entries: [{path: '/saved.json', kind: 'file'}]
    }),
    read: vi.fn(async (_path, {offset, length}) => {
      const chunk = source.slice(offset, offset + length)
      return {
        data: base64.encode(chunk),
        bytesRead: chunk.length,
        offset,
        eof: offset + chunk.length === source.length
      }
    }),
    write: vi.fn(async (_path, data, {mode}) => {
      const chunk = base64.decode(data)
      saved = new Uint8Array([...(mode === 'append' ? saved : []), ...chunk])
      return {bytesWritten: chunk.length}
    })
  }
  vi.stubGlobal('window', {napplet: {fs}})
  expect(await readShellFile()).toBe('{"label":"Grüße"}')
  await saveShellFile('backup.json', '{"label":"Grüße"}')
  expect(saved).toEqual(source)
  expect(fs.write.mock.calls[0][2].mode).toBe('replace')
  expect(fs.write.mock.calls[1][2].mode).toBe('append')
})

it('reports truncated file writes and empty non-final reads', async () => {
  const fs = {
    info: async () => ({limits: {maxReadBytes: 100, maxWriteBytes: 100}}),
    pickFile: async () => ({entries: [{path: '/file.json', kind: 'file'}]}),
    pickSaveFile: async () => ({entries: [{path: '/file.json', kind: 'file'}]}),
    read: async () => ({data: '', bytesRead: 0, offset: 0, eof: false}),
    write: async () => ({bytesWritten: 1})
  }
  vi.stubGlobal('window', {napplet: {fs}})
  await expect(readShellFile()).rejects.toThrow('incomplete backup read')
  await expect(saveShellFile('file.json', '{}')).rejects.toThrow(
    'Incomplete backup write'
  )
})
