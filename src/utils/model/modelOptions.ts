import { getConfiguredStandardModelCosts } from '../modelCostRates.js'
import {
  CURRENT_CODEX_RELEASES,
  currentClaudeRelease,
  getClaudeFamilyKey,
  getClaudeRelease,
  matchClaudeRelease,
  type ClaudeFamily,
} from './configs.js'
// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { getAntModels } from './antModels.js'
import {
  getInitialMainLoopModel,
  getTotalInputTokens,
  isProviderSwitchLocked,
} from '../../bootstrap/state.js'
import {
  hasCodexTokens,
  hasAnthropicCredentials,
  isClaudeAISubscriber,
  isCodexSubscriber,
  isMaxSubscriber,
  isTeamPremiumSubscriber,
} from '../auth.js'
import {
  COST_TIER_3_15,
  COST_TIER_5_25,
  formatModelPricing,
} from '../modelCost.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import { checkOpus1mAccess } from './check1mAccess.js'
import { getAPIProvider, getConfiguredAnthropicProvider, isAnthropicCloudProvider } from './providers.js'
import { isModelAllowed } from './modelAllowlist.js'
import {
  getCanonicalName,
  getCatalogClaudeModel,
  getClaudeAiUserDefaultModelDescription,
  getDefaultSonnetModel,
  getDefaultOpusModel,
  getDefaultFableModel,
  getDefaultHaikuModel,
  getDefaultMainLoopModelSetting,
  getMarketingNameForModel,
  getUserSpecifiedModelSetting,
  isOpus1mMergeEnabled,
  getOpus46PricingSuffix,
  parseUserSpecifiedModel,
  renderDefaultModelSetting,
  type ModelSetting,
} from './model.js'
import { has1mContext, modelUses1MContextByDefault } from '../context.js'
import { getGlobalConfig } from '../config.js'

export type ModelOption = {
  value: ModelSetting
  label: string
  description: string
  descriptionForModel?: string
}

