// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
/**
 * Ensure that any model codenames introduced here are also added to
 * scripts/excluded-strings.txt to avoid leaking them. Wrap any codename string
 * literals with process.env.USER_TYPE === 'ant' for Bun to remove the codenames
 * during dead code elimination
 */
import { getMainLoopModelOverride } from '../../bootstrap/state.js'
import {
  getSubscriptionType,
  isClaudeAISubscriber,
  isCodexSubscriber,
  isMaxSubscriber,
  isProSubscriber,
  isTeamPremiumSubscriber,
} from '../auth.js'
import { getAntModelOverrideConfig, resolveAntModel } from './antModels.js'
import {
  has1mContext,
  is1mContextDisabled,
  modelSupports1M,
} from '../context.js'
import { isEnvTruthy } from '../envUtils.js'
import { getModelStrings, resolveOverriddenModel } from './modelStrings.js'
import { formatModelPricing, getOpus46CostTier } from '../modelCost.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import {
  getAPIProvider,
  type APIProvider,
  getConfiguredAnthropicProvider,
  isAnthropicCloudProvider,
  isFirstPartyAnthropicBaseUrl,
  type APIProvider,
} from './providers.js'
import { LIGHTNING_BOLT } from '../../constants/figures.js'
import { isModelAllowed } from './modelAllowlist.js'
import { type ModelAlias, isModelAlias } from './aliases.js'
import { capitalize } from '../stringUtils.js'
import {
  ALL_MODEL_CONFIGS,
  CODEX_ROUTES,
  currentClaudeRelease,
  currentCodexRelease,
  getClaudeFamilyKey,
  getClaudeMarketingName,
  getCodexRelease,
  getExactClaudeRelease,
  isLegacyOpusFirstParty,
  matchClaudeRelease,
  matchCodexRelease,
  remapRetiredClaudeSelection,
  remapRetiredCodexSelection,
  type ClaudeFamily,
  type ModelKey,
} from './configs.js'

export type ModelShortName = string
export type ModelName = string
export type ModelSetting = ModelName | ModelAlias | null

export function getSmallFastModel(): ModelName {
  return process.env.ANTHROPIC_SMALL_FAST_MODEL || getDefaultHaikuModel()
}

/**
 * Provider-aware small/fast model for cheap secondary calls (WebFetch
 * post-processing, session titles, away summaries, etc).
 *
 * While the active session is routed through Codex/OpenAI, the default Haiku
 * model would be sent through the wrong provider. Route provider-neutral
 * secondary calls through the Codex small/fast route.
 *
 * Anthropic-billing consumers (token estimation, claudeAiLimits) keep calling
 * getSmallFastModel() directly so the ANTHROPIC_SMALL_FAST_MODEL env var and
 * Bedrock inference-profile resolution still apply for them.
 */
export function getSmallFastModelForProvider(): ModelName {
  if (isCodexSubscriber()) {
    return getModelStrings()[CODEX_ROUTES.smallFast]
  }
  return getSmallFastModel()
}

export function isNonCustomOpusModel(model: ModelName): boolean {
  const strings = getModelStrings()
  return (Object.keys(ALL_MODEL_CONFIGS) as ModelKey[]).some(key =>
    strings[key] === model && matchClaudeRelease(ALL_MODEL_CONFIGS[key].firstParty)?.family === 'opus',
  )
}

export const remapRetiredGptModel = remapRetiredCodexSelection

// Cloud provider pins keep their own availability and retirement policy.
export function remapFirstPartyClaudeSelection(
  model: ModelName,
  provider = getAPIProvider(),
): ModelName {
  if (provider !== 'firstParty') {
    return model
  }
  return remapRetiredClaudeSelection(model)
}

