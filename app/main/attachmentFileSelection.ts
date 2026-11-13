import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import { MAX_ATTACHMENT_SOURCE_IMAGE_BYTES, type AttachmentFileSelection } from '../shared/hostApi.js'
import { detectAttachmentImageMediaType } from './mainDecisions.js'

/** Both picker and preload-derived drops cross the same main-owned boundary. */
export function selectAttachmentFile(
  appSessionId: unknown,
  path: unknown,
  mint: (sessionId: string, path: string) => AttachmentFileSelection,
): AttachmentFileSelection {
  const invalid: AttachmentFileSelection = { kind: 'error', message: 'Choose a readable file, not a folder, and try again.' }
  if (typeof appSessionId !== 'string' || !appSessionId || typeof path !== 'string' || !isAbsolute(path) || path.includes('"')) return invalid
  try {
    const realpath = realpathSync(path)
    const stats = statSync(realpath)
    if (!stats.isFile() || realpath.includes('"')) return invalid
    const handle = openSync(realpath, 'r')
    const header = new Uint8Array(12)
    let length: number
    try { length = readSync(handle, header, 0, header.length, 0) }
    finally { closeSync(handle) }
    const mediaType = detectAttachmentImageMediaType(header.subarray(0, length))
    if (mediaType) {
      const tooLarge: AttachmentFileSelection = { kind: 'error', message: 'This image is too large to attach.' }
      if (stats.size > MAX_ATTACHMENT_SOURCE_IMAGE_BYTES) return tooLarge
      const bytes = readFileSync(realpath)
      if (bytes.byteLength > MAX_ATTACHMENT_SOURCE_IMAGE_BYTES) return tooLarge
      return { kind: 'image', name: basename(realpath), mediaType, bytes: new Uint8Array(bytes) }
    }
    return mint(appSessionId, realpath)
  } catch { return invalid }
}
