import { resolve } from 'path'
import type { AppState } from '../../state/AppState.js'
import { logForDebugging } from '../debug.js'
import { updateHooksConfigSnapshot } from '../hooks/hooksConfigSnapshot.js'
import { expandPath } from '../path.js'
import {
  createDisabledBypassPermissionsContext,
  findOverlyBroadBashPermissions,
  isBypassPermissionsModeDisabled,
  removeDangerousPermissions,
  transitionAutoModeAfterSettingsChange,
  transitionPlanAutoMode,
} from '../permissions/permissionSetup.js'
import { syncPermissionRulesFromDisk } from '../permissions/permissions.js'
import { loadAllPermissionRulesFromDisk } from '../permissions/permissionsLoader.js'
import { applyPermissionUpdate } from '../permissions/PermissionUpdate.js'
import type { SettingSource } from './constants.js'
import { getInitialSettings } from './settings.js'

/**
 * The additionalDirectories of a settings snapshot, keyed the way
 * validateDirectoryForWorkspace keys the context map (resolve(expandPath(dir)),
 * src/commands/add-dir/validation.ts:43) so the two can be compared.
 */
function settingsDirectoryKeys(settings: {
  permissions?: { additionalDirectories?: readonly string[] }
}): Set<string> {
  return new Set(
    (settings?.permissions?.additionalDirectories ?? []).map(dir =>
      resolve(expandPath(dir)),
    ),
  )
}

/**
 * Apply a settings change to app state. Re-reads settings from disk,
 * reloads permissions and hooks, and pushes the new state.
 *
 * Used by both the interactive path (AppState.tsx via useSettingsChange) and
 * the headless/SDK path (print.ts direct subscribe) so that managed-settings
 * / policy changes are fully applied in both modes.
 *
 * The settings cache is reset by the notifier (changeDetector.fanOut) before
 * listeners are iterated, so getInitialSettings() here reads fresh disk
 * state. Previously this function reset the cache itself, which — combined
 * with useSettingsChange's own reset — caused N disk reloads per notification
 * for N subscribers.
 *
 * Side-effects like clearing auth caches and applying env vars are handled by
 * `onChangeAppState` which fires when `settings` changes in state.
 */
export function applySettingsChange(
  source: SettingSource,
  setAppState: (f: (prev: AppState) => AppState) => void,
): void {
  const newSettings = getInitialSettings()

  logForDebugging(`Settings changed from ${source}, updating app state`)

  const updatedRules = loadAllPermissionRulesFromDisk()
  updateHooksConfigSnapshot()

  setAppState(prev => {
    let newContext = syncPermissionRulesFromDisk(
      prev.toolPermissionContext,
      updatedRules,
    )

    // Ant-only: re-strip overly broad Bash allow rules after settings sync
    if (
      process.env.USER_TYPE === 'ant' &&
      process.env.CLAUDE_CODE_ENTRYPOINT !== 'local-agent'
    ) {
      const overlyBroad = findOverlyBroadBashPermissions(updatedRules, [])
      if (overlyBroad.length > 0) {
        newContext = removeDangerousPermissions(newContext, overlyBroad)
      }
    }

    // Drop working directories that settings granted and no longer grant.
    // Only removals are reconciled: adding one has to pass the async fs
    // validation initializePermissionContext runs (permissionSetup.ts:1026),
    // which this synchronous reducer cannot do, and widening the workspace
    // from another process's settings write is not a change to make silently.
    const nextDirectories = settingsDirectoryKeys(newSettings)
    const droppedDirectories = [...settingsDirectoryKeys(prev.settings)].filter(
      dir => !nextDirectories.has(dir),
    )
    if (droppedDirectories.length > 0) {
      newContext = applyPermissionUpdate(newContext, {
        type: 'removeDirectories',
        directories: droppedDirectories,
        destination: 'session',
      })
    }

    if (
      newContext.isBypassPermissionsModeAvailable &&
      isBypassPermissionsModeDisabled()
    ) {
      newContext = createDisabledBypassPermissionsContext(newContext)
    }

    newContext = transitionPlanAutoMode(newContext)
    newContext = transitionAutoModeAfterSettingsChange(newContext)

    // ponytail: do NOT sync effortLevel into AppState.effortValue here.
    // effortValue is session-scoped; another session's /effort write to the
    // global settings file would fire this watcher and leak across terminals
    // (mirrors the model fix in StatusLine.tsx).
    return {
      ...prev,
      settings: newSettings,
      toolPermissionContext: newContext,
    }
  })
}