/**
 * Provider-agnostic variant used only by the on-disk settings migration
 * (migrateRetiredClaude46ModelsToClaude5.ts). A config-file migration is
 * about what is stored on disk, not about which provider the current
 * process happens to be routed through: runEngineMigrations() runs from
 * shared init before setSessionProvider() settles the session provider for
 * this launch, so getAPIProvider() can still reflect the persisted
 * lastUsedProvider preference. Gating the on-disk rewrite on that preference
 * would skip Claude migrations after a Codex/OpenAI session.
 *
 * This still skips genuinely third-party-configured environments via
 * getConfiguredAnthropicProvider(), which reads only the literal
 * CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY env vars (never the persisted
 * lastUsedProvider, so it isn't subject to the ordering problem above) —
 * 3P Claude 5 availability may lag first-party, and a 3P-shaped pin (e.g. a
 * Bedrock ARN containing "claude-opus-4-6") must not be rewritten to a bare
 * id it can't route with.
 *
 * It also requires isFirstPartyAnthropicBaseUrl(): a custom ANTHROPIC_BASE_URL
 * gateway can namespace ids (e.g. 'anthropic/claude-sonnet-4-6'), and the
 * substring canonicalization that correctly resolves dated snapshots
 * (claude-opus-4-6-20260101) would otherwise also match the retired id
 * embedded in that namespaced string, silently dropping the gateway prefix
 * the persisted value is written back with.
 */
export function remapFirstPartyClaudeSelectionForMigration(model: ModelName): ModelName {
  if (
    getConfiguredAnthropicProvider() !== 'firstParty' ||
    !isFirstPartyAnthropicBaseUrl()
  ) {
    return model
  }
  return remapRetiredClaudeSelection(model)
}

/**
 * Cat Code's own env var for the model-selection env lever, checked ahead of
 * upstream Claude Code's ANTHROPIC_MODEL. ANTHROPIC_MODEL is kept working
 * (not renamed) so upstream merges don't conflict and existing scripts/docs
 * referencing it keep working; CAT_CODE_MODEL just wins when both are set.
 */
export function getModelEnvOverride(): ModelName | undefined {
  return process.env.CAT_CODE_MODEL || process.env.ANTHROPIC_MODEL || undefined
}

/**
 * Helper to get the model from /model (including via /config), the --model flag, environment variable,
 * or the saved settings. The returned value can be a model alias if that's what the user specified.
 * Undefined if the user didn't configure anything, in which case we fall back to
 * the default (null).
 *
 * Priority order within this function:
 * 1. Model override during session (from /model command) - highest priority
 * 2. Model override at startup (from --model flag)
 * 3. CAT_CODE_MODEL environment variable, then ANTHROPIC_MODEL environment variable
 * 4. Settings (from user's saved settings)
 */
export function getUserSpecifiedModelSetting(): ModelSetting | undefined {
  let specifiedModel: ModelSetting | undefined

  const modelOverride = getMainLoopModelOverride()
  if (modelOverride !== undefined) {
    specifiedModel = modelOverride
  } else {
    const settings = getSettings_DEPRECATED() || {}
    specifiedModel = getModelEnvOverride() || settings.model || undefined
  }

  if (typeof specifiedModel === 'string') {
    specifiedModel = remapRetiredGptModel(specifiedModel)
  }

  // Ignore the user-specified model if it's not in the availableModels allowlist.
  if (specifiedModel && !isModelAllowed(specifiedModel)) {
    return undefined
  }

  return specifiedModel
}

/**
 * Get the main loop model to use for the current session.
 *
 * Model Selection Priority Order:
 * 1. Model override during session (from /model command) - highest priority
 * 2. Model override at startup (from --model flag)
 * 3. CAT_CODE_MODEL environment variable, then ANTHROPIC_MODEL environment variable
 * 4. Settings (from user's saved settings)
 * 5. Built-in default
 *
 * @returns The resolved model name to use
 */
export function getMainLoopModel(): ModelName {
  const model = getUserSpecifiedModelSetting()
  if (model !== undefined && model !== null) {
    return parseUserSpecifiedModel(model)
  }
  return getDefaultMainLoopModel()
}

export function getCatalogClaudeModel(family: ClaudeFamily, cloud = false, provider?: APIProvider): ModelName {
  return getModelStrings(provider)[getClaudeFamilyKey(family, cloud)]
}

export function getBestModel(provider = getAPIProvider()): ModelName {
  return getCatalogClaudeModel('fable', isAnthropicCloudProvider(provider), provider)
}

export function getDefaultOpusModel(provider = getAPIProvider()): ModelName {
  const override = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  return override
    ? remapFirstPartyClaudeSelection(override, provider)
    : getCatalogClaudeModel('opus', isAnthropicCloudProvider(provider), provider)
}

