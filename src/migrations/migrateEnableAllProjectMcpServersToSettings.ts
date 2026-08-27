import { logEvent } from 'src/services/analytics/index.js'
import {
  getCurrentProjectConfig,
  saveCurrentProjectConfig,
} from '../utils/config.js'
import { logError } from '../utils/log.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'

/**
 * Migration: Move MCP server approval fields from project config to local settings
 * This migrates both enableAllProjectMcpServers and enabledMcpjsonServers to the
 * settings system for better management and consistency.
 */
export function migrateEnableAllProjectMcpServersToSettings(): Error | null {
  const projectConfig = getCurrentProjectConfig()

  // Check if any field exists in project config
  const hasEnableAll = projectConfig.enableAllProjectMcpServers !== undefined
  const hasEnabledServers =
    projectConfig.enabledMcpjsonServers &&
    projectConfig.enabledMcpjsonServers.length > 0
  const hasDisabledServers =
    projectConfig.disabledMcpjsonServers &&
    projectConfig.disabledMcpjsonServers.length > 0

  if (!hasEnableAll && !hasEnabledServers && !hasDisabledServers) {
    return null
  }

  try {
    const fieldsToRemove: Array<
      | 'enableAllProjectMcpServers'
      | 'enabledMcpjsonServers'
      | 'disabledMcpjsonServers'
    > = []

    if (hasEnableAll) {
      fieldsToRemove.push('enableAllProjectMcpServers')
    }
    if (hasEnabledServers && projectConfig.enabledMcpjsonServers) {
      fieldsToRemove.push('enabledMcpjsonServers')
    }
    if (hasDisabledServers && projectConfig.disabledMcpjsonServers) {
      fieldsToRemove.push('disabledMcpjsonServers')
    }

    const { error } = updateSettingsForSource('localSettings', current => {
      const existingSettings = current ?? {}
      const next = { ...existingSettings }
      let changed = false

      if (
        hasEnableAll &&
        existingSettings.enableAllProjectMcpServers === undefined
      ) {
        next.enableAllProjectMcpServers =
          projectConfig.enableAllProjectMcpServers
        changed = true
      }
      if (hasEnabledServers && projectConfig.enabledMcpjsonServers) {
        const enabledMcpjsonServers = [
          ...new Set([
            ...(existingSettings.enabledMcpjsonServers ?? []),
            ...projectConfig.enabledMcpjsonServers,
          ]),
        ]
        if (
          enabledMcpjsonServers.join('\u0000') !==
          existingSettings.enabledMcpjsonServers?.join('\u0000')
        ) {
          next.enabledMcpjsonServers = enabledMcpjsonServers
          changed = true
        }
      }
      if (hasDisabledServers && projectConfig.disabledMcpjsonServers) {
        const disabledMcpjsonServers = [
          ...new Set([
            ...(existingSettings.disabledMcpjsonServers ?? []),
            ...projectConfig.disabledMcpjsonServers,
          ]),
        ]
        if (
          disabledMcpjsonServers.join('\u0000') !==
          existingSettings.disabledMcpjsonServers?.join('\u0000')
        ) {
          next.disabledMcpjsonServers = disabledMcpjsonServers
          changed = true
        }
      }

      return changed ? next : null
    })
    if (error) return error

    if (
      fieldsToRemove.includes('enableAllProjectMcpServers') ||
      fieldsToRemove.includes('enabledMcpjsonServers') ||
      fieldsToRemove.includes('disabledMcpjsonServers')
    ) {
      saveCurrentProjectConfig(current => {
        const {
          enableAllProjectMcpServers: _enableAll,
          enabledMcpjsonServers: _enabledServers,
          disabledMcpjsonServers: _disabledServers,
          ...configWithoutFields
        } = current
        return configWithoutFields
      })
    }

    // Log the migration event
    logEvent('tengu_migrate_mcp_approval_fields_success', {
      migratedCount: fieldsToRemove.length,
    })
    return null
  } catch (e: unknown) {
    logError(e)
    logEvent('tengu_migrate_mcp_approval_fields_error', {})
    return e instanceof Error ? e : new Error(String(e))
  }
}
