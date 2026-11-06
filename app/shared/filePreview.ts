import type { OpenWorkspaceFileTarget } from './protocol.js'

export type FilePreviewKind = 'html' | 'markdown' | 'image' | 'svg' | 'text' | 'pdf' | 'xlsx' | 'localhost'
export type LocalhostPreviewNote = 'browser-required' | 'frame-blocked'
export interface FilePreviewDescriptor {
  id: string
  appSessionId: string
  path: string
  displayPath: string
  kind: FilePreviewKind
  url: string
  revision: number
  text?: string
  textWindow?: FilePreviewTextWindow
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

export interface FilePreviewLocation { line: number; column?: number }
export type FilePreviewTextWindowSide = 'start' | 'end'
export interface FilePreviewTextWindow {
  side: FilePreviewTextWindowSide
  truncated: boolean
  totalBytes: number
  shownBytes: number
  invalidUtf8: boolean
  firstLine: number | null
}
export type FilePreviewPrepareResult =
  | { ok: true; descriptor: FilePreviewDescriptor; location?: FilePreviewLocation }
  | { ok: false; reason: 'missing' | 'binary' | 'busy' | 'refused' | 'external' }

export const FILE_PREVIEW_KNOWN_NAMES = [
  'Dockerfile', 'Makefile', 'LICENSE', 'README', '.gitignore', '.gitattributes',
  '.editorconfig', '.dockerignore', '.nvmrc', '.env',
] as const
export const FILE_PREVIEW_PRIVATE_CONFIG_NAMES = [
  '.cat-code.json', '.cat-code-local-oauth.json', '.cat-code-staging-oauth.json', '.cat-code-custom-oauth.json',
  '.config.json', 'settings.json', 'settings.local.json', 'cowork_settings.json',
] as const
const TEXT_EXTENSIONS = new Set((
  'js jsx mjs cjs ts tsx mts cts py go rs java c h cc cpp hpp cs rb php swift kt kts lua r jl dart ex exs sql ' +
  'sh bash zsh fish css scss less vue svelte astro mdx json jsonc jsonl ndjson yaml yml toml ini conf cfg xml csv tsv ' +
  'ipynb graphql gql proto txt log diff patch tex bib http srt vtt mmd mermaid dot'
).split(' '))
const DOCUMENT_EXTENSIONS = new Set('pdf xlsx xls xlsm xlsb ods docx doc pptx ppt zip tar gz tgz bz2 xz 7z rar epub odt rtf numbers mp4 webm mov mp3 wav ogg m4a pem key p12 avif bmp ico apng heic tiff tif raw psd'.split(' '))
function fileName(path: string): string { return path.replace(/:\d+(?::\d+)?$/, '').split(/[\\/]/).at(-1) ?? '' }

/** Static hints only. Main also checks canonical paths and configured vault roots. */
export function isCredentialLikeFilePath(path: string): boolean {
  const parts = path.replace(/:\d+(?::\d+)?$/, '').replaceAll('\\', '/').toLowerCase().split('/')
  const name = parts.at(-1) ?? ''
  const example = name === '.env.example' || name === '.env.sample'
  return (!example && /^(?:\.env(?:\..*)?|credentials.*|\.credentials\.json|auth\.json|secrets\..*|\.netrc|\.npmrc|\.mcp\.json|\.claude\.json)$/i.test(name)) ||
    /\.(?:pem|key|p12|tfstate)$/i.test(name) ||
    /^\.cat-code(?:-(?:local|staging|custom)-oauth)?\.json$/i.test(name) ||
    parts.some((part, index) => part === '.cat-code' && index === parts.length - 2 && (FILE_PREVIEW_PRIVATE_CONFIG_NAMES as readonly string[]).includes(name)) ||
    parts.some(part => ['.ssh', '.aws', '.gnupg', '.kube', '.docker', 'claude-vault', 'codex-vault'].includes(part)) ||
    parts.some((part, index) => part === '.config' && ['gh', 'gcloud'].includes(parts[index + 1] ?? '')) ||
    parts.some((part, index) => part === '.claude' && index === parts.length - 2 && /^settings.*\.json$/i.test(name))
}

export function filePreviewKind(path: string): Exclude<FilePreviewKind, 'localhost'> | null {
  if (isCredentialLikeFilePath(path)) return null
  const name = fileName(path)
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()
  if (extension === 'html' || extension === 'htm') return 'html'
  if (extension === 'md' || extension === 'markdown') return 'markdown'
  if (extension === 'svg') return 'svg'
  if (extension === 'pdf' || extension === 'xlsx') return extension
  if (extension && ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)) return 'image'
  const text = extension !== undefined && TEXT_EXTENSIONS.has(extension) ||
    (FILE_PREVIEW_KNOWN_NAMES as readonly string[]).includes(name) ||
    name === '.env.example' || name === '.env.sample'
  return text ? 'text' : null
}

/** Mention detection includes formats whose plain click remains external. */
export function isKnownFileMention(path: string): boolean {
  const name = fileName(path)
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()
  return filePreviewKind(path) !== null || extension !== undefined && TEXT_EXTENSIONS.has(extension) || (FILE_PREVIEW_KNOWN_NAMES as readonly string[]).includes(name) ||
    extension !== undefined && DOCUMENT_EXTENSIONS.has(extension)
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
