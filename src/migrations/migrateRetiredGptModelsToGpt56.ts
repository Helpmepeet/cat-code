import {
  getMainLoopModelOverride,
  setMainLoopModelOverride,
} from '../bootstrap/state.js'
import { remapRetiredGptModel } from '../utils/model/model.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

function remapModelList(models: string[]): string[] {
  return [...new Set(models.map(remapRetiredGptModel))]
}

/**
 * Retire legacy GPT selections in favor of their designated GPT-5.6 models.
 *
 * Only user settings are rewritten. Project, local, and managed settings are
 * intentionally left alone; runtime model resolution remaps their explicit
 * legacy values without mutating configuration the user does not own here.
 */
export function migrateRetiredGptModelsToGpt56(): Error | null {
  const settings = getSettingsForSource('userSettings')
  if (settings) {
    const model = settings.model
    const remappedModel = typeof model === 'string'
      ? remapRetiredGptModel(model)
      : model
    const availableModels = settings.availableModels
      ? remapModelList(settings.availableModels)
      : undefined
    const modelOverrides = settings.modelOverrides
      ? { ...settings.modelOverrides } as Record<string, string | undefined>
      : undefined
    let changedOverrides = false
    if (modelOverrides) {
      for (const [modelId, override] of Object.entries(settings.modelOverrides ?? {})) {
        const replacement = remapRetiredGptModel(modelId)
        if (replacement !== modelId) {
          modelOverrides[replacement] ??= override
          modelOverrides[modelId] = undefined
          changedOverrides = true
        }
      }
    }

    const changedAvailableModels = availableModels
      ? availableModels.join('\u0000') !== settings.availableModels?.join('\u0000')
      : false
    if (remappedModel !== model || changedAvailableModels || changedOverrides) {
      const { error } = updateSettingsForSource('userSettings', {
        ...(remappedModel !== model ? { model: remappedModel } : {}),
        ...(changedAvailableModels ? { availableModels } : {}),
        ...(changedOverrides ? { modelOverrides } : {}),
      })
      if (error) return error
    }
  }

  const override = getMainLoopModelOverride()
  if (typeof override === 'string') {
    const remappedOverride = remapRetiredGptModel(override)
    if (remappedOverride !== override) {
      setMainLoopModelOverride(remappedOverride)
    }
  }
  return null
}