export function getDefaultSonnetModel(provider = getAPIProvider()): ModelName {
  const override = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  return override
    ? remapFirstPartyClaudeSelection(override, provider)
    : getCatalogClaudeModel('sonnet', isAnthropicCloudProvider(provider), provider)
}

export function getDefaultHaikuModel(provider = getAPIProvider()): ModelName {
  return process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ||
    getCatalogClaudeModel('haiku', isAnthropicCloudProvider(provider), provider)
}

export function getDefaultFableModel(provider = getAPIProvider()): ModelName {
  return process.env.ANTHROPIC_DEFAULT_FABLE_MODEL || getBestModel(provider)
}

/**
 * Get the model to use for runtime, depending on the runtime context.
 * @param params Subset of the runtime context to determine the model to use.
 * @returns The model to use
 */
export function getRuntimeMainLoopModel(params: {
  permissionMode: PermissionMode
  mainLoopModel: string
  exceeds200kTokens?: boolean
  provider?: APIProvider
}): ModelName {
  const { permissionMode, mainLoopModel, exceeds200kTokens = false, provider } = params

  // opusplan uses Opus in plan mode without [1m] suffix.
  if (
    getUserSpecifiedModelSetting() === 'opusplan' &&
    permissionMode === 'plan' &&
    !exceeds200kTokens
  ) {
    return getDefaultOpusModel(provider)
  }

  // sonnetplan by default
  if (getUserSpecifiedModelSetting() === 'haiku' && permissionMode === 'plan') {
    return getDefaultSonnetModel(provider)
  }

  return mainLoopModel
}

/**
 * The Codex model a session lands on when nothing else has chosen one.
 *
 * ONE definition, because this is asked in four places that cannot share a
 * predicate: the built-in default below (`isCodexSubscriber()`), the startup
 * resolver (`main.tsx`, `getEnvAPIProvider() === 'openai'`), `/switch-account`,
 * and the desktop's first-run provider activation (both plain `provider ===
 * 'openai'`). They drifted before: three of them held a bare literal, which
 * also meant they silently ignored a `modelOverrides` entry that this one
 * honours through `getModelStrings()`.
 */
export function getDefaultCodexModel(): ModelName {
  return getModelStrings()[CODEX_ROUTES.chat]
}

/**
 * Get the default main loop model setting.
 *
 * This handles the built-in default:
 * - Opus for Max and Team Premium users
 * - Sonnet 5.5 for all other users (including Team Standard, Pro, Enterprise)
 *
 * @returns The default model setting to use
 */
export function getDefaultMainLoopModelSetting(): ModelName | ModelAlias {
  if (isCodexSubscriber()) {
    return getDefaultCodexModel()
  }

  // Ants default to defaultModel from flag config, or Opus 1M if not configured
  if (process.env.USER_TYPE === 'ant') {
    return (
      getAntModelOverrideConfig()?.defaultModel ??
      getDefaultOpusModel() + '[1m]'
    )
  }

  // Max users get Opus as default
  if (isMaxSubscriber()) {
    return getDefaultOpusModel() + (isOpus1mMergeEnabled() ? '[1m]' : '')
  }

  // Team Premium gets Opus (same as Max)
  if (isTeamPremiumSubscriber()) {
    return getDefaultOpusModel() + (isOpus1mMergeEnabled() ? '[1m]' : '')
  }

  // PAYG (1P and 3P), Enterprise, Team Standard, and Pro get Sonnet as default
  // Note that PAYG (3P) may default to an older Sonnet model
  return getDefaultSonnetModel()
}

/**
 * Synchronous operation to get the default main loop model to use
 * (bypassing any user-specified values).
 */
export function getDefaultMainLoopModel(): ModelName {
  return parseUserSpecifiedModel(getDefaultMainLoopModelSetting())
}

/**
 * Pure string-match that strips date/provider suffixes from a first-party model
 * name. Input must already be a 1P-format ID (e.g. 'claude-3-7-sonnet-20250219',
 * 'us.anthropic.claude-opus-4-6-v1:0'). Does not touch settings, so safe at
 * module top-level (see MODEL_COSTS in modelCost.ts).
 */