export function getDefaultOptionForUser(fastMode = false): ModelOption {
  if (process.env.USER_TYPE === 'ant') {
    const currentModel = renderDefaultModelSetting(
      getDefaultMainLoopModelSetting(),
    )
    return {
      value: null,
      label: 'Default (recommended)',
      description: `Use the default model for Ants (currently ${currentModel})`,
      descriptionForModel: `Default model (currently ${currentModel})`,
    }
  }

  // Subscribers
  if (isClaudeAISubscriber()) {
    return {
      value: null,
      label: 'Default (recommended)',
      description: getClaudeAiUserDefaultModelDescription(fastMode),
    }
  }

  // PAYG
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: null,
    label: 'Default (recommended)',
    description: `Use the default model (currently ${renderDefaultModelSetting(getDefaultMainLoopModelSetting())})${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
  }
}

function getCustomSonnetOption(): ModelOption | undefined {
  const is3P = getAPIProvider() !== 'firstParty'
  const customSonnetModel = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  // When a 3P user has a custom sonnet model string, show it directly
  if (is3P && customSonnetModel) {
    const is1m = has1mContext(customSonnetModel)
    return {
      value: 'sonnet',
      label:
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME ?? customSonnetModel,
      description:
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION ??
        `Custom Sonnet model${is1m ? ' (1M context)' : ''}`,
      descriptionForModel: `${process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION ?? `Custom Sonnet model${is1m ? ' with 1M context' : ''}`} (${customSonnetModel})`,
    }
  }
}

function getCustomOpusOption(): ModelOption | undefined {
  const is3P = getAPIProvider() !== 'firstParty'
  const customOpusModel = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  // When a 3P user has a custom opus model string, show it directly
  if (is3P && customOpusModel) {
    const is1m = has1mContext(customOpusModel)
    return {
      value: 'opus',
      label: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME ?? customOpusModel,
      description:
        process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION ??
        `Custom Opus model${is1m ? ' (1M context)' : ''}`,
      descriptionForModel: `${process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION ?? `Custom Opus model${is1m ? ' with 1M context' : ''}`} (${customOpusModel})`,
    }
  }
}

/**
 * `(1M context)` only distinguishes a row when the model it names is not ALREADY
 * 1M. Claude 5 frontier models are (`modelUses1MContextByDefault`,
 * `context.ts:56-67`, resolved at `:91-96`), so on first-party these rows named a
 * window identical to the plain row beside them and the suffix described nothing.
 * On a 3P provider the same rows still target 4.6-era models, which are NOT 1M by
 * default, so both the extra row and the suffix stay meaningful there.
 */
function oneMContextSuffix(): string {
  return modelUses1MContextByDefault(getDefaultOpusModel()) ? '' : ' (1M context)'
}

/** A separate `[1m]` row is a duplicate once the base model is already 1M. */
function offersDistinctOpus1m(): boolean {
  return !modelUses1MContextByDefault(getDefaultOpusModel())
}

function getLegacyOpusOption(): ModelOption {
  const { label } = getClaudeRelease('opus41')
  return {
    value: 'opus',
    label,
    description: `${label} · Legacy`,
    descriptionForModel: `${label} - legacy version`,
  }
}

function getCloudOpusOption(fastMode = false): ModelOption {
  const { label } = getClaudeRelease(getClaudeFamilyKey('opus', true))
  return {
    value: getAPIProvider() === 'firstParty' ? 'opus' : getCatalogClaudeModel('opus', true),
    label: 'Opus',
    description: `${label} · Most capable for complex work${getOpus46PricingSuffix(fastMode)}`,
    descriptionForModel: `${label} - most capable for complex work`,
  }
}

export function getOpus46_1MOption(fastMode = false): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  const { label } = getClaudeRelease(getClaudeFamilyKey('opus', true))
  return {
    value: is3P ? getCatalogClaudeModel('opus', true) + '[1m]' : 'opus[1m]',
    label: `Opus${oneMContextSuffix()}`,
    description: `${label} for long sessions${getOpus46PricingSuffix(fastMode)}`,
    descriptionForModel: `${label} with 1M context window - for long sessions with large codebases`,
  }
}

function priceSuffix(model: string, show: boolean): string {
  const rates = show ? getConfiguredStandardModelCosts(model) : undefined
  return rates ? ` · ${formatModelPricing(rates)}` : ''
}

function getCurrentClaudeOption(family: 'sonnet' | 'opus' | 'fable'): ModelOption {
  const { label, wire } = currentClaudeRelease(family)
  const is3P = getAPIProvider() !== 'firstParty'
  const descriptions = {
    sonnet: 'Best for everyday tasks',
    opus: 'Most capable for complex work',
    fable: 'Maximum capability frontier model',
  }
  const detail = descriptions[family]
  return {
    value: is3P ? getCatalogClaudeModel(family) : family,
    label,
    description: `${label} · ${detail}${priceSuffix(wire.firstParty, !is3P)}`,
    descriptionForModel: `${label} - ${detail[0]!.toLowerCase()}${detail.slice(1)}${family === 'sonnet' ? '. Generally recommended for most coding tasks' : ''}`,
  }
}

function getCustomHaikuOption(): ModelOption | undefined {
  const customHaikuModel = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  if (customHaikuModel) {
    return {
      value: 'haiku',
      label: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME ?? customHaikuModel,
      description:
        process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION ??
        'Custom Haiku model',
      descriptionForModel: `${process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION ?? 'Custom Haiku model'} (${customHaikuModel})`,
    }
  }
}

function getCurrentHaikuOption(): ModelOption {
  const { label, wire } = currentClaudeRelease('haiku')
  return {
    value: 'haiku',
    label,
    description: `${label} · Fast, low cost for quick answers${priceSuffix(wire.firstParty, getConfiguredAnthropicProvider() === 'firstParty')}`,
    descriptionForModel: `${label} - fast, low-cost model for quick answers. Less capable than ${currentClaudeRelease('sonnet').label}.`,
  }
}

function getCloudHaikuOption(): ModelOption {
  const { label, wire } = getClaudeRelease(getClaudeFamilyKey('haiku', true))
  return {
    value: 'haiku',
    label,
    description: `${label} · Fastest for quick answers${priceSuffix(wire.firstParty, getConfiguredAnthropicProvider() === 'firstParty')}`,
    descriptionForModel: `${label} - fastest for quick answers. Lower cost but less capable than ${getClaudeRelease('sonnet46').label}.`,
  }
}

function getHaikuOption(): ModelOption {
  return getCustomHaikuOption() ??
    (isAnthropicCloudProvider(getConfiguredAnthropicProvider())
      ? getCloudHaikuOption()
      : getCurrentHaikuOption())
}

function getCodexOptions(): ModelOption[] {
  return CURRENT_CODEX_RELEASES.map(release => ({
    value: release.id,
    label: release.label,
    description: `${release.label} · ${release.pickerDescription}`,
    descriptionForModel: release.pickerDetail ??
      `${release.label} - ${release.pickerDescription.replace(/^./, first => first.toLowerCase())}`,
  }))
}

function getMaxOpusOption(): ModelOption {
  const { label } = currentClaudeRelease('opus')
  return { value: 'opus', label, description: `${label} · Most capable for complex work` }
}

export function getMaxOpus46_1MOption(fastMode = false): ModelOption {
  const billingInfo = isClaudeAISubscriber() ? ' · Billed as extra usage' : ''
  const { label } = getClaudeRelease(getClaudeFamilyKey('opus', getAPIProvider() !== 'firstParty'))
  return {
    value: 'opus[1m]',
    label: `${label}${oneMContextSuffix()}`,
    description: `${label} with 1M context${billingInfo}${getOpus46PricingSuffix(fastMode)}`,
  }
}

function getMergedOpus1MOption(fastMode = false): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  const { label } = getClaudeRelease(getClaudeFamilyKey('opus', is3P))
  return {
    value: is3P ? getCatalogClaudeModel('opus', true) + '[1m]' : 'opus[1m]',
    label: `${label}${oneMContextSuffix()}`,
    description: `${label} with 1M context · Most capable for complex work${!is3P && fastMode ? getOpus46PricingSuffix(fastMode) : ''}`,
    descriptionForModel: `${label} with 1M context - most capable for complex work`,
  }
}

const subscribedSonnet: ModelOption = {
  value: 'sonnet',
  label: currentClaudeRelease('sonnet').label,
  description: `${currentClaudeRelease('sonnet').label} · Best for everyday tasks`,
}

function getOpusPlanOption(): ModelOption {
  const opus = currentClaudeRelease('opus').label
  const sonnet = currentClaudeRelease('sonnet').label
  return {
    value: 'opusplan',
    label: `${opus} Plan Mode`,
    description: `Use ${opus} in plan mode, ${sonnet} otherwise`,
  }
}

// Each user tier (ant, Max/Team Premium, Pro/Team Standard/Enterprise, PAYG 1P, PAYG 3P) has its own list.
function getModelOptionsBase(fastMode = false): ModelOption[] {
  if (process.env.USER_TYPE === 'ant') {
    // Build options from antModels config
    const antModelOptions: ModelOption[] = getAntModels().map(m => ({
      value: m.alias,
      label: m.label,
      description: m.description ?? `[ANT-ONLY] ${m.label} (${m.model})`,
    }))

    return [
      getDefaultOptionForUser(),
      ...antModelOptions,
      getMergedOpus1MOption(fastMode),
      getCurrentHaikuOption(),
    ]
  }

  // Show GPT/Codex models when session provider is openai.
  // Cross-provider options only before the first query (no cache to invalidate).
  if (isCodexSubscriber()) {
    const codexOptions: ModelOption[] = [
      getDefaultOptionForUser(),
      ...getCodexOptions(),
    ]
    if (
      !isProviderSwitchLocked() &&
      getTotalInputTokens() === 0 &&
      hasAnthropicCredentials()
    ) {
      codexOptions.push(
        getCurrentClaudeOption('fable'),
        getCurrentClaudeOption('opus'),
        getCurrentClaudeOption('sonnet'),
        getHaikuOption(),
      )
    }
    return codexOptions
  }

  if (isClaudeAISubscriber()) {
    if (isMaxSubscriber() || isTeamPremiumSubscriber()) {
      // Keep the default model selectable alongside the Default row.
      const premiumOptions = [getDefaultOptionForUser(fastMode)]
      premiumOptions.push(getCurrentClaudeOption('fable'))
      premiumOptions.push(getCurrentClaudeOption('opus'))
      if (
        !isOpus1mMergeEnabled() &&
        checkOpus1mAccess() &&
        offersDistinctOpus1m()
      ) {
        premiumOptions.push(getMaxOpus46_1MOption(fastMode))
      }
      premiumOptions.push(subscribedSonnet)
      premiumOptions.push(getCurrentHaikuOption())
      return premiumOptions
    }

    // Keep Sonnet explicit even when it is also the provider default.
    const standardOptions = [getDefaultOptionForUser(fastMode)]
    standardOptions.push(getCurrentClaudeOption('fable'))
    if (isOpus1mMergeEnabled()) {
      standardOptions.push(getMergedOpus1MOption(fastMode))
    } else {
      standardOptions.push(getMaxOpusOption())
      if (checkOpus1mAccess() && offersDistinctOpus1m()) {
        standardOptions.push(getMaxOpus46_1MOption(fastMode))
      }
    }
    standardOptions.push(subscribedSonnet)
    standardOptions.push(getCurrentHaikuOption())
    return standardOptions
  }

  // PAYG 1P API: Default + Fable + Opus 5.5 + Opus 1M + Sonnet 5.5 + Haiku
  if (getAPIProvider() === 'firstParty') {
    const payg1POptions = [getDefaultOptionForUser(fastMode)]
    payg1POptions.push(getCurrentClaudeOption('fable'))
    if (isOpus1mMergeEnabled()) {
      payg1POptions.push(getMergedOpus1MOption(fastMode))
    } else {
      payg1POptions.push(getCurrentClaudeOption('opus'))
      if (checkOpus1mAccess() && offersDistinctOpus1m()) {
        payg1POptions.push(getOpus46_1MOption(fastMode))
      }
    }
    payg1POptions.push(getCurrentClaudeOption('sonnet'))
    payg1POptions.push(getCurrentHaikuOption())
    return payg1POptions
  }

  // PAYG 3P: Default + Sonnet (3P custom only) + Opus (3P custom) or Opus 4.1/
  // Opus 4.6/Opus1M + Haiku. A 3P user reaches Sonnet through the Default row or
  // ANTHROPIC_DEFAULT_SONNET_MODEL; the fixed Sonnet 4.6 rows were removed with
  // the rest of the 4.6 roster.
  const payg3pOptions = [getDefaultOptionForUser(fastMode)]

  const customSonnet = getCustomSonnetOption()
  if (customSonnet !== undefined) {
    payg3pOptions.push(customSonnet)
  }

  const customOpus = getCustomOpusOption()
  if (customOpus !== undefined) {
    payg3pOptions.push(customOpus)
  } else {
    // Add Opus 4.1, Opus 4.6 and Opus 4.6 1M
    payg3pOptions.push(getLegacyOpusOption()) // This is the default opus
    payg3pOptions.push(getCloudOpusOption(fastMode))
    if (checkOpus1mAccess() && offersDistinctOpus1m()) {
      payg3pOptions.push(getOpus46_1MOption(fastMode))
    }
  }
  const customHaiku = getCustomHaikuOption()
  if (customHaiku !== undefined) {
    payg3pOptions.push(customHaiku)
  } else {
    payg3pOptions.push(getHaikuOption())
  }
  return payg3pOptions
}

const defaultForFamily: Record<ClaudeFamily, () => string> = {
  fable: getDefaultFableModel,
  sonnet: getDefaultSonnetModel,
  opus: getDefaultOpusModel,
  haiku: getDefaultHaikuModel,
}

function getModelFamilyInfo(
  model: string,
): { alias: string; currentVersionName: string } | null {
  const release = matchClaudeRelease(getCanonicalName(model))
  if (!release) return null
  const currentVersionName = getMarketingNameForModel(defaultForFamily[release.family]())
  return currentVersionName
    ? { alias: release.family[0]!.toUpperCase() + release.family.slice(1), currentVersionName }
    : null
}

/**
 * Returns a ModelOption for a known Anthropic model with a human-readable
 * label, and an upgrade hint if a newer version is available via the alias.
 * Returns null if the model is not recognized.
 */
function getKnownModelOption(model: string): ModelOption | null {
  const marketingName = getMarketingNameForModel(model)
  if (!marketingName) return null

  const familyInfo = getModelFamilyInfo(model)
  if (!familyInfo) {
    return {
      value: model,
      label: marketingName,
      description: model,
    }
  }

  // Check if the alias currently resolves to a different (newer) version
  if (marketingName !== familyInfo.currentVersionName) {
    return {
      value: model,
      label: marketingName,
      description: `Newer version available · select ${familyInfo.alias} for ${familyInfo.currentVersionName}`,
    }
  }

  // Same version as the alias — just show the friendly name
  return {
    value: model,
    label: marketingName,
    description: model,
  }
}

/**
 * Aliases whose resolved model is deliberately NOT the model their row stands
 * for: `opusplan` resolves to the Sonnet default (Opus applies in plan mode
 * only) and `best` resolves to Fable. Comparing them by resolved model would
 * fold their rows into another family's row, so they match by exact string only.
 */
function isResolutionOpaqueSetting(setting: string): boolean {
  const base = setting.trim().toLowerCase().replace(/\[1m]$/i, '').trim()
  return base === 'opusplan' || base === 'best'
}

function resolveSettingOrNull(setting: string): string | null {
  try {
    return parseUserSpecifiedModel(setting)
  } catch {
    return null
  }
}

/**
 * Whether an option already offers `setting`. The raw string is the fast path;
 * the resolved comparison catches the alias-vs-canonical split that otherwise
 * appends a second, byte-identical row — the picker offers Sonnet as the alias
 * `sonnet`, while a Codex session persists the canonical `claude-sonnet-5-5`
 * in a provider-dependent row. The `[1m]` suffix survives
 * resolution, so a 1M variant stays distinct from its base model.
 */
export function optionCoversModelSetting(
  optionValue: ModelSetting,
  setting: ModelSetting,
): boolean {
  if (optionValue === null || setting === null) return false
  if (optionValue === setting) return true
  if (
    isResolutionOpaqueSetting(optionValue) ||
    isResolutionOpaqueSetting(setting)
  ) {
    return false
  }
  const resolvedOption = resolveSettingOrNull(optionValue)
  const resolvedSetting = resolveSettingOrNull(setting)
  return (
    resolvedOption !== null &&
    resolvedSetting !== null &&
    resolvedOption === resolvedSetting
  )
}

export function getModelOptions(fastMode = false): ModelOption[] {
  const options = getModelOptionsBase(fastMode)

  // Before first query, show GPT models when Codex tokens exist so the user
  // can switch provider before any cache is built. After the first query,
  // lock to the current provider to avoid cache invalidation.
  if (
    !isProviderSwitchLocked() &&
    getTotalInputTokens() === 0 &&
    !isCodexSubscriber() &&
    hasCodexTokens()
  ) {
    for (const gpt of getCodexOptions()) {
      if (!options.some(existing => existing.value === gpt.value)) {
        options.push(gpt)
      }
    }
  }

  // Add the custom model from the ANTHROPIC_CUSTOM_MODEL_OPTION env var
  const envCustomModel = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION
  if (
    envCustomModel &&
    !options.some(existing => existing.value === envCustomModel)
  ) {
    options.push({
      value: envCustomModel,
      label: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME ?? envCustomModel,
      description:
        process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION ??
        `Custom model (${envCustomModel})`,
    })
  }

  // Append additional model options fetched during bootstrap
  for (const opt of getGlobalConfig().additionalModelOptionsCache ?? []) {
    if (!options.some(existing => existing.value === opt.value)) {
      options.push(opt)
    }
  }

  // Add custom model from either the current model value or the initial one
  // if it is not already in the options.
  let customModel: ModelSetting = null
  const currentMainLoopModel = getUserSpecifiedModelSetting()
  const initialMainLoopModel = getInitialMainLoopModel()
  if (currentMainLoopModel !== undefined && currentMainLoopModel !== null) {
    customModel = currentMainLoopModel
  } else if (initialMainLoopModel !== null) {
    customModel = initialMainLoopModel
  }
  if (
    customModel === null ||
    options.some(opt => optionCoversModelSetting(opt.value, customModel))
  ) {
    return filterModelOptionsByAllowlist(options)
  } else if (customModel === 'opusplan') {
    return filterModelOptionsByAllowlist([...options, getOpusPlanOption()])
  } else if (customModel === 'opus' && getAPIProvider() === 'firstParty') {
    return filterModelOptionsByAllowlist([
      ...options,
      getMaxOpusOption(),
    ])
  } else if (customModel === 'opus[1m]' && getAPIProvider() === 'firstParty') {
    return filterModelOptionsByAllowlist([
      ...options,
      getMergedOpus1MOption(fastMode),
    ])
  } else {
    // Try to show a human-readable label for known Anthropic models, with an
    // upgrade hint if the alias now resolves to a newer version.
    const knownOption = getKnownModelOption(customModel)
    if (knownOption) {
      options.push(knownOption)
    } else {
      options.push({
        value: customModel,
        label: customModel,
        description: 'Custom model',
      })
    }
    return filterModelOptionsByAllowlist(options)
  }
}

/**
 * Filter model options by the availableModels allowlist.
 * Always preserves the "Default" option (value: null).
 */
function filterModelOptionsByAllowlist(options: ModelOption[]): ModelOption[] {
  const settings = getSettings_DEPRECATED() || {}
  if (!settings.availableModels) {
    return options // No restrictions
  }
  return options.filter(
    opt =>
      opt.value === null || (opt.value !== null && isModelAllowed(opt.value)),
  )
}
