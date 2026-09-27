import { isSettingSourceEnabled } from './settings/constants.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from './settings/settings.js'
import type { SettingsJson } from './settings/types.js'

export const INSTRUCTION_FILES_MODES = [
  'claude-md-or-agents-md',
  'claude-md',
  'claude-md-and-agents-md',
  'managed-only',
] as const

export type InstructionFilesMode = (typeof INSTRUCTION_FILES_MODES)[number]

export const DEFAULT_INSTRUCTION_FILES_MODE: InstructionFilesMode =
  'claude-md-or-agents-md'

export const INSTRUCTION_FILES_MODE_LABELS: Record<
  InstructionFilesMode,
  string
> = {
  'claude-md-or-agents-md': 'CLAUDE.md or AGENTS.md',
  'claude-md': 'CLAUDE.md only',
  'claude-md-and-agents-md': 'CLAUDE.md and AGENTS.md',
  'managed-only': 'Managed instructions only',
}

const BUILTIN_AGENTS_PLUGIN_ID = 'agents-md@builtin'
const INSTRUCTION_FILES_OPTION = 'instructionFiles'

type PluginConfigEntry = NonNullable<
  NonNullable<SettingsJson['pluginConfigs']>[string]
>

export type InstructionFilesOptionValue = NonNullable<
  NonNullable<PluginConfigEntry['options']>[string]
>

export type InstructionFilesSettingSource =
  | 'userSettings'
  | 'flagSettings'
  | 'policySettings'
  | 'default'

export type ResolvedInstructionFilesSetting = {
  mode: InstructionFilesMode
  source: InstructionFilesSettingSource
}

function readInstructionFilesOption(settings: SettingsJson | null): {
  present: boolean
  value: unknown
} {
  const options =
    settings?.pluginConfigs?.[BUILTIN_AGENTS_PLUGIN_ID]?.options as
      | Record<string, unknown>
      | undefined
  if (
    !options ||
    !Object.prototype.hasOwnProperty.call(options, INSTRUCTION_FILES_OPTION)
  ) {
    return { present: false, value: undefined }
  }
  return { present: true, value: options[INSTRUCTION_FILES_OPTION] }
}

function isInstructionFilesMode(value: unknown): value is InstructionFilesMode {
  return (
    typeof value === 'string' &&
    (INSTRUCTION_FILES_MODES as readonly string[]).includes(value)
  )
}

export function resolveInstructionFilesSetting({
  userSettings,
  userSettingsEnabled,
  flagSettings,
  policySettings,
}: {
  userSettings: SettingsJson | null
  userSettingsEnabled: boolean
  flagSettings: SettingsJson | null
  policySettings: SettingsJson | null
}): ResolvedInstructionFilesSetting {
  const sources: Array<{
    source: Exclude<InstructionFilesSettingSource, 'default'>
    settings: SettingsJson | null
  }> = [
    { source: 'policySettings', settings: policySettings },
    { source: 'flagSettings', settings: flagSettings },
    ...(userSettingsEnabled
      ? [{ source: 'userSettings' as const, settings: userSettings }]
      : []),
  ]

  for (const { source, settings } of sources) {
    const option = readInstructionFilesOption(settings)
    if (!option.present) continue
    return {
      mode: isInstructionFilesMode(option.value)
        ? option.value
        : DEFAULT_INSTRUCTION_FILES_MODE,
      source,
    }
  }

  return { mode: DEFAULT_INSTRUCTION_FILES_MODE, source: 'default' }
}

export function getInstructionFilesSetting(): ResolvedInstructionFilesSetting {
  return resolveInstructionFilesSetting({
    userSettingsEnabled: isSettingSourceEnabled('userSettings'),
    userSettings: isSettingSourceEnabled('userSettings')
      ? getSettingsForSource('userSettings')
      : null,
    flagSettings: getSettingsForSource('flagSettings'),
    policySettings: getSettingsForSource('policySettings'),
  })
}

export function getUserInstructionFilesOption(
  settings: SettingsJson | null,
): InstructionFilesOptionValue | undefined {
  const option = readInstructionFilesOption(settings)
  return option.present
    ? (option.value as InstructionFilesOptionValue)
    : undefined
}

export function updateUserInstructionFilesOption(
  value: InstructionFilesOptionValue | undefined,
): { error: Error | null } {
  return updateSettingsForSource('userSettings', currentSettings => {
    const current = currentSettings ?? {}
    const hadPluginConfigs = current.pluginConfigs !== undefined
    const pluginConfigs = { ...current.pluginConfigs }
    const pluginConfig = pluginConfigs[BUILTIN_AGENTS_PLUGIN_ID]
    const options = { ...pluginConfig?.options }

    if (value === undefined) delete options[INSTRUCTION_FILES_OPTION]
    else options[INSTRUCTION_FILES_OPTION] = value

    const nextPluginConfig = pluginConfig ? { ...pluginConfig } : {}
    if (Object.keys(options).length > 0) nextPluginConfig.options = options
    else delete nextPluginConfig.options

    if (pluginConfig || Object.keys(nextPluginConfig).length > 0) {
      pluginConfigs[BUILTIN_AGENTS_PLUGIN_ID] = nextPluginConfig
    } else {
      delete pluginConfigs[BUILTIN_AGENTS_PLUGIN_ID]
    }

    return {
      ...current,
      pluginConfigs:
        Object.keys(pluginConfigs).length > 0 || hadPluginConfigs
          ? pluginConfigs
          : undefined,
    }
  })
}
