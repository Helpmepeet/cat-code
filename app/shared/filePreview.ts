import type { OpenWorkspaceFileTarget } from './protocol.js'

export type FilePreviewKind = 'html' | 'markdown' | 'image' | 'svg' | 'localhost'
export type LocalhostPreviewNote = 'browser-required' | 'frame-blocked'
export interface FilePreviewDescriptor {
  id: string
  appSessionId: string
  path: string
  displayPath: string
  kind: FilePreviewKind
  url: string
  revision: number
  markdown?: string
  watchError?: boolean
  frameName?: string
  baseUrl?: string
  routeKey?: string
  serverStopped?: boolean
  blockedHost?: string
  browserNote?: LocalhostPreviewNote
}
export interface FilePreviewScroll { x: number; y: number }
export type FilePreviewSource = Pick<FilePreviewDescriptor, 'id' | 'revision'>
export interface FilePreviewApplications {
  applications: Array<{ target: OpenWorkspaceFileTarget; label: string }>
  selected: OpenWorkspaceFileTarget
}
export type FilePreviewEvent =
  | { id: string; kind: 'updated'; descriptor: FilePreviewDescriptor }
  | { id: string; kind: 'removed' | 'watch-error' | 'update-error' }
  | { id: string; kind: 'navigate'; path: string; source?: FilePreviewSource }
  | { id: string; kind: 'route'; url: string; scroll: FilePreviewScroll; routeKey: string; replace?: boolean; browserNote?: LocalhostPreviewNote }
  | { id: string; kind: 'server-stopped' }
  | { id: string; kind: 'leave'; host: string }
  | { id: string; kind: 'browser-note'; path: string; note: LocalhostPreviewNote }
  | { id: string; kind: 'key'; key: string; code: string; metaKey: boolean; shiftKey: boolean; altKey: boolean; ctrlKey: boolean }

export function filePreviewKind(path: string): Exclude<FilePreviewKind, 'localhost'> | null {
  const extension = /\.([a-z]+)$/i.exec(path.replace(/:\d+(?::\d+)?$/, ''))?.[1]?.toLowerCase()
  if (extension === 'html' || extension === 'htm') return 'html'
  if (extension === 'md' || extension === 'markdown') return 'markdown'
  if (extension === 'svg') return 'svg'
  return extension && ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension) ? 'image' : null
}

export const FILE_PREVIEW_SCHEME = 'cat-preview'


export type LocalhostPreviewResult =
  | { ok: true; descriptor: FilePreviewDescriptor }
  | { ok: false; reason: 'refused' }
  | { ok: false; reason: 'unavailable'; hostPort: string }
export type PreviewBrowserTarget = 'chrome' | 'safari'

/** Keep raw authority checks ahead of WHATWG's numeric host normalization. */
export function normalizeLocalhostPreviewUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u0020\u007f\\]/.test(value)) return null
  const authority = /^http:\/\/([^/?#]+)/i.exec(value)?.[1]
  if (!authority) return null
  const match = /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/i.exec(authority)
  if (!match || match[2] !== undefined && (Number(match[2]) < 1 || Number(match[2]) > 65535)) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && !url.username && !url.password ? url.href : null
  } catch { return null }
}

export function localhostPreviewHostPort(value: string): string | null {
  const normalized = normalizeLocalhostPreviewUrl(value)
  if (!normalized) return null
  const url = new URL(normalized)
  return `${url.hostname}:${url.port || '80'}`
}
