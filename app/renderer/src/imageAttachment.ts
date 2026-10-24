import {
  MAX_ATTACHMENT_SOURCE_IMAGE_BYTES,
  type AttachmentImageMediaType,
} from '../../shared/hostApi.js'
import { IMAGE_MAX_HEIGHT, IMAGE_MAX_WIDTH } from '../../../src/constants/apiLimits.js'
import { MAX_SUBMIT_IMAGE_BYTES } from '../../../src/app-runtime/appSubmitLimits.js'

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

// Browser decoding happens before these dimensions are available. These guards
// bound subsequent canvas work, not the browser decoder's internal allocations.
const MAX_DECODED_PIXELS = 64 * 1024 * 1024
const MAX_DECODED_EDGE = 32_768

export async function prepareImageAttachment(
  file: File,
): Promise<PreparedImageAttachment> {
  if (!isAcceptedImageType(file.type)) {
    throw new Error('Choose a PNG, JPEG, GIF, or WebP image.')
  }
  if (file.size > MAX_ATTACHMENT_SOURCE_IMAGE_BYTES) {
    throw new Error('This image is too large to attach.')
  }

  const bitmap = await createImageBitmap(file)
  try {
    if (
      !Number.isSafeInteger(bitmap.width) || !Number.isSafeInteger(bitmap.height)
      || bitmap.width <= 0 || bitmap.height <= 0
      || bitmap.width > MAX_DECODED_EDGE || bitmap.height > MAX_DECODED_EDGE
      || bitmap.width * bitmap.height > MAX_DECODED_PIXELS
    ) {
      throw new Error('This image is too large to attach.')
    }
    let scale = Math.min(1, IMAGE_MAX_WIDTH / bitmap.width, IMAGE_MAX_HEIGHT / bitmap.height)
    if (scale === 1 && Math.ceil(file.size / 3) * 4 <= MAX_SUBMIT_IMAGE_BYTES) {
      const originalData = dataFromUrl(await readDataUrl(file))
      if (originalData.length <= MAX_SUBMIT_IMAGE_BYTES) {
        return { mediaType: file.type, data: originalData, name: file.name || 'Image' }
      }
    }
    for (let pass = 0; pass < 5; pass++) {
      const width = Math.max(1, Math.round(bitmap.width * scale))
      const height = Math.max(1, Math.round(bitmap.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Could not prepare this image.')
      context.drawImage(bitmap, 0, 0, width, height)

      // Try lossless PNG first for screenshots and alpha-bearing formats.
      const encodings: [AcceptedImageType, number | undefined][] = file.type === 'image/jpeg'
        ? []
        : [['image/png', undefined]]
      const compressedType = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp'
      for (const quality of [0.95, 0.85, 0.7, 0.5]) {
        encodings.push([compressedType, quality])
      }
      for (const [mediaType, quality] of encodings) {
        const url = canvas.toDataURL(mediaType, quality)
        // A browser can fall back to PNG when an encoder is unavailable.
        if (!url.startsWith(`data:${mediaType};base64,`)) continue
        const data = dataFromUrl(url)
        if (data.length <= MAX_SUBMIT_IMAGE_BYTES) {
          return {
            mediaType,
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
 * Accepted images from a transfer, in transfer order. If none are accepted,
 * the first unsupported image is still handed on so preparation can answer
 * with its own
 * "Choose a PNG, JPEG, GIF, or WebP image." rather than the drop silently doing
 * nothing.
 *
 * Non-image files are excluded on purpose. Turning a dropped file into a path the
 * engine reads would make the renderer the author of a filesystem path, which is
 * exactly what HC1 forbids; that is a separate decision, not this fix.
 */
export function selectAttachableImageFiles(
  files: readonly File[],
): File[] {
  const accepted = files.filter(file => isAcceptedImageType(file.type))
  if (accepted.length > 0) return accepted
  const unsupported = files.find(file => file.type.startsWith('image/'))
  return unsupported ? [unsupported] : []
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
