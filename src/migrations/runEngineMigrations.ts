import { feature } from 'bun:bundle'
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync } from 'fs'
import { join } from 'path'
import { getGlobalClaudeFile } from '../utils/env.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { ConfigParseError, getErrnoCode } from '../utils/errors.js'
import * as lockfile from '../utils/lockfile.js'
import { logError } from '../utils/log.js'
import { migrateChangelogFromConfig } from '../utils/releaseNotes.js'
import {
  DEFAULT_GLOBAL_CONFIG,
  getGlobalConfig,
  saveGlobalConfig,
} from '../utils/config.js'
import { migrateAutoUpdatesToSettings } from './migrateAutoUpdatesToSettings.js'
import { migrateBypassPermissionsAcceptedToSettings } from './migrateBypassPermissionsAcceptedToSettings.js'
import { migrateEnableAllProjectMcpServersToSettings } from './migrateEnableAllProjectMcpServersToSettings.js'
import { migrateLegacyOpusToCurrent } from './migrateLegacyOpusToCurrent.js'
import { migrateOpusToOpus1m } from './migrateOpusToOpus1m.js'
import { migrateReplBridgeEnabledToRemoteControlAtStartup } from './migrateReplBridgeEnabledToRemoteControlAtStartup.js'
import { migrateRetiredClaude46ModelsToClaude5 } from './migrateRetiredClaude46ModelsToClaude5.js'
import { migrateRetiredGptModelsToGpt56 } from './migrateRetiredGptModelsToGpt56.js'
import { migrateSonnet1mToSonnet45 } from './migrateSonnet1mToSonnet45.js'
import { migrateSonnet45ToSonnet46 } from './migrateSonnet45ToSonnet46.js'
import { resetAutoModeOptInForDefaultOffer } from './resetAutoModeOptInForDefaultOffer.js'
import { resetProToOpusDefault } from './resetProToOpusDefault.js'

export const CURRENT_MIGRATION_VERSION = 15

const MIGRATION_LOCK_STALE_MS = 5_000
const MIGRATION_LOCK_UPDATE_MS = 1_000

function readFreshMigrationVersion(): number | undefined {
  if (process.env.NODE_ENV === 'test') {
    return getGlobalConfig().migrationVersion
  }
  let raw: string
  try {
    raw = readFileSync(getGlobalClaudeFile(), 'utf8')
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') return undefined
    throw error
  }

  let config: unknown
  try {
    config = JSON.parse(raw)
  } catch (error) {
    throw new ConfigParseError(
      error instanceof Error ? error.message : String(error),
      getGlobalClaudeFile(),
      DEFAULT_GLOBAL_CONFIG,
    )
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new ConfigParseError(
      'Global config must contain a JSON object',
      getGlobalClaudeFile(),
      DEFAULT_GLOBAL_CONFIG,
    )
  }
  const migrationVersion = Reflect.get(config, 'migrationVersion')
  return typeof migrationVersion === 'number' && Number.isInteger(migrationVersion)
    ? migrationVersion
    : undefined
}

function runVersionedMigrations(): Error | null {
  const autoUpdatesError = migrateAutoUpdatesToSettings()
  if (autoUpdatesError) return autoUpdatesError

  migrateBypassPermissionsAcceptedToSettings()

  const mcpSettingsError = migrateEnableAllProjectMcpServersToSettings()
  if (mcpSettingsError) return mcpSettingsError

  migrateSonnet1mToSonnet45()
  migrateLegacyOpusToCurrent()

  const retiredGptError = migrateRetiredGptModelsToGpt56()
  if (retiredGptError) return retiredGptError
  const retiredClaudeError = migrateRetiredClaude46ModelsToClaude5()
  if (retiredClaudeError) return retiredClaudeError

  const sonnetMigrationError = migrateSonnet45ToSonnet46()
  if (sonnetMigrationError) return sonnetMigrationError
  const opusMigrationError = migrateOpusToOpus1m()
  if (opusMigrationError) return opusMigrationError
  migrateReplBridgeEnabledToRemoteControlAtStartup()
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    resetAutoModeOptInForDefaultOffer()
  }
  return null
}

export async function runEngineMigrations(): Promise<void> {
  const configHome = getClaudeConfigHomeDir()
  mkdirSync(configHome, { recursive: true, mode: 0o700 })
  const lockTarget = join(configHome, '.engine-migrations')
  const targetDescriptor = openSync(lockTarget, 'a', 0o600)
  closeSync(targetDescriptor)
  chmodSync(lockTarget, 0o600)

  let compromised: Error | null = null
  const release = await lockfile.lock(lockTarget, {
    lockfilePath: `${lockTarget}.lock`,
    realpath: false,
    retries: {
      retries: 40,
      factor: 1.2,
      minTimeout: 25,
      maxTimeout: 250,
      randomize: true,
    },
    stale: MIGRATION_LOCK_STALE_MS,
    update: MIGRATION_LOCK_UPDATE_MS,
    onCompromised: error => {
      compromised = error
    },
  })

  try {
    const needsVersionedMigrations =
      readFreshMigrationVersion() !== CURRENT_MIGRATION_VERSION
    if (needsVersionedMigrations) {
      const migrationError = runVersionedMigrations()
      if (migrationError) {
        logError(migrationError)
        return
      }
    }

    await migrateChangelogFromConfig().catch(() => {})

    if (needsVersionedMigrations) {
      if (compromised) throw compromised
      saveGlobalConfig(current =>
        current.migrationVersion === CURRENT_MIGRATION_VERSION
          ? current
          : { ...current, migrationVersion: CURRENT_MIGRATION_VERSION },
      )
      if (readFreshMigrationVersion() !== CURRENT_MIGRATION_VERSION) {
        throw new Error('Engine migration version was not persisted')
      }
    }
    const resetError = resetProToOpusDefault()
    if (resetError) logError(resetError)
  } finally {
    await release()
  }
}
