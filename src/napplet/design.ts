export type NoteDesign = {
  title: string
  subtitle: string
  ink: string
  paper: string
  image?: string
}

export const DEFAULT_DESIGN: NoteDesign = {
  title: 'LNURLCASH BEARER NOTE',
  subtitle: 'Whoever holds the note holds the sats.',
  ink: '#174c3a',
  paper: '#f3ecd3'
}
export const DESIGN_CONVENTION = 'napplet:bearer-designer/open'

/** Accept only bounded text, hex colors and local raster images. */
export const parseDesign = (value: unknown): NoteDesign => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid note design.')
  const d = value as Record<string, unknown>
  if (
    typeof d.title !== 'string' ||
    !d.title.trim() ||
    d.title.length > 48 ||
    typeof d.subtitle !== 'string' ||
    d.subtitle.length > 100 ||
    typeof d.ink !== 'string' ||
    !/^#[0-9a-f]{6}$/i.test(d.ink) ||
    typeof d.paper !== 'string' ||
    !/^#[0-9a-f]{6}$/i.test(d.paper) ||
    (d.image !== undefined &&
      (typeof d.image !== 'string' ||
        d.image.length > 180000 ||
        !/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(d.image)))
  ) {
    throw new Error(
      'Use short text, hex colors and a PNG, JPEG or WebP image under 130 KB.'
    )
  }
  return {
    title: d.title.trim(),
    subtitle: d.subtitle,
    ink: d.ink,
    paper: d.paper,
    ...(d.image ? {image: d.image as string} : {})
  }
}

/** Resize user artwork locally; no uploaded bytes leave through a network service. */
export const readArtwork = async (file: File): Promise<string> => {
  if (
    !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
    file.size > 10 * 1024 * 1024
  ) {
    throw new Error('Choose a PNG, JPEG or WebP image smaller than 10 MB.')
  }
  const bitmap = await createImageBitmap(file)
  try {
    if (bitmap.width * bitmap.height > 40_000_000)
      throw new Error('Image dimensions are too large.')
    const scale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')!
    context.fillStyle = '#f3ecd3'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    for (const quality of [0.85, 0.65, 0.4, 0.2]) {
      const image = canvas.toDataURL('image/jpeg', quality)
      if (image.length <= 180000) return image
    }
    throw new Error(
      'The image is too detailed. Choose a simpler or smaller image.'
    )
  } finally {
    bitmap.close()
  }
}
