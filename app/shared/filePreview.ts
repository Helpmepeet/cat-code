import type { OpenWorkspaceFileTarget } from './protocol.js'

export type FilePreviewKind = 'html' | 'markdown' | 'image' | 'svg'
export interface FilePreviewDescriptor {
  id: string
  appSessionId: string
  path: string
  displayPath: string
  kind: FilePreviewKind
  url: string
  revision: number
  markdown?: string
}
export interface FilePreviewScroll { x: number; y: number }
export interface FilePreviewApplications {
  applications: Array<{ target: OpenWorkspaceFileTarget; label: string }>
  selected: OpenWorkspaceFileTarget
}
export type FilePreviewEvent =
  | { id: string; kind: 'updated'; descriptor: FilePreviewDescriptor }
  | { id: string; kind: 'removed' | 'watch-error' }
  | { id: string; kind: 'navigate'; path: string }
  | { id: string; kind: 'key'; key: string; code: string; metaKey: boolean; shiftKey: boolean; altKey: boolean; ctrlKey: boolean }

export function filePreviewKind(path: string): FilePreviewKind | null {
  const extension = /\.([a-z]+)$/i.exec(path.replace(/:\d+(?::\d+)?$/, ''))?.[1]?.toLowerCase()
  if (extension === 'html' || extension === 'htm') return 'html'
  if (extension === 'md' || extension === 'markdown') return 'markdown'
  if (extension === 'svg') return 'svg'
  return extension && ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension) ? 'image' : null
}

export const FILE_PREVIEW_SCHEME = 'cat-preview'
