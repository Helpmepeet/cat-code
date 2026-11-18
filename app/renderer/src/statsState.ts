import { getClaudeMarketingName, matchCodexRelease } from '../../../src/utils/model/configs.js'

// Keep the recorded release's name when rendering retained activity.
export function formatModelDisplayName(modelName: string): string {
  if (!modelName) return 'Unknown Model'
  const claude = getClaudeMarketingName(modelName)
  if (claude) return claude
  const codex = matchCodexRelease(modelName)
  if (codex?.label && (codex.context || codex.promptFamily)) return codex.label
  if (modelName.includes('claude-3-opus')) return 'Claude 3 Opus'
  if (modelName.includes('claude-3-haiku')) return 'Claude 3 Haiku'
  if (modelName.includes('gpt-4o-mini')) return 'GPT-4o mini'
  if (modelName.includes('gpt-4o')) return 'GPT-4o'
  if (modelName.includes('o3-mini')) return 'o3-mini'
  if (modelName.includes('o1')) return 'o1'
  return modelName
}
