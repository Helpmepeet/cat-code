// Keep rejected values out of SettingsJson while preserving their source priority.
export type InstructionFilesOptionMetadata = {
  value: unknown
}

const BUILTIN_AGENTS_PLUGIN_ID = 'agents-md@builtin'
const INSTRUCTION_FILES_OPTION = 'instructionFiles'
const optionMetadataBySettings = new WeakMap<
  object,
  InstructionFilesOptionMetadata
>()

export function readInstructionFilesOptionFromSettings(
  settings: unknown,
): InstructionFilesOptionMetadata | undefined {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return undefined
  }
  const pluginConfigs = (settings as Record<string, unknown>).pluginConfigs
  if (
    !pluginConfigs ||
    typeof pluginConfigs !== 'object' ||
    Array.isArray(pluginConfigs)
  ) {
    return undefined
  }
  const pluginConfig = (pluginConfigs as Record<string, unknown>)[
    BUILTIN_AGENTS_PLUGIN_ID
  ]
  if (
    !pluginConfig ||
    typeof pluginConfig !== 'object' ||
    Array.isArray(pluginConfig)
  ) {
    return undefined
  }
  const options = (pluginConfig as Record<string, unknown>).options
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return undefined
  }
  const optionRecord = options as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(optionRecord, INSTRUCTION_FILES_OPTION)) {
    return undefined
  }
  return { value: optionRecord[INSTRUCTION_FILES_OPTION] }
}

export function getInstructionFilesOptionMetadata(
  settings: object | null,
): InstructionFilesOptionMetadata | undefined {
  return settings ? optionMetadataBySettings.get(settings) : undefined
}

export function setInstructionFilesOptionMetadata(
  settings: object,
  option: InstructionFilesOptionMetadata | undefined,
): void {
  if (option) optionMetadataBySettings.set(settings, option)
  else optionMetadataBySettings.delete(settings)
}

export function isPluginConfigOptionValue(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (Array.isArray(value) && value.every(item => typeof item === 'string'))
  )
}
