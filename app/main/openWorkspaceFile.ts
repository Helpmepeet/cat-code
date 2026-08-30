import { isAbsolute, relative, resolve, sep } from 'node:path'
import { realpath, stat } from 'node:fs/promises'

import type { SessionDescriptor } from '../shared/hostApi.js'
import type { OpenWorkspaceFileTarget } from '../shared/protocol.js'

export type { OpenWorkspaceFileTarget }

const MAX_OPEN_FILE_PATH_CHARS = 4_096
const ALLOWED_TARGETS = new Set<string>(['default', 'vscode', 'zed', 'cursor', 'finder'])

export async function openWorkspaceFile(
  input: unknown,
  sessions: readonly SessionDescriptor[],
  openPath: (path: string, target?: OpenWorkspaceFileTarget) => Promise<boolean | string>,
): Promise<boolean> {
  if (input === null || typeof input !== 'object') return false
  const record = input as Record<string, unknown>
  if (Object.keys(record).some(key => key !== 'appSessionId' && key !== 'path' && key !== 'target')) {
    return false
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
    return false
  }

  const validTarget = target as OpenWorkspaceFileTarget | undefined
  const session = sessions.find(item => item.appSessionId === appSessionId)
  if (!session) return false

  try {
    const workspace = await realpath(session.cwd)
    // A trailing :line[:column] is ambiguous on POSIX. Prefer a real literal
    // file first; only fall back to source-location parsing when that literal
    // cannot pass the same canonical containment and file checks.
    const candidates = [rawPath]
    const withoutLocation = rawPath.replace(/:\d+(?::\d+)?$/, '')
    if (withoutLocation.length > 0 && withoutLocation !== rawPath) {
      candidates.push(withoutLocation)
    }
    for (const candidate of candidates) {
      try {
        const requested = await realpath(resolve(workspace, candidate))
        const fromWorkspace = relative(workspace, requested)
        if (
          fromWorkspace === '' ||
          fromWorkspace === '..' ||
          fromWorkspace.startsWith(`..${sep}`) ||
          isAbsolute(fromWorkspace) ||
          !(await stat(requested)).isFile()
        ) {
          continue
        }
        const result = await openPath(requested, validTarget)
        return typeof result === 'boolean' ? result : result === ''
      } catch {
        // A non-existent literal may still be a valid source-location target.
      }
    }
    return false
  } catch {
    return false
  }
}
