import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import {
  getSessionProvider,
  isProviderSwitchLocked,
} from '../../bootstrap/state.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import { isEnvTruthy } from '../envUtils.js'
import { isModelAlias } from './aliases.js'

export type APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'openai'

export type StartupProviderPreference = 'anthropic' | 'openai'

/**
 * Returns the provider for the current session.
 * Priority: sessionProvider (set from model selection) > env vars > 'firstParty'.
 */
export function getAPIProvider(): APIProvider {
  const session = getSessionProvider()
  if (session) {
    return session
  }
  return getEnvAPIProvider()
}

/** Env-var-only provider detection (original logic). */
export function getEnvAPIProvider(): APIProvider {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)
    ? 'bedrock'
    : isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)
      ? 'vertex'
      : isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
        ? 'foundry'
        : isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI)
          ? 'openai'
          : getStartupProviderPreference() === 'openai'
            ? 'openai'
            : 'firstParty'
}

export function getStartupProviderPreference(): StartupProviderPreference {
  try {
    return getGlobalConfig().lastUsedProvider ?? 'anthropic'
  } catch {
    return 'anthropic'
  }
}

export function persistStartupProviderPreference(provider: APIProvider | null): void {
  const preference: StartupProviderPreference = provider === 'openai' ? 'openai' : 'anthropic'
  saveGlobalConfig(current =>
    current.lastUsedProvider === preference
      ? current
      : {
          ...current,
          lastUsedProvider: preference,
        },
  )
}

/**
 * Derive the provider from a model name.
 * Returns null when the model doesn't imply a specific provider on its own.
 */
export function getProviderForModel(model: string | null | undefined): APIProvider | null {
  if (!model) return null
  if (model.startsWith('gpt-')) return 'openai'
  return null
}

/**
 * Resolve the Anthropic-side provider configured by environment. Unlike
 * `getEnvAPIProvider()`, this deliberately ignores the persisted startup
 * preference: it is used after the user explicitly selects a non-GPT model
 * while currently routed through OpenAI.
 */
export function getConfiguredAnthropicProvider(): Exclude<APIProvider, 'openai'> {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)
    ? 'bedrock'
    : isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)
      ? 'vertex'
      : isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
        ? 'foundry'
        : 'firstParty'
}

/**
 * Resolve the provider for an explicit model-picker selection.
 *
 * Request routing keeps non-GPT/custom model ids ambiguous so Bedrock, Vertex,
 * and Foundry can use their own names. An explicit picker selection is
 * different: choosing any non-GPT option while the session is on OpenAI means
 * "switch back to my configured Anthropic provider." Without this transition,
 * the model string changes to `opus`/`sonnet` but the request still enters the
 * Codex adapter.
 */
export function resolveModelSelectionProvider(
  model: string | null | undefined,
  currentProvider: APIProvider = getAPIProvider(),
): APIProvider {
  const impliedProvider = getProviderForModel(model)
  if (impliedProvider) return impliedProvider

  // `null` is the provider-local Default option, and arbitrary model IDs are
  // intentionally ambiguous (OpenAI-compatible gateways and Anthropic cloud
  // providers can both use custom names). Only an explicit Claude ID/alias is
  // strong enough evidence to cross away from OpenAI.
  if (!model) return currentProvider
  const normalized = model.toLowerCase().trim()
  const isExplicitAnthropicSelection =
    normalized.startsWith('claude-') || isModelAlias(normalized)
  return currentProvider === 'openai' && isExplicitAnthropicSelection
    ? getConfiguredAnthropicProvider()
    : currentProvider
}

/**
 * Provider-family changes are safe only before the first request has built
 * provider-specific prompt/cache state. Keep this check at mutation callsites,
 * not just in the picker catalog, because `/model <alias>` bypasses the menu.
 */
export function canApplyModelSelection(
  model: string | null | undefined,
  totalInputTokens: number,
  currentProvider: APIProvider = getAPIProvider(),
): boolean {
  return (
    (!isProviderSwitchLocked() && totalInputTokens === 0) ||
    resolveModelSelectionProvider(model, currentProvider) === currentProvider
  )
}

/**
 * Startup differs from an interactive picker: only an explicit CLI/settings/
 * agent model may cross provider families. An implicit default preserves the
 * already-resolved environment/startup provider precedence.
 */
export function resolveStartupProvider(
  model: string | null | undefined,
  hasExplicitModel: boolean,
  implicitProvider: APIProvider = getEnvAPIProvider(),
): APIProvider {
  return hasExplicitModel
    ? resolveModelSelectionProvider(model, implicitProvider)
    : implicitProvider
}

/**
 * Resolve the effective provider for a specific request.
 *
 * GPT-family models always route through OpenAI. Claude-family and custom
 * model IDs remain ambiguous in this codebase, so they inherit the caller's
 * provider when one is supplied; otherwise they fall back to the current
 * session/env provider.
 */
export function resolveRequestProvider(
  model: string | null | undefined,
  baseProvider: APIProvider = getAPIProvider(),
): APIProvider {
  return getProviderForModel(model) ?? baseProvider
}

export function getAPIProviderDisplayName(
  provider: APIProvider = getAPIProvider(),
): string {
  switch (provider) {
    case 'firstParty':
      return 'Anthropic'
    case 'bedrock':
      return 'AWS Bedrock'
    case 'vertex':
      return 'Google Vertex AI'
    case 'foundry':
      return 'Microsoft Foundry'
    case 'openai':
      return 'OpenAI'
  }
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Check if ANTHROPIC_BASE_URL is a first-party Anthropic API URL.
 * Returns true if not set (default API) or points to api.anthropic.com
 * (or api-staging.anthropic.com for ant users).
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['api.anthropic.com']
    if (process.env.USER_TYPE === 'ant') {
      allowedHosts.push('api-staging.anthropic.com')
    }
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}
