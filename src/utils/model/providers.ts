import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { getSessionProvider } from '../../bootstrap/state.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import { isEnvTruthy } from '../envUtils.js'

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
