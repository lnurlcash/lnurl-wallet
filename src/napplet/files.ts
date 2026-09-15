import {base64} from '@scure/base'

/** Save a user-selected file through the shell instead of blocked iframe downloads. */
export const saveShellFile = async (
  name: string,
  text: string
): Promise<void> => {
  const fs = window.napplet?.fs
  if (!fs)
    throw new Error(
      'This shell has no file interface. Select and save the JSON text instead.'
    )
  const selected = await fs.pickSaveFile({
    suggestedName: name,
    permissions: ['write', 'create'],
    accept: [{extension: '.json'}]
  })
  const file = selected.entries[0]
  if (!file || file.kind !== 'file') throw new Error('No file was selected.')
  const bytes = new TextEncoder().encode(text)
  const limit = (await fs.info()).limits.maxWriteBytes
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error('The shell cannot write a backup file.')
  for (let offset = 0; offset < bytes.length; offset += limit) {
    const chunk = bytes.slice(offset, offset + limit)
    const result = await fs.write(file.path, base64.encode(chunk), {
      mode: offset ? 'append' : 'replace'
    })
    if (result.bytesWritten !== chunk.length)
      throw new Error('Incomplete backup write. Save the backup again.')
  }
}

/** Read one selected backup with a decoded-byte bound. */
export const readShellFile = async (): Promise<string> => {
  const fs = window.napplet?.fs
  if (!fs)
    throw new Error(
      'This shell has no file interface. Choose a local file or paste JSON instead.'
    )
  const selected = await fs.pickFile({
    permissions: ['read'],
    accept: [{extension: '.json'}]
  })
  const file = selected.entries[0]
  if (!file || file.kind !== 'file' || (file.size ?? 0) > 10 * 1024 * 1024)
    throw new Error('Invalid or oversized backup file.')
  const max = 10 * 1024 * 1024
  const limit = Math.min((await fs.info()).limits.maxReadBytes, max)
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error('The shell cannot read a backup file.')
  const parts: Uint8Array[] = []
  let offset = 0
  while (true) {
    const result = await fs.read(file.path, {
      offset,
      length: Math.min(limit, max + 1 - offset)
    })
    const bytes = base64.decode(result.data)
    if (
      result.offset !== offset ||
      result.bytesRead !== bytes.length ||
      bytes.length > limit ||
      (!bytes.length && !result.eof)
    )
      throw new Error('The shell returned an incomplete backup read.')
    parts.push(bytes)
    offset += bytes.length
    if (offset > max) throw new Error('Backup exceeds 10 MB.')
    if (result.eof) break
  }
  const contents = new Uint8Array(offset)
  let position = 0
  for (const part of parts) {
    contents.set(part, position)
    position += part.length
  }
  return new TextDecoder().decode(contents)
}
