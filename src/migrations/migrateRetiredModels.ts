import {
  getMainLoopModelOverride,
  setMainLoopModelOverride,
} from '../bootstrap/state.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'

/**
 * Rewrite every retired model id a user owns through `remap`: the selected
 * model, the available-model list, the per-model override keys, and the
 * in-process `--model` override.
 *
 * Only user settings are rewritten. Project, local, and managed settings are
 * intentionally left alone; runtime model resolution remaps their explicit
 * legacy values without mutating configuration the user does not own here.
 *
 * Callers stay one per model family so each keeps its own migration identity
 * in runEngineMigrations; only the mechanics live here.
 */
export function migrateRetiredModelsWith(
  remap: (model: string) => string,
): Error | null {
  const remapModelList = (models: string[]): string[] => [
    ...new Set(models.map(remap)),
  ]

  const { error } = updateSettingsForSource('userSettings', settings => {
    if (!settings) return null
    const model = settings.model
    const remappedModel = typeof model === 'string' ? remap(model) : model
    const availableModels = settings.availableModels
      ? remapModelList(settings.availableModels)
      : undefined
    const modelOverrides = settings.modelOverrides
      ? { ...settings.modelOverrides }
      : undefined
    let changedOverrides = false
    if (modelOverrides) {
      for (const [modelId, override] of Object.entries(settings.modelOverrides ?? {})) {
        const replacement = remap(modelId)
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
    const remappedOverride = remap(override)
    if (remappedOverride !== override) {
      setMainLoopModelOverride(remappedOverride)
    }
  }
  return null
}
