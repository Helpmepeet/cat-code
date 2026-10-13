import type { ScheduledTaskOptionsResult } from '../shared/scheduledTaskOptions.js'

/** Reads saved configuration and engine capabilities, never a project bootstrap or session. */
export async function readScheduledTaskOptionsDomain(): Promise<ScheduledTaskOptionsResult> {
  const [
    { getGlobalConfig },
    { getModelOptions },
    { getDefaultMainLoopModel, parseUserSpecifiedModel },
    { getSupportedEffortLevels, modelSupportsEffort },
    { resolveModelSelectionProvider },
  ] = await Promise.all([
    import('../../src/utils/config.js'),
    import('../../src/utils/model/modelOptions.js'),
    import('../../src/utils/model/model.js'),
    import('../../src/utils/effort.js'),
    import('../../src/utils/model/providers.js'),
  ])
  const effortOptions = (selection: string | null): string[] => {
    const model = selection === null ? getDefaultMainLoopModel() : parseUserSpecifiedModel(selection)
    return modelSupportsEffort(model) ? [...getSupportedEffortLevels(model)] : []
  }
  return {
    type: 'scheduled-options-result', version: 1,
    models: getModelOptions(false).filter(option => option.value !== null).map(option => {
      const provider = resolveModelSelectionProvider(option.value)
      return { value: option.value!, label: option.label,
        provider: provider === 'firstParty' ? 'anthropic' : provider,
        effortOptions: effortOptions(option.value) }
    }),
    defaultEffortOptions: effortOptions(null),
    projectPaths: Object.keys(getGlobalConfig().projects ?? {}),
  }
}