export function firstPartyNameToCanonical(name: ModelName): ModelShortName {
  const id = name.replace(/\[(?:1|2)m\]$/i, '')
  const exactCodex = getCodexRelease(id)
  if (exactCodex) return exactCodex.id
  const exactClaude = getExactClaudeRelease(id)
  if (exactClaude) return exactClaude.wire.foundry
  name = name.toLowerCase()
  const release = matchClaudeRelease(name)
  if (release) return release.wire.foundry
  if (name.includes('claude-3-opus')) {
    return 'claude-3-opus'
  }
  if (name.includes('claude-3-sonnet')) {
    return 'claude-3-sonnet'
  }
  if (name.includes('claude-3-haiku')) {
    return 'claude-3-haiku'
  }
  const codex = matchCodexRelease(name)
  if (codex) return codex.id
  const match = name.match(/(claude-(\d+-\d+-)?\w+)/)
  if (match && match[1]) {
    return match[1]
  }
  // Fall back to the original name if no pattern matches
  return name
}

/**
 * Maps a full model string to a shorter canonical version that's unified across 1P and 3P providers.
 * For example, 'claude-3-5-haiku-20241022' and 'us.anthropic.claude-3-5-haiku-20241022-v1:0'
 * would both be mapped to 'claude-3-5-haiku'.
 * @param fullModelName The full model name (e.g., 'claude-3-5-haiku-20241022')
 * @returns The short name (e.g., 'claude-3-5-haiku') if found, or the original name if no mapping exists
 */
export function getCanonicalName(fullModelName: ModelName): ModelShortName {
  // Resolve overridden model IDs (e.g. Bedrock ARNs) back to canonical names.
  // resolved is always a 1P-format ID, so firstPartyNameToCanonical can handle it.
  return firstPartyNameToCanonical(resolveOverriddenModel(fullModelName))
}

export function getClaudeAiUserDefaultModelDescription(
  fastMode = false,
): string {
  if (isCodexSubscriber()) {
    const release = currentCodexRelease(CODEX_ROUTES.chat)
    return `${release.label} · ${release.pickerDescription}`
  }
  if (isMaxSubscriber() || isTeamPremiumSubscriber()) {
    const { label } = currentClaudeRelease('opus')
    const context = isOpus1mMergeEnabled() ? ' with 1M context' : ''
    return `${label}${context} · Most capable for complex work${fastMode ? getOpus46PricingSuffix(true) : ''}`
  }
  return `${currentClaudeRelease('sonnet').label} · Best for everyday tasks`
}

export function renderDefaultModelSetting(
  setting: ModelName | ModelAlias,
): string {
  if (setting === 'opusplan') {
    return `${renderModelName(getDefaultOpusModel())} in plan mode, else ${renderModelName(getDefaultSonnetModel())}`
  }
  return renderModelName(parseUserSpecifiedModel(setting))
}

export function getOpus46PricingSuffix(fastMode: boolean): string {
  if (getAPIProvider() !== 'firstParty') return ''
  const pricing = formatModelPricing(getOpus46CostTier(fastMode))
  const fastModeIndicator = fastMode ? ` (${LIGHTNING_BOLT})` : ''
  return ` ·${fastModeIndicator} ${pricing}`
}

export function isOpus1mMergeEnabled(): boolean {
  if (
    is1mContextDisabled() ||
    isProSubscriber() ||
    getAPIProvider() !== 'firstParty'
  ) {
    return false
  }
  // Fail closed when a subscriber's subscription type is unknown. The VS Code
  // config-loading subprocess can have OAuth tokens with valid scopes but no
  // subscriptionType field (stale or partial refresh). Without this guard,
  // isProSubscriber() returns false for such users and the merge leaks
  // opus[1m] into the model dropdown — the API then rejects it with a
  // misleading "rate limit reached" error.
  if (isClaudeAISubscriber() && getSubscriptionType() === null) {
    return false
  }
  return true
}

export function renderModelSetting(setting: ModelName | ModelAlias): string {
  if (setting === 'opusplan') {
    return 'Opus Plan'
  }
  if (isModelAlias(setting)) {
    return capitalize(setting)
  }
  return renderModelName(setting)
}

/**
 * Returns a human-readable display name for known public models, or null
 * if the model is not recognized as a public model.
 */
