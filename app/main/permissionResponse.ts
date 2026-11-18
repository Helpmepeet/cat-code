import { MAX_SUGGESTION_SELECTIONS } from '../shared/limits.js'
import { PROTOCOL_VERSION, type ErrorFrame, type SessionId, type SidecarClientMessage } from '../shared/protocol.js'

export type CoercedPermissionResponse =
  | { behavior: 'allow'; updatedInput: Record<string, unknown>; applySuggestions?: number[]; acceptFeedback?: string }
  | { behavior: 'deny'; message: string }

// Renderer selections are indices only. The sidecar owns rules and input validation.
function coercePermissionResponse(response: unknown): CoercedPermissionResponse | null {
  if (typeof response !== 'object' || response === null) return null
  const r = response as Record<string, unknown>
  if (r.acceptFeedback !== undefined &&
      (r.behavior !== 'allow' || typeof r.acceptFeedback !== 'string' || r.acceptFeedback.length > 16_384)) return null
  if (r.behavior === 'deny' && typeof r.message === 'string') return { behavior: 'deny', message: r.message }
  if (r.behavior !== 'allow') return null
  const updatedInput = typeof r.updatedInput === 'object' && r.updatedInput !== null && !Array.isArray(r.updatedInput)
    ? r.updatedInput as Record<string, unknown> : {}
  if (r.applySuggestions !== undefined &&
      (!Array.isArray(r.applySuggestions) || r.applySuggestions.length > MAX_SUGGESTION_SELECTIONS ||
       !Array.from(r.applySuggestions).every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0))) return null
  return {
    behavior: 'allow', updatedInput,
    ...(Array.isArray(r.applySuggestions) && r.applySuggestions.length > 0 ? { applySuggestions: r.applySuggestions as number[] } : {}),
    ...(typeof r.acceptFeedback === 'string' ? { acceptFeedback: r.acceptFeedback } : {}),
  }
}

export function preparePermissionResponse(
  sessionId: SessionId,
  requestId: string,
  input: unknown,
): Extract<SidecarClientMessage, { type: 'permission.response' }> | ErrorFrame {
  const response = coercePermissionResponse(input)
  if (response) return { type: 'permission.response', requestId, response }
  return {
    kind: 'error',
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    requestId,
    code: 'bad_request',
    message: 'Could not send the permission response. Check your selections and try again.',
    retryable: true,
  }
}
