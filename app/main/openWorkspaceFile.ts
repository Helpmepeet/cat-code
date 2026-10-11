import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { readSessionRelocation } from '../../src/utils/sessionRelocationState.js'

import type { SessionDescriptor } from '../shared/hostApi.js'
import type { OpenWorkspaceFileTarget } from '../shared/protocol.js'

export type { OpenWorkspaceFileTarget }

const MAX_OPEN_FILE_PATH_CHARS = 4_096
const MAX_SOURCE_COORDINATE = 2_147_483_647
const ALLOWED_TARGETS = new Set<string>(['default', 'vscode', 'zed', 'cursor', 'finder'])
const GENERATED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

export interface SourceLocation {
  line: number
  column?: number
}

export interface ResolvedWorkspaceFile {
  path: string
  target?: OpenWorkspaceFileTarget
  location?: SourceLocation
}

export interface WorkspaceFileOptions {
  generatedImagesRoot?: string
}

/** True when `target` is strictly beneath `root`, by canonical relative path. */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return !(rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
}

/** The opening and read-only availability boundaries share the same file policy. */
export async function resolveWorkspaceFile(
  input: unknown,
  sessions: readonly SessionDescriptor[],
  /**
   * The default GenerateImage output folder sits in the config home, outside any
   * workspace. Image files beneath it open like workspace files; nothing else
   * outside the workspace does.
   */
  options: WorkspaceFileOptions = {},
): Promise<ResolvedWorkspaceFile | null> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  if (Object.keys(record).some(key => key !== 'appSessionId' && key !== 'path' && key !== 'target')) {
    return null
  }
  const appSessionId = record.appSessionId
  const rawPath = record.path
  const target = record.target
  if (
    typeof appSessionId !== 'string' ||
    typeof rawPath !== 'string' ||
    rawPath.length === 0 ||
    rawPath.length > MAX_OPEN_FILE_PATH_CHARS ||
    rawPath.includes('\0') ||
    (target !== undefined && (typeof target !== 'string' || !ALLOWED_TARGETS.has(target)))
  ) {
    return null
  }

  const validTarget = target as OpenWorkspaceFileTarget | undefined
  const session = sessions.find(item => item.appSessionId === appSessionId)
  if (!session) return null

  try {
    // Without a message-origin identity, a historical relative link can name
    // an unrelated destination file. Relocated chats must use absolute links
    // until the opening boundary can validate the link's original workspace.
    if (!isAbsolute(rawPath) && session.engineSessionId && readSessionRelocation(session.engineSessionId)) {
      return null
    }
    const workspace = await realpath(session.cwd)
    const imagesRoot = options.generatedImagesRoot
      ? await realpath(options.generatedImagesRoot).catch(() => null)
      : null
    // A trailing :line[:column] is ambiguous on POSIX. Prefer a real literal
    // file first; only fall back to source-location parsing when that literal
    // cannot pass the same canonical containment and file checks.
    const candidates: Array<{ path: string; location?: SourceLocation }> = [{ path: rawPath }]
    const suffix = /:(\d+)(?::(\d+))?$/.exec(rawPath)
    if (suffix && suffix.index > 0) {
      const line = Number(suffix[1])
      const column = suffix[2] === undefined ? undefined : Number(suffix[2])
      if (
        Number.isSafeInteger(line) && line > 0 && line <= MAX_SOURCE_COORDINATE &&
        (column === undefined ||
          (Number.isSafeInteger(column) && column > 0 && column <= MAX_SOURCE_COORDINATE))
      ) {
        candidates.push({
          path: rawPath.slice(0, suffix.index),
          location: { line, ...(column === undefined ? {} : { column }) },
        })
      }
    }
    for (const candidate of candidates) {
      try {
        const requested = await realpath(resolve(workspace, candidate.path))
        const allowed =
          isInside(workspace, requested) ||
          (imagesRoot !== null &&
            GENERATED_IMAGE_EXTENSIONS.has(extname(requested).toLowerCase()) &&
            isInside(imagesRoot, requested))
        if (!allowed || !(await stat(requested)).isFile()) {
          continue
        }
        return {
          path: requested,
          ...(validTarget === undefined ? {} : { target: validTarget }),
          ...(candidate.location === undefined ? {} : { location: candidate.location }),
        }
      } catch {
        // A non-existent literal may still be a valid source-location target.
      }
    }
    return null
  } catch {
    return null
  }
}

export async function openWorkspaceFile(
  input: unknown,
  sessions: readonly SessionDescriptor[],
  openPath: (path: string, target?: OpenWorkspaceFileTarget, location?: SourceLocation) => Promise<boolean | string>,
  options: WorkspaceFileOptions = {},
): Promise<boolean> {
  const resolved = await resolveWorkspaceFile(input, sessions, options)
  if (!resolved) return false
  try {
    const result = await openPath(resolved.path, resolved.target, resolved.location)
    return typeof result === 'boolean' ? result : result === ''
  } catch {
    return false
  }
}
