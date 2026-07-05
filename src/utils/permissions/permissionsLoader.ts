import { logError } from '../log.js'
import {
  type EditableSettingSource,
  getEnabledSettingSources,
  type SettingSource,
} from '../settings/constants.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../settings/settings.js'
import type { SettingsJson } from '../settings/types.js'
import type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleValue,
} from './PermissionRule.js'
import {
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from './permissionRuleParser.js'

/**
 * Returns true if allowManagedPermissionRulesOnly is enabled in managed settings (policySettings).
 * When enabled, only permission rules from managed settings are respected.
 */
export function shouldAllowManagedPermissionRulesOnly(): boolean {
  return (
    getSettingsForSource('policySettings')?.allowManagedPermissionRulesOnly ===
    true
  )
}

/**
 * Returns true if "always allow" options should be shown in permission prompts.
 * When allowManagedPermissionRulesOnly is enabled, these options are hidden.
 */
export function shouldShowAlwaysAllowOptions(): boolean {
  return !shouldAllowManagedPermissionRulesOnly()
}

const SUPPORTED_RULE_BEHAVIORS = [
  'allow',
  'deny',
  'ask',
] as const satisfies PermissionBehavior[]

/**
 * Converts permissions JSON to an array of PermissionRule objects
 * @param data The parsed permissions data
 * @param source The source of these rules
 * @returns Array of PermissionRule objects
 */
function settingsJsonToRules(
  data: SettingsJson | null,
  source: PermissionRuleSource,
): PermissionRule[] {
  if (!data || !data.permissions) {
    return []
  }

  const { permissions } = data
  const rules: PermissionRule[] = []
  for (const behavior of SUPPORTED_RULE_BEHAVIORS) {
    const behaviorArray = permissions[behavior]
    if (behaviorArray) {
      for (const ruleString of behaviorArray) {
        rules.push({
          source,
          ruleBehavior: behavior,
          ruleValue: permissionRuleValueFromString(ruleString),
        })
      }
    }
  }
  return rules
}

/**
 * Loads all permission rules from all relevant sources (managed and project settings)
 * @returns Array of all permission rules
 */
export function loadAllPermissionRulesFromDisk(): PermissionRule[] {
  // If allowManagedPermissionRulesOnly is set, only use managed permission rules
  if (shouldAllowManagedPermissionRulesOnly()) {
    return getPermissionRulesForSource('policySettings')
  }

  // Otherwise, load from all enabled sources (backwards compatible)
  const rules: PermissionRule[] = []

  for (const source of getEnabledSettingSources()) {
    rules.push(...getPermissionRulesForSource(source))
  }
  return rules
}

/**
 * Loads permission rules from a specific source
 * @param source The source to load from
 * @returns Array of permission rules from that source
 */
export function getPermissionRulesForSource(
  source: SettingSource,
): PermissionRule[] {
  const settingsData = getSettingsForSource(source)
  return settingsJsonToRules(settingsData, source)
}

export type PermissionRuleFromEditableSettings = PermissionRule & {
  source: EditableSettingSource
}

// Editable sources that can be modified (excludes policySettings and flagSettings)
const EDITABLE_SOURCES: EditableSettingSource[] = [
  'userSettings',
  'projectSettings',
  'localSettings',
]

/**
 * Deletes a rule from the project permissions file
 * @param rule The rule to delete
 * @returns Promise resolving to a boolean indicating success
 */
export function deletePermissionRuleFromSettings(
  rule: PermissionRuleFromEditableSettings,
): boolean {
  // Runtime check to ensure source is actually editable
  if (!EDITABLE_SOURCES.includes(rule.source as EditableSettingSource)) {
    return false
  }

  const ruleString = permissionRuleValueToString(rule.ruleValue)

  // Normalize raw settings entries via roundtrip parse→serialize so legacy
  // names (e.g. "KillShell") match their canonical form ("TaskStop").
  const normalizeEntry = (raw: string): string =>
    permissionRuleValueToString(permissionRuleValueFromString(raw))

  try {
    // Filter inside the updater (under the cross-process settings lock) so a
    // concurrent same-cwd process's rule changes aren't clobbered by a
    // pre-computed array from a stale read.
    let found = false
    const { error } = updateSettingsForSource(rule.source, current => {
      // If there's no settings data or permissions, nothing to do
      if (!current || !current.permissions) {
        return null
      }

      const behaviorArray = current.permissions[rule.ruleBehavior]
      if (!behaviorArray) {
        return null
      }

      if (!behaviorArray.some(raw => normalizeEntry(raw) === ruleString)) {
        return null
      }
      found = true

      // Keep a copy of the original permissions data to preserve unrecognized keys
      return {
        ...current,
        permissions: {
          ...current.permissions,
          [rule.ruleBehavior]: behaviorArray.filter(
            raw => normalizeEntry(raw) !== ruleString,
          ),
        },
      }
    })
    if (error) {
      // Error already logged inside updateSettingsForSource
      return false
    }

    return found
  } catch (error) {
    logError(error)
    return false
  }
}

function getEmptyPermissionSettingsJson(): SettingsJson {
  return {
    permissions: {},
  }
}

/**
 * Adds rules to the project permissions file
 * @param ruleValues The rule values to add
 * @returns Promise resolving to a boolean indicating success
 */
export function addPermissionRulesToSettings(
  {
    ruleValues,
    ruleBehavior,
  }: {
    ruleValues: PermissionRuleValue[]
    ruleBehavior: PermissionBehavior
  },
  source: EditableSettingSource,
): boolean {
  // When allowManagedPermissionRulesOnly is enabled, don't persist new permission rules
  if (shouldAllowManagedPermissionRulesOnly()) {
    return false
  }

  if (ruleValues.length < 1) {
    // No rules to add
    return true
  }

  const ruleStrings = ruleValues.map(permissionRuleValueToString)

  try {
    // Compute the final rule array inside the updater so it runs under the
    // cross-process settings lock against the fresh on-disk state — another
    // same-cwd engine process may have appended a rule since our last read.
    // `current` already falls back to raw (unvalidated) JSON on schema
    // failure, preserving existing rules even when unrelated fields (like
    // hooks) don't validate.
    const result = updateSettingsForSource(source, current => {
      const settingsData = current || getEmptyPermissionSettingsJson()
      // Ensure permissions object exists
      const existingPermissions = settingsData.permissions || {}
      const existingRules = existingPermissions[ruleBehavior] || []

      // Filter out duplicates - normalize existing entries via roundtrip
      // parse→serialize so legacy names match their canonical form.
      const existingRulesSet = new Set(
        existingRules.map(raw =>
          permissionRuleValueToString(permissionRuleValueFromString(raw)),
        ),
      )
      const newRules = ruleStrings.filter(rule => !existingRulesSet.has(rule))

      // If no new rules to add, skip the write
      if (newRules.length === 0) {
        return null
      }

      // Keep a copy of the original settings data to preserve unrecognized keys
      return {
        ...settingsData,
        permissions: {
          ...existingPermissions,
          [ruleBehavior]: [...existingRules, ...newRules],
        },
      }
    })

    if (result.error) {
      throw result.error
    }

    return true
  } catch (error) {
    logError(error)
    return false
  }
}
