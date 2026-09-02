import {
  MAX_ATTACHMENT_SOURCE_IMAGE_BYTES,
  type AttachmentImageMediaType,
} from '../../shared/hostApi.js'

export const ACCEPTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const

export type AcceptedImageType = AttachmentImageMediaType

export type PreparedImageAttachment = {
  mediaType: AcceptedImageType
  data: string
  name: string
}

const MAX_IMAGE_BASE64_CHARS = 90_000
const MAX_IMAGE_EDGE = 1_600

export async function prepareImageAttachment(
  file: File,
): Promise<PreparedImageAttachment> {
  if (!isAcceptedImageType(file.type)) {
    throw new Error('Choose a PNG, JPEG, GIF, or WebP image.')
  }
  if (file.size > MAX_ATTACHMENT_SOURCE_IMAGE_BYTES) {
    throw new Error('This image is too large to attach.')
  }

  if (Math.ceil(file.size / 3) * 4 <= MAX_IMAGE_BASE64_CHARS) {
    const original = await readDataUrl(file)
    const originalData = dataFromUrl(original)
    if (originalData.length <= MAX_IMAGE_BASE64_CHARS) {
      return { mediaType: file.type, data: originalData, name: file.name || 'Image' }
    }
  }

  const bitmap = await createImageBitmap(file)
  try {
    let scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height))
    for (let pass = 0; pass < 5; pass++) {
      const width = Math.max(1, Math.round(bitmap.width * scale))
      const height = Math.max(1, Math.round(bitmap.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Could not prepare this image.')
      context.drawImage(bitmap, 0, 0, width, height)

      for (const quality of [0.82, 0.68, 0.54, 0.4]) {
        const data = dataFromUrl(canvas.toDataURL('image/jpeg', quality))
        if (data.length <= MAX_IMAGE_BASE64_CHARS) {
          return {
            mediaType: 'image/jpeg',
            data,
            name: file.name || 'Image',
          }
        }
      }
      scale *= 0.72
    }
  } finally {
    bitmap.close()
  }

  throw new Error('This image is too large to attach.')
}

/**
 * The one image to attach out of a transfer's file list, or null when it carries
 * none. Used by the composer's drop path, and shaped like the ⌘V path it shares
 * `prepareImageAttachment` with: an accepted type wins, otherwise ANY `image/*`
 * is still handed on so `prepareImageAttachment` can answer with its own
 * "Choose a PNG, JPEG, GIF, or WebP image." rather than the drop silently doing
 * nothing.
 *
 * Non-image files return null on purpose. Turning a dropped file into a path the
 * engine reads would make the renderer the author of a filesystem path, which is
 * exactly what HC1 forbids; that is a separate decision, not this fix.
 */
export function selectAttachableImageFile(
  files: readonly File[],
): File | null {
  return (
    files.find(file => isAcceptedImageType(file.type)) ??
    files.find(file => file.type.startsWith('image/')) ??
    null
  )
}

function isAcceptedImageType(value: string): value is AcceptedImageType {
  return ACCEPTED_IMAGE_TYPES.some(type => type === value)
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read this image.'))
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('Could not read this image.'))
    reader.readAsDataURL(file)
  })
}

function dataFromUrl(url: string): string {
  const comma = url.indexOf(',')
  if (comma < 0) throw new Error('Could not prepare this image.')
  return url.slice(comma + 1)
}
