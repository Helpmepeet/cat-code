import type { ExternalPermissionMode } from '../../utils/permissions/PermissionMode.js'
import type { SettingsUpdater } from '../../utils/settings/settings.js'

/**
 * Build the default-mode update from the user settings read under the
 * cross-process lock. The Config dialog's merged display settings may include
 * project or policy rules and can be stale relative to another engine process.
 */
export function userSettingsWithDefaultPermissionMode(
  defaultMode: ExternalPermissionMode | undefined,
): SettingsUpdater {
  return current => ({
    ...current,
    permissions: {
      ...current?.permissions,
      defaultMode,
    },
  })
}
