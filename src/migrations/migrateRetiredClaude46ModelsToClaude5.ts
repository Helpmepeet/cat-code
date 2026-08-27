import {
  getMainLoopModelOverride,
  setMainLoopModelOverride,
} from '../bootstrap/state.js'
import { remapRetiredClaude46ModelForMigration } from '../utils/model/model.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'

function remapModelList(models: string[]): string[] {
  return [...new Set(models.map(remapRetiredClaude46ModelForMigration))]
}

/**
 * Retire first-party Claude Sonnet 4.6 and Opus 4.6 settings in favor of
 * their Claude 5 replacements. Runtime parsing also remaps project, local,
 * managed, CLI, and environment pins without mutating those sources.
 */
export function migrateRetiredClaude46ModelsToClaude5(): Error | null {
  const { error } = updateSettingsForSource('userSettings', settings => {
    if (!settings) return null
    const model = settings.model
    const remappedModel = typeof model === 'string'
      ? remapRetiredClaude46ModelForMigration(model)
      : model
    const availableModels = settings.availableModels
      ? remapModelList(settings.availableModels)
      : undefined
    const modelOverrides = settings.modelOverrides
      ? { ...settings.modelOverrides }
      : undefined
    let changedOverrides = false
    if (modelOverrides) {
      for (const [modelId, override] of Object.entries(settings.modelOverrides ?? {})) {
        const replacement = remapRetiredClaude46ModelForMigration(modelId)
        if (replacement !== modelId) {
          modelOverrides[replacement] ??= override
          delete modelOverrides[modelId]
          changedOverrides = true
        }
      }
    }

    const changedAvailableModels = availableModels
      ? availableModels.join('\u0000') !== settings.availableModels?.join('\u0000')
      : false
    return remappedModel !== model || changedAvailableModels || changedOverrides
      ? {
        ...settings,
        ...(remappedModel !== model ? { model: remappedModel } : {}),
        ...(changedAvailableModels ? { availableModels } : {}),
        ...(changedOverrides ? { modelOverrides } : {}),
      }
      : null
  })
  if (error) return error

  const override = getMainLoopModelOverride()
  if (typeof override === 'string') {
    const remappedOverride = remapRetiredClaude46ModelForMigration(override)
    if (remappedOverride !== override) {
      setMainLoopModelOverride(remappedOverride)
    }
  }
  return null
}
