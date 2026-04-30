import type { LocalCommandCall } from '../../types/command.js'
import { getCodexCacheStats } from '../../services/api/codex-fetch-adapter.js'
import { getAPIProvider } from '../../utils/model/providers.js'

export const call: LocalCommandCall = async () => {
  if (getAPIProvider() !== 'openai') {
    return { type: 'text', value: 'Cache stats are only available on the Codex (OpenAI) provider.' }
  }

  const { window, hitRatio, medianCachedTokens } = getCodexCacheStats()

  if (window.length === 0) {
    return { type: 'text', value: 'No Codex requests recorded yet this session.' }
  }

  const pct = (hitRatio * 100).toFixed(1)
  const lines: string[] = [
    `Codex cache stats — last ${window.length} request(s)`,
    `Hit ratio:          ${pct}%`,
    `Median cached tok:  ${medianCachedTokens.toLocaleString()}`,
    '',
    'Turn  Account       Model              Input      Cached     Hit%    Key      Conv',
  ]

  for (const e of window) {
    const turnPct = e.inputTokens > 0
      ? ((e.cachedTokens / e.inputTokens) * 100).toFixed(0)
      : '0'
    const ts = new Date(e.ts).toISOString().slice(11, 19)
    lines.push(
      `${ts}  ${e.accountId.slice(0, 12).padEnd(12)}  ${e.model.padEnd(17)}  ${String(e.inputTokens).padStart(9)}  ${String(e.cachedTokens).padStart(9)}  ${turnPct.padStart(4)}%   ${e.promptCacheKeyPrefix}  ${e.conversationIdPrefix}`,
    )
  }

  return { type: 'text', value: lines.join('\n') }
}
