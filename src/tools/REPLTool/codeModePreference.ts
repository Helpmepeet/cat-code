import { constants } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getSessionId, isFreshSession, isSessionPersistenceDisabled } from '../../bootstrap/state.js'
import type { ToolUseContext } from '../../Tool.js'
import { writeFileAtomicDurable } from '../../utils/atomicFile.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { logError } from '../../utils/log.js'
import { assertActiveTranscriptLease } from '../../utils/transcriptLease.js'
import { validateUuid } from '../../utils/uuid.js'
import { CODE_MODE_DEFAULT_FOR_NEW_SESSIONS } from './constants.js'

type PreferenceContext = Pick<ToolUseContext, 'getAppState' | 'setAppState'>

function preferencePath(sessionId: string): string {
  const id = validateUuid(sessionId)
  if (!id) throw new Error('Invalid Code Mode session ID')
  return join(getClaudeConfigHomeDir(), 'code-mode-preferences', `${id}.mode`)
}

async function loadPreference(sessionId: string): Promise<boolean> {
  if (isSessionPersistenceDisabled()) return false
  try {
    const file = await open(preferencePath(sessionId), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 4 || (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return false
      const bytes = Buffer.alloc(5)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      return bytes.subarray(0, bytesRead).toString() === 'on\n'
    } finally {
      await file.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logError(error)
    return false
  }
}

export async function initializeCodeModePreference(context: PreferenceContext): Promise<void> {
  const sessionId = getSessionId()
  if (context.getAppState().codeModePreference?.sessionId === sessionId) return
  const fresh = isFreshSession()
  let enabled = fresh ? CODE_MODE_DEFAULT_FOR_NEW_SESSIONS : await loadPreference(sessionId)
  let saveFailed = false
  if (fresh && enabled && !isSessionPersistenceDisabled()) {
    try {
      const path = preferencePath(sessionId)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      if (getSessionId() !== sessionId) return
      assertActiveTranscriptLease(sessionId)
      await writeFileAtomicDurable(path, 'on\n', { mode: 0o600 })
    } catch (error) {
      logError(error)
      enabled = false
      saveFailed = true
    }
  }
  context.setAppState(state => getSessionId() !== sessionId || state.codeModePreference?.sessionId === sessionId
    ? state : { ...state, codeModePreference: { sessionId, enabled, saveFailed } })
}