export function getPublicModelDisplayName(model: ModelName): string | null {
  const codex = getCodexRelease(model)
  if (codex?.label) return codex.publicLabel ?? codex.label.replace('GPT-', 'GPT ')
  if (model.includes('gpt-') || model.includes('codex')) return model

  const long = model.endsWith('[1m]')
  const id = long ? model.slice(0, -4) : model
  const strings = getModelStrings()
  const key = (Object.keys(strings) as ModelKey[]).find(key => strings[key] === id)
  const release = key ? getExactClaudeRelease(ALL_MODEL_CONFIGS[key].firstParty) : getExactClaudeRelease(id)
  if (!release || (long && !release.longContext)) return null
  return (release.publicLabel ?? release.label) + (long ? ' (1M context)' : '')
}

function maskModelCodename(baseName: string): string {
  // Mask only the first dash-separated segment (the codename), preserve the rest
  // e.g. capybara-v2-fast → cap*****-v2-fast
  const [codename = '', ...rest] = baseName.split('-')
  const masked =
    codename.slice(0, 3) + '*'.repeat(Math.max(0, codename.length - 3))
  return [masked, ...rest].join('-')
}

export function renderModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    return publicName
  }
  if (process.env.USER_TYPE === 'ant') {
    const resolved = parseUserSpecifiedModel(model)
    const antModel = resolveAntModel(model)
    if (antModel) {
      const baseName = antModel.model.replace(/\[1m\]$/i, '')
      const masked = maskModelCodename(baseName)
      const suffix = has1mContext(resolved) ? '[1m]' : ''
      return masked + suffix
    }
    if (resolved !== model) {
      return `${model} (${resolved})`
    }
    return resolved
  }
  return model
}

/**
 * Returns a safe author name for public display (e.g., in git commit trailers).
 * Returns "Claude {ModelName}" for publicly known models, or "Claude ({model})"
 * for unknown/internal models so the exact model name is preserved.
 *
 * @param model The full model name
 * @returns "Claude {ModelName}" for public models, or "Claude ({model})" for non-public models
 */
export function getPublicModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    if (model.includes('gpt-') || model.includes('codex')) {
      return publicName
    }
    return `Claude ${publicName}`
  }
  return `Claude (${model})`
}

/**
 * Returns a full model name for use in this session, possibly after resolving
 * a model alias.
 *
 * This function intentionally does not support version numbers to align with
 * the model switcher.
 *
 * Supports [1m] suffix on any model alias (e.g., haiku[1m], sonnet[1m]) to enable
 * 1M context window without requiring each variant to be in MODEL_ALIASES.
 *
 * @param modelInput The model alias or name provided by the user.
 */
export function parseUserSpecifiedModel(
  modelInput: ModelName | ModelAlias,
  provider = getAPIProvider(),
): ModelName {
  const modelInputTrimmed = modelInput.trim()
  const remappedClaudeModel = remapFirstPartyClaudeSelection(modelInputTrimmed, provider)
  if (remappedClaudeModel !== modelInputTrimmed) {
    return remappedClaudeModel
  }
  const remappedModel = remapRetiredGptModel(modelInputTrimmed)
  if (remappedModel !== modelInputTrimmed) {
    return remappedModel
  }
  const normalizedModel = modelInputTrimmed.toLowerCase()

  const has1mTag = has1mContext(normalizedModel)
  const modelString = has1mTag
    ? normalizedModel.replace(/\[1m]$/i, '').trim()
    : normalizedModel

  if (isModelAlias(modelString)) {
    switch (modelString) {
      case 'opusplan':
        return getDefaultSonnetModel(provider) + (has1mTag ? '[1m]' : '') // Sonnet is default, Opus in plan mode
      case 'sonnet':
        return getDefaultSonnetModel(provider) + (has1mTag ? '[1m]' : '')
      case 'haiku':
        return getDefaultHaikuModel(provider) + (has1mTag ? '[1m]' : '')
      case 'opus':
        return getDefaultOpusModel(provider) + (has1mTag ? '[1m]' : '')
      case 'fable':
        return getDefaultFableModel(provider) + (has1mTag ? '[1m]' : '')
      case 'best':
        return getBestModel(provider)
      default:
    }
  }

  // Opus 4/4.1 are no longer available on the first-party API (same as
  // Claude.ai) — silently remap to the current Opus default. The 'opus'
  // alias already resolves to 4.6, so the only users on these explicit
  // strings pinned them in settings/env/--model/SDK before 4.5 launched.
  // 3P providers may not yet have 4.6 capacity, so pass through unchanged.
  if (
    provider === 'firstParty' &&
    isLegacyOpusFirstParty(modelString) &&
    isLegacyModelRemapEnabled()
  ) {
    return getDefaultOpusModel(provider) + (has1mTag ? '[1m]' : '')
  }

  if (process.env.USER_TYPE === 'ant') {
    const has1mAntTag = has1mContext(normalizedModel)
    const baseAntModel = normalizedModel.replace(/\[1m]$/i, '').trim()

    const antModel = resolveAntModel(baseAntModel)
    if (antModel) {
      const suffix = has1mAntTag ? '[1m]' : ''
      return antModel.model + suffix
    }

    // Fall through to the alias string if we cannot load the config. The API calls
    // will fail with this string, but we should hear about it through feedback and
    // can tell the user to restart/wait for flag cache refresh to get the latest values.
  }

  // Preserve original case for custom model names (e.g., Azure Foundry deployment IDs)
  // Only strip [1m] suffix if present, maintaining case of the base model
  if (has1mTag) {
    return modelInputTrimmed.replace(/\[1m\]$/i, '').trim() + '[1m]'
  }
  return modelInputTrimmed
}

