import type { RunControlsSnapshot } from '../../shared/protocol.js'
import type { ContextUsage } from './contextUsage.js'

export type TokenWarning = {
  percentLeft: number
  autoCompactEnabled: boolean
}

export function selectTokenWarning(
  usage: ContextUsage | null,
  autoCompact: RunControlsSnapshot['autoCompact'] | null | undefined,
): TokenWarning | null {
  if (!usage || !autoCompact) return null
  const { threshold, warningThreshold } = autoCompact
  if (threshold == null || warningThreshold == null) return null
  if (usage.usedTokens < warningThreshold) return null
  return {
    percentLeft: Math.max(
      0,
      Math.min(100, Math.round(((threshold - usage.usedTokens) / threshold) * 100)),
    ),
    autoCompactEnabled: autoCompact.enabled,
  }
}
