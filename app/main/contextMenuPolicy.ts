/**
 * Decisions behind the native right-click menu. Electron shows no context menu
 * on its own, so `main.ts` builds one from the `context-menu` event params; the
 * decisions that need no Electron API live here so they are unit-testable.
 *
 * The renderer authors nothing: main reads `srcURL` from the event, decodes only
 * `data:` images it can bound, and picks the destination through the user's own
 * save dialog.
 */

/** Largest image main will decode for Save Image As; matches the paste/attach ceiling order of magnitude. */
export const MAX_SAVED_IMAGE_BYTES = 25 * 1024 * 1024

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

export type DecodedImage = { bytes: Buffer; extension: string }

/** Decode a base64 `data:image/*` URL; null for anything else or past the bound. */
export function decodeImageDataUrl(srcURL: string): DecodedImage | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]*)$/i.exec(srcURL)
  if (!match) return null
  const extension = IMAGE_EXTENSIONS[match[1]!.toLowerCase()]
  if (!extension) return null
  const base64 = match[2]!.replace(/\s+/g, '')
  // 3 bytes per 4 characters: reject before allocating.
  if ((base64.length / 4) * 3 > MAX_SAVED_IMAGE_BYTES) return null
  const bytes = Buffer.from(base64, 'base64')
  return bytes.length > 0 ? { bytes, extension } : null
}

export type ContextMenuParams = {
  mediaType: string
  srcURL: string
  isEditable: boolean
  selectionText: string
}

export type ContextMenuPlan = {
  copyImage: boolean
  saveImage: boolean
  edit: 'none' | 'selection' | 'editable'
}

export function planContextMenu(params: ContextMenuParams): ContextMenuPlan {
  const isImage = params.mediaType === 'image'
  return {
    copyImage: isImage,
    saveImage: isImage && decodeImageDataUrl(params.srcURL) !== null,
    edit: params.isEditable
      ? 'editable'
      : params.selectionText.length > 0
        ? 'selection'
        : 'none',
  }
}
