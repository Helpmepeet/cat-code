import { getClaudeRelease, matchClaudeRelease } from './model/configs.js'
import { isClaudeAISubscriber } from './auth.js'
import { has1mContext } from './context.js'

export function isBilledAsExtraUsage(
  model: string | null,
  isFastMode: boolean,
  isOpus1mMerged: boolean,
): boolean {
  if (!isClaudeAISubscriber()) return false
  if (isFastMode) return true
  if (model === null || !has1mContext(model)) return false

  const m = model
    .toLowerCase()
    .replace(/\[1m\]$/, '')
    .trim()
  const isOpus46 = m === 'opus' || matchClaudeRelease(m) === getClaudeRelease('opus46')
  const isSonnet46 = m === 'sonnet' || matchClaudeRelease(m) === getClaudeRelease('sonnet46')

  if (isOpus46 && isOpus1mMerged) return false

  return isOpus46 || isSonnet46
}
