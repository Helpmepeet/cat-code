export type AutoModeReview = {
  type: 'tool.review'
  toolUseId: string
  attemptId: string
  startedAt: number
  completedAt?: number
  outcome: 'reviewing' | 'allowed' | 'blocked' | 'inconclusive'
  reason?: string
}

/** Closed display-only contract. Reasons are never model messages. */
export function isAutoModeReview(value: unknown): value is AutoModeReview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (Object.keys(v).some(key => !['type', 'toolUseId', 'attemptId', 'startedAt', 'completedAt', 'outcome', 'reason'].includes(key))) return false
  if (v.type !== 'tool.review') return false
  if (![v.toolUseId, v.attemptId].every(id => typeof id === 'string' && id.length > 0 && id.length <= 200)) return false
  if (typeof v.startedAt !== 'number' || !Number.isSafeInteger(v.startedAt) || v.startedAt < 0) return false
  if (!['reviewing', 'allowed', 'blocked', 'inconclusive'].includes(v.outcome as string)) return false
  if (v.reason !== undefined && typeof v.reason !== 'string') return false
  if (v.outcome === 'reviewing') return v.completedAt === undefined && v.reason === undefined
  if (v.outcome === 'inconclusive' && v.completedAt === undefined) return true
  return typeof v.completedAt === 'number' && Number.isSafeInteger(v.completedAt) && v.completedAt >= v.startedAt
}