/**
 * Resolves a skill's `model:` frontmatter against the current model, carrying
 * the `[1m]` suffix over when the target family supports it.
 *
 * A skill author writing `model: opus` means "use opus-class reasoning" — not
 * "downgrade to 200K". If the user is on opus[1m] at 230K tokens and invokes a
 * skill with `model: opus`, passing the bare alias through drops the effective
 * context window from 1M to 200K, which trips autocompact at 23% apparent usage
 * and surfaces "Context limit reached" even though nothing overflowed.
 *
 * We only carry [1m] when the target actually supports it (sonnet/opus). A skill
 * with `model: haiku` on a 1M session still downgrades — haiku has no 1M variant,
 * so the autocompact that follows is correct. Skills that already specify [1m]
 * are left untouched.
 */
export function resolveSkillModelOverride(
  skillModel: string,
  currentModel: string,
): string {
  if (has1mContext(skillModel) || !has1mContext(currentModel)) {
    return skillModel
  }
  // modelSupports1M matches on canonical IDs ('claude-opus-4-6', 'claude-sonnet-4');
  // a bare 'opus' alias falls through getCanonicalName unmatched. Resolve first.
  if (modelSupports1M(parseUserSpecifiedModel(skillModel))) {
    return skillModel + '[1m]'
  }
  return skillModel
}

/**
 * Opt-out for the legacy Opus 4.0/4.1 → current Opus remap.
 */
export function isLegacyModelRemapEnabled(): boolean {
  return !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP)
}

export function modelDisplayString(model: ModelSetting): string {
  if (model === null) {
    if (process.env.USER_TYPE === 'ant') {
      return `Default for Ants (${renderDefaultModelSetting(getDefaultMainLoopModelSetting())})`
    } else if (isClaudeAISubscriber()) {
      return `Default (${getClaudeAiUserDefaultModelDescription()})`
    }
    return `Default (${getDefaultMainLoopModel()})`
  }
  const resolvedModel = parseUserSpecifiedModel(model)
  return model === resolvedModel ? resolvedModel : `${model} (${resolvedModel})`
}

export function getMarketingNameForModel(modelId: string): string | undefined {
  if (getAPIProvider() === 'foundry') {
    // deployment ID is user-defined in Foundry, so it may have no relation to the actual model
    return undefined
  }

  const canonical = getCanonicalName(modelId)
  const claude = getClaudeMarketingName(
    canonical + (modelId.toLowerCase().includes('[1m]') ? '[1m]' : ''),
  )
  if (claude) return claude
  const codex = getCodexRelease(canonical)
  if (codex?.context || codex?.promptFamily) return codex.label
  return undefined
}

export function normalizeModelStringForAPI(model: string): string {
  return model.replace(/\[(1|2)m\]/gi, '')
}
