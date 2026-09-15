import { remapRetiredGptModel } from '../utils/model/model.js'
import { migrateRetiredModelsWith } from './migrateRetiredModels.js'

/**
 * Retire legacy GPT selections in favor of their designated GPT-5.6 models.
 *
 * Only user settings are rewritten. Project, local, and managed settings are
 * intentionally left alone; runtime model resolution remaps their explicit
 * legacy values without mutating configuration the user does not own here.
 */
export function migrateRetiredGptModelsToGpt56(): Error | null {
  return migrateRetiredModelsWith(remapRetiredGptModel)
}
