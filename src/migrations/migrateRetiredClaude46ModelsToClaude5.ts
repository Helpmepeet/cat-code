import { remapRetiredClaude46ModelForMigration } from '../utils/model/model.js'
import { migrateRetiredModelsWith } from './migrateRetiredModels.js'

/**
 * Retire first-party Claude Sonnet 4.6 and Opus 4.6 settings in favor of
 * their Claude 5 replacements. Runtime parsing also remaps project, local,
 * managed, CLI, and environment pins without mutating those sources.
 */
export function migrateRetiredClaude46ModelsToClaude5(): Error | null {
  return migrateRetiredModelsWith(remapRetiredClaude46ModelForMigration)
}
