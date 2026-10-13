import type { ScheduledTaskOptionsResult } from '../shared/scheduledTaskOptions.js'

type CatalogReaders = {
  getModelOptions: (fastMode: boolean) => { value: string | null; label: string }[]
  effortOptionsForSelection: (value: string | null) => string[]
  resolveModelSelectionProvider: (value: string | null) => 'firstParty' | 'openai' | 'bedrock' | 'vertex' | 'foundry'
  getGlobalConfig: () => { projects?: Record<string, unknown> }
}

/** Reads saved configuration and engine capabilities, never a project bootstrap or session. */
export async function readScheduledTaskOptionsDomain(): Promise<ScheduledTaskOptionsResult> {
  const [
    { getGlobalConfig },
    { getModelOptions },
    { effortOptionsForSelection },
    { resolveModelSelectionProvider },
  ] = await Promise.all([
    import('../../src/utils/config.js'),
    import('../../src/utils/model/modelOptions.js'),
    import('./effortOptions.js'),
    import('../../src/utils/model/providers.js'),
  ])
  return buildScheduledTaskOptionsCatalog({ getGlobalConfig, getModelOptions, effortOptionsForSelection, resolveModelSelectionProvider })
}

export function buildScheduledTaskOptionsCatalog({
  getGlobalConfig, getModelOptions, effortOptionsForSelection, resolveModelSelectionProvider,
}: CatalogReaders): ScheduledTaskOptionsResult {
  return {
    type: 'scheduled-options-result', version: 1,
    models: getModelOptions(false).filter(option => option.value !== null).flatMap(option => {
      try {
        const provider = resolveModelSelectionProvider(option.value)
        return [{ value: option.value!, label: option.label,
          provider: provider === 'firstParty' ? 'anthropic' as const : provider,
          effortOptions: effortOptionsForSelection(option.value) }]
      } catch {
        return []
      }
    }),
    defaultEffortOptions: effortOptionsForSelection(null),
    projectPaths: Object.keys(getGlobalConfig().projects ?? {}),
  }
}
