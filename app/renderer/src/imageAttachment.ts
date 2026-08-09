export const ACCEPTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const

export type AcceptedImageType = (typeof ACCEPTED_IMAGE_TYPES)[number]

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

  const original = await readDataUrl(file)
  const originalData = dataFromUrl(original)
  if (originalData.length <= MAX_IMAGE_BASE64_CHARS) {
    return { mediaType: file.type, data: originalData, name: file.name || 'Image' }
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
