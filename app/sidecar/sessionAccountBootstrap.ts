import { parseSessionAccountSelection, type SessionAccountSelection } from '../shared/sessionAccountSelection.js'
import { blockSessionAccountRoute, clearSessionAccountRouteBlock } from '../../src/services/api/sessionAccountRouting.js'

type RestoreDependencies = {
  load: () => Promise<void>
  selectAnthropic: (id: string, options: { persistDefault: false }) => { accountUuid: string } | null
  selectOpenai: (id: string, options: { persistDefault: false }) => { accountId: string } | null
}

export function readSessionAccountSelection(raw: string | undefined): SessionAccountSelection | undefined {
  if (!raw) return undefined
  // An invalid host input must not silently become permission to use a default.
  const parsed: unknown = JSON.parse(raw)
  const selection = parseSessionAccountSelection(parsed)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      Object.entries(parsed).some(([provider, id]) =>
        (provider !== 'anthropic' && provider !== 'openai') || selection?.[provider] !== id)) {
    throw new Error('Invalid saved account selection')
  }
  return selection
}

/** Restore process-local pointers before resume/startup hooks or controller creation. */
export async function restoreSessionAccountSelection(
  selection: SessionAccountSelection | undefined,
  dependencies?: RestoreDependencies,
): Promise<void> {
  if (!selection) return
  // Fail closed even if inventory loading fails. Management remains available.
  for (const provider of ['anthropic', 'openai'] as const) {
    const id = selection[provider]
    if (id) blockSessionAccountRoute(provider, id)
  }
  try {
    const deps = dependencies ?? await productionDependencies()
    await deps.load()
    for (const provider of ['anthropic', 'openai'] as const) {
      const id = selection[provider]
      if (!id) continue
      try {
        const restored = provider === 'anthropic'
          ? deps.selectAnthropic(id, { persistDefault: false })?.accountUuid
          : deps.selectOpenai(id, { persistDefault: false })?.accountId
        if (restored === id) clearSessionAccountRouteBlock(provider)
      } catch {
        // A provider failure must neither release its hold nor stop management
        // or restoration of the other provider.
      }
    }
  } catch {
    // The route holds carry a safe, actionable diagnostic, not a raw vault error.
  }
}

async function productionDependencies(): Promise<RestoreDependencies> {
  const claude = await import('../../src/services/api/claudeAccountPool.js')
  const codex = await import('../../src/services/api/codexAccountPool.js')
  return {
    load: async () => {
      claude.loadClaudePoolForObservation()
      await codex.loadPoolForObservation()
    },
    selectAnthropic: claude.switchToClaudeAccount,
    selectOpenai: codex.switchToAccount,
  }
}
