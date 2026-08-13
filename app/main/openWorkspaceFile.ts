import { isAbsolute, relative, resolve, sep } from 'node:path'
import { realpath, stat } from 'node:fs/promises'

import type { SessionDescriptor } from '../shared/hostApi.js'

const MAX_OPEN_FILE_PATH_CHARS = 4_096

export async function openWorkspaceFile(
  input: unknown,
  sessions: readonly SessionDescriptor[],
  openPath: (path: string) => Promise<string>,
): Promise<boolean> {
  if (input === null || typeof input !== 'object') return false
  const record = input as Record<string, unknown>
  if (Object.keys(record).some(key => key !== 'appSessionId' && key !== 'path')) {
    return false
  }
  const appSessionId = record.appSessionId
  const path = record.path
  if (
    typeof appSessionId !== 'string' ||
    typeof path !== 'string' ||
    path.length === 0 ||
    path.length > MAX_OPEN_FILE_PATH_CHARS ||
    path.includes('\0')
  ) {
    return false
  }

  const session = sessions.find(item => item.appSessionId === appSessionId)
  if (!session) return false

  try {
    const workspace = await realpath(session.cwd)
    const requested = await realpath(resolve(workspace, path))
    const fromWorkspace = relative(workspace, requested)
    if (
      fromWorkspace === '' ||
      fromWorkspace === '..' ||
      fromWorkspace.startsWith(`..${sep}`) ||
      isAbsolute(fromWorkspace) ||
      !(await stat(requested)).isFile()
    ) {
      return false
    }
    return (await openPath(requested)) === ''
  } catch {
    return false
  }
}
