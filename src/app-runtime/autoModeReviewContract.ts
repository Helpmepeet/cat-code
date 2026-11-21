export const AUTO_MODE_NO_EXPLANATION = 'The reviewer returned no explanation.'
export const AUTO_MODE_REJECTION_PREFIX = 'Permission for this action has been denied. Reason: '

export type AutoModeReview = {
  type: 'tool.review'
  toolUseId: string
  attemptId: string
  startedAt: number
  completedAt?: number
  outcome: 'reviewing' | 'allowed' | 'blocked' | 'asking' | 'inconclusive'
  reason?: string
  reviewer?: {
    kind: 'contextual'
    version: string
    profile?: { provider: string; model: string; effort: 'provider-default'; promptDigest: string }
    verdict?: 'allow' | 'ask' | 'deny'
  }
}

function isReviewer(value: unknown): value is NonNullable<AutoModeReview['reviewer']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const reviewer = value as Record<string, unknown>
  if (Object.keys(reviewer).some(key => !['kind', 'version', 'profile', 'verdict'].includes(key))) return false
  if (reviewer.kind !== 'contextual' || typeof reviewer.version !== 'string' || !reviewer.version || reviewer.version.length > 100) return false
  if (reviewer.verdict !== undefined && (!reviewer.profile || !['allow', 'ask', 'deny'].includes(reviewer.verdict as string))) return false
  if (reviewer.profile === undefined) return true
  if (!reviewer.profile || typeof reviewer.profile !== 'object' || Array.isArray(reviewer.profile)) return false
  const profile = reviewer.profile as Record<string, unknown>
  return Object.keys(profile).length === 4 &&
    [profile.provider, profile.model].every(item => typeof item === 'string' && item.length > 0 && item.length <= 200) &&
    profile.effort === 'provider-default' && typeof profile.promptDigest === 'string' && /^[a-f0-9]{64}$/.test(profile.promptDigest)
}

/** Closed display-only contract. Reasons are never model messages. */
export function isAutoModeReview(value: unknown): value is AutoModeReview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (Object.keys(v).some(key => !['type', 'toolUseId', 'attemptId', 'startedAt', 'completedAt', 'outcome', 'reason', 'reviewer'].includes(key))) return false
  if (v.type !== 'tool.review') return false
  if (![v.toolUseId, v.attemptId].every(id => typeof id === 'string' && id.length > 0 && id.length <= 200)) return false
  if (typeof v.startedAt !== 'number' || !Number.isSafeInteger(v.startedAt) || v.startedAt < 0) return false
  if (!['reviewing', 'allowed', 'blocked', 'asking', 'inconclusive'].includes(v.outcome as string)) return false
  if (v.reason !== undefined && typeof v.reason !== 'string') return false
  if (v.reviewer !== undefined && !isReviewer(v.reviewer)) return false
  if (v.outcome === 'reviewing') return v.completedAt === undefined && v.reason === undefined
  if (v.outcome === 'inconclusive' && v.completedAt === undefined) return true
  return typeof v.completedAt === 'number' && Number.isSafeInteger(v.completedAt) && v.completedAt >= v.startedAt
}
