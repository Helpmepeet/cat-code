import { logEvent } from 'src/services/analytics/index.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { logError } from '../utils/log.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
/**
 * Migration: Move user-set autoUpdates preference to settings.json env var
 * Only migrates if user explicitly disabled auto-updates (not for protection)
 * This preserves user intent while allowing native installations to auto-update
 */
export function migrateAutoUpdatesToSettings(): Error | null {
  const globalConfig = getGlobalConfig()

  // Only migrate if autoUpdates was explicitly set to false by user preference
  // (not automatically for native protection)
  if (
    globalConfig.autoUpdates !== false ||
    globalConfig.autoUpdatesProtectedForNative === true
  ) {
    return null
  }

  try {
    let alreadyHadEnvVar = false
    const { error } = updateSettingsForSource('userSettings', current => {
      const userSettings = current ?? {}
      alreadyHadEnvVar = !!userSettings.env?.DISABLE_AUTOUPDATER
      if (userSettings.env?.DISABLE_AUTOUPDATER === '1') return null
      return {
        ...userSettings,
        env: {
          ...userSettings.env,
          DISABLE_AUTOUPDATER: '1',
        },
      }
    })
    if (error) return error

    logEvent('tengu_migrate_autoupdates_to_settings', {
      was_user_preference: true,
      already_had_env_var: alreadyHadEnvVar,
    })

    // explicitly set, so this takes effect immediately
    process.env.DISABLE_AUTOUPDATER = '1'

    // Remove autoUpdates from global config after successful migration
    saveGlobalConfig(current => {
      const {
        autoUpdates: _,
        autoUpdatesProtectedForNative: __,
        ...updatedConfig
      } = current
      return updatedConfig
    })
    return null
  } catch (error) {
    const migrationError = new Error(`Failed to migrate auto-updates: ${error}`)
    logError(migrationError)
    logEvent('tengu_migrate_autoupdates_error', {
      has_error: true,
    })
    return migrationError
  }
}
