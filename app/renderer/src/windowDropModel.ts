import { ACCEPTED_IMAGE_TYPES } from './imageAttachment.js'
import { PINNED_SESSION_DRAG_MIME } from './sidebarPinnedSessions.js'
import { WORKSPACE_ORDER_DRAG_MIME } from './sidebarWorkspaceOrder.js'

export type DropFeedback = { allowed: boolean; title: string; detail: string }

/** Only MIME metadata is available before the user releases the drag. */
export function classifyWindowDrop(
  items: readonly { kind: string; type: string }[],
  types: readonly string[],
): DropFeedback | null {
  if (types.includes(WORKSPACE_ORDER_DRAG_MIME) || types.includes(PINNED_SESSION_DRAG_MIME)) return null
  const files = items.filter(item => item.kind === 'file')
  const images = files.filter(item => ACCEPTED_IMAGE_TYPES.some(type => type === item.type)).length
  if (images) return {
    allowed: true, title: 'Drop to attach',
    detail: `${images} ${images === 1 ? 'image' : 'images'}${files.length > images ? ' · Other files are skipped' : ''}`,
  }
  if (files.length || types.includes('Files')) {
    const onlyImages = files.length > 0 && files.every(item => item.type.startsWith('image/'))
    return onlyImages
      ? { allowed: false, title: "Can't attach this image", detail: 'Use PNG, JPEG, GIF, or WebP' }
      : { allowed: false, title: "Can't attach this file", detail: 'Use the + button to attach files' }
  }
  return types.includes('text/plain')
    ? { allowed: true, title: 'Drop to add text', detail: 'Adds it to your message' }
    : null
}
