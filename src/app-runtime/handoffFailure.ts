import type { WorkspaceHandoffFailure } from '../../app/shared/workspaceHandoff.js'
import { ResumeIdentityError } from '../utils/resumeCheckpoint.js'

const IO_CODES = new Set(['EIO', 'ENOSPC', 'EACCES', 'EPERM', 'ENOENT', 'EROFS', 'EDQUOT', 'EBUSY'])

/** Never copy exception text or tool/transcript content into status or logs. */
export function handoffFailure(stage: WorkspaceHandoffFailure['stage'], error: unknown): WorkspaceHandoffFailure {
  for (let cause = error, depth = 0; cause && depth < 4; depth++) {
    if (cause instanceof ResumeIdentityError) return { stage, reason: cause.reason,
      ...(cause.messageUuid ? { messageUuid: cause.messageUuid } : {}),
      ...(cause.messageType ? { messageType: cause.messageType } : {}) }
    const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined
    if (typeof code === 'string' && IO_CODES.has(code)) return { stage, reason: 'unknown', ioCode: code as WorkspaceHandoffFailure['ioCode'] }
    cause = cause instanceof Error ? cause.cause : undefined
  }
  return { stage, reason: 'unknown' }
}
