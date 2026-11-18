import { readFileSync } from 'node:fs'
import { isENOENT } from '../utils/errors.js'
import { safeParseJSON } from '../utils/json.js'
import {
  getMainLoopModelOverride,
  setMainLoopModelOverride,
} from '../bootstrap/state.js'
import { getSettingsFilePathForSource, updateSettingsForSource } from '../utils/settings/settings.js'

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
  checkFirst = false,
): Error | null {
  try {
    if (!checkFirst || hasRetiredUserSelection(remap)) {
      const error = rewriteRetiredUserSelections(remap)
      if (error) return error
    }
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }

  const override = getMainLoopModelOverride()
  if (typeof override === 'string') {
    const remappedOverride = remap(override)
    if (remappedOverride !== override) setMainLoopModelOverride(remappedOverride)
  }
  return null
}

// Startup already holds the engine migration lock. Avoid taking the settings
// write lock for unchanged files. A candidate is re-read by the updater under
// that lock, so a concurrent settings edit can never be overwritten by this read.
function hasRetiredUserSelection(remap: (model: string) => string): boolean {
  const file = getSettingsFilePathForSource('userSettings')
  if (!file) return false
  try {
    const raw = safeParseJSON(readFileSync(file, 'utf8'), false)
    if (!raw || typeof raw !== 'object') return false
    const model = Reflect.get(raw, 'model')
    const allowlist = Reflect.get(raw, 'availableModels')
    const overrides = Reflect.get(raw, 'modelOverrides')
    const isRetired = (id: unknown) => typeof id === 'string' && remap(id) !== id
    return isRetired(model) ||
      (Array.isArray(allowlist) && allowlist.some(isRetired)) ||
      (overrides != null && typeof overrides === 'object' &&
        Object.keys(overrides).some(isRetired))
  } catch (error) {
    if (isENOENT(error)) return false
    throw error
  }
}

function rewriteRetiredUserSelections(remap: (model: string) => string): Error | null {
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
  return error
}
