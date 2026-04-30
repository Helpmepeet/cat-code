// Critical system constants extracted to break circular dependencies

import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { logForDebugging } from '../utils/debug.js'
import { isEnvDefinedFalsy } from '../utils/envUtils.js'
import { getAPIProvider, type APIProvider } from '../utils/model/providers.js'
import { getWorkload } from '../utils/workloadContext.js'

const DEFAULT_PREFIX = `You are Cat Code.`
const AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX = `You are Cat Code, running within the Claude Agent SDK.`
const AGENT_SDK_PREFIX = `You are an agent for Cat Code.`
const OPENAI_DEFAULT_PREFIX = `You are Cat Code.`
const OPENAI_AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX = `You are Cat Code, running within an agent SDK runtime.`
const OPENAI_AGENT_SDK_PREFIX = `You are an agent for Cat Code.`

const CLI_SYSPROMPT_PREFIX_VALUES = [
  DEFAULT_PREFIX,
  AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX,
  AGENT_SDK_PREFIX,
  OPENAI_DEFAULT_PREFIX,
  OPENAI_AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX,
  OPENAI_AGENT_SDK_PREFIX,
] as const

export type CLISyspromptPrefix = (typeof CLI_SYSPROMPT_PREFIX_VALUES)[number]

/**
 * All possible CLI sysprompt prefix values, used by splitSysPromptPrefix
 * to identify prefix blocks by content rather than position.
 */
export const CLI_SYSPROMPT_PREFIXES: ReadonlySet<string> = new Set(
  CLI_SYSPROMPT_PREFIX_VALUES,
)

export function getAgentPromptIdentityPrefix(
  provider: APIProvider = getAPIProvider(),
): string {
  if (provider === 'openai') {
    return `You are an agent for Cat Code using OpenAI's Codex/GPT models.`
  }
  return `You are an agent for Cat Code.`
}

export function getSearchAgentIdentityPrefix(_provider: APIProvider = getAPIProvider()): string {
  return `You are a file search specialist for Cat Code.`
}

export function getCLISyspromptPrefix(options?: {
  isNonInteractive: boolean
  hasAppendSystemPrompt: boolean
}): CLISyspromptPrefix {
  const apiProvider = getAPIProvider()
  const defaultPrefix =
    apiProvider === 'openai' ? OPENAI_DEFAULT_PREFIX : DEFAULT_PREFIX
  const agentSdkClaudeCodePresetPrefix =
    apiProvider === 'openai'
      ? OPENAI_AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX
      : AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX
  const agentSdkPrefix =
    apiProvider === 'openai' ? OPENAI_AGENT_SDK_PREFIX : AGENT_SDK_PREFIX
  if (apiProvider === 'vertex') {
    return defaultPrefix
  }

  if (options?.isNonInteractive) {
    if (options.hasAppendSystemPrompt) {
      return agentSdkClaudeCodePresetPrefix
    }
    return agentSdkPrefix
  }
  return defaultPrefix
}

/**
 * Check if attribution header is enabled.
 * Enabled by default, can be disabled via env var or GrowthBook killswitch.
 */
function isAttributionHeaderEnabled(): boolean {
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_ATTRIBUTION_HEADER)) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_attribution_header', true)
}

/**
 * Get attribution header for API requests.
 * Returns a header string with cc_version (including fingerprint) and cc_entrypoint.
 * Enabled by default, can be disabled via env var or GrowthBook killswitch.
 *
 * Includes a `cch=00000` placeholder that is replaced with a computed
 * xxHash64-based integrity hash before the request is sent. The fetch
 * wrapper in client.ts handles the replacement. The server verifies
 * this token to gate features like fast mode.
 */
export function getAttributionHeader(fingerprint: string): string {
  if (!isAttributionHeaderEnabled()) {
    return ''
  }

  const version = `${MACRO.VERSION}.${fingerprint}`
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? 'unknown'

  const cch = ' cch=00000;'
  // cc_workload: turn-scoped hint so the API can route e.g. cron-initiated
  // requests to a lower QoS pool. Absent = interactive default. Safe re:
  // fingerprint (computed from msg chars + version only, line 78 above) and
  // cch attestation (placeholder overwritten in serialized body bytes after
  // this string is built). Server _parse_cc_header tolerates unknown extra
  // fields so old API deploys silently ignore this.
  const workload = getWorkload()
  const workloadPair = workload ? ` cc_workload=${workload};` : ''
  const header = `x-anthropic-billing-header: cc_version=${version}; cc_entrypoint=${entrypoint};${cch}${workloadPair}`

  logForDebugging(`attribution header ${header}`)
  return header
}
