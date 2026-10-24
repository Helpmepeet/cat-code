import { API_IMAGE_MAX_BASE64_SIZE } from '../constants/apiLimits.js'

/** Encoded bytes, not the decoded image's source-file size. */
export const MAX_SUBMIT_IMAGE_BYTES = API_IMAGE_MAX_BASE64_SIZE
export const MAX_SUBMIT_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_SUBMIT_IMAGES = 5
export const MAX_SUBMIT_TEXT_BYTES = 96 * 1024

const encoder = new TextEncoder()
const mediaTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

/** Scan once without quantified regex groups that overflow on large images. */
export function isSubmitImageBase64(data: string): boolean {
  if (!data.length || data.length % 4 !== 0) return false
  const end = data.endsWith('==') ? data.length - 2 : data.endsWith('=') ? data.length - 1 : data.length
  for (let i = 0; i < end; i++) {
    const c = data.charCodeAt(i)
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      (c >= 48 && c <= 57) || c === 43 || c === 47)) return false
  }
  return true
}

export function validateAppSubmitPromptBudget(prompt: unknown): string | null {
  if (typeof prompt === 'string') {
    if (!prompt.length) return 'Enter a message.'
    return encoder.encode(prompt).byteLength <= MAX_SUBMIT_TEXT_BYTES
      ? null : 'That message is too long to send. Shorten it and try again.'
  }
  if (!Array.isArray(prompt) || !prompt.length || prompt.length > MAX_SUBMIT_IMAGES + 1) {
    return 'Invalid message content.'
  }
  let textBytes = 0
  let imageBytes = 0
  let images = 0
  for (const block of prompt) {
    if (!record(block)) return 'Invalid message content.'
    if (block.type === 'text') {
      if (!keys(block, ['type', 'text']) || typeof block.text !== 'string' || !block.text.length) return 'Invalid message text.'
      textBytes += encoder.encode(block.text).byteLength
      if (textBytes > MAX_SUBMIT_TEXT_BYTES) return 'That message is too long to send. Shorten it and try again.'
    } else if (block.type === 'image') {
      if (!keys(block, ['type', 'source']) || !record(block.source)) return 'Invalid image content.'
      const source = block.source
      if (!keys(source, ['type', 'media_type', 'data']) || source.type !== 'base64' ||
        typeof source.media_type !== 'string' || !mediaTypes.has(source.media_type) || typeof source.data !== 'string') return 'Invalid image content.'
      if (++images > MAX_SUBMIT_IMAGES) return 'A message can include at most 5 images.'
      if (source.data.length > MAX_SUBMIT_IMAGE_BYTES) return 'An encoded image exceeds the 5 MiB limit.'
      imageBytes += source.data.length
      if (imageBytes > MAX_SUBMIT_TOTAL_IMAGE_BYTES) return 'Encoded images exceed the 10 MiB message limit.'
      if (!isSubmitImageBase64(source.data)) return 'Invalid base64 image data.'
    } else return 'Unsupported message content.'
  }
  return images ? null : 'Content-block messages must include an image.'
}
