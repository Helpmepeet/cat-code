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
  const otherFiles = files.filter(item => !item.type.startsWith('image/')).length
  if (otherFiles > 1) return {
    allowed: false, title: "Can't attach these files", detail: 'Attach one file at a time',
  }
  if (images || otherFiles) return {
    allowed: true, title: 'Drop to attach',
    detail: [images ? `${images} ${images === 1 ? 'image' : 'images'}` : '', otherFiles ? '1 file' : ''].filter(Boolean).join(' and '),
  }
  if (files.length || types.includes('Files')) {
    const onlyImages = files.length > 0 && files.every(item => item.type.startsWith('image/'))
    return onlyImages
      ? { allowed: false, title: "Can't attach this image", detail: 'Use PNG, JPEG, GIF, or WebP' }
      : { allowed: true, title: 'Drop to attach', detail: '1 file' }
  }
  return types.includes('text/plain')
    ? { allowed: true, title: 'Drop to add text', detail: 'Adds it to your message' }
    : null
}
