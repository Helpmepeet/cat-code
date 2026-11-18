import { CURRENT_CODEX_RELEASES, currentClaudeRelease, matchClaudeRelease } from './configs.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import { capitalize } from '../stringUtils.js'
import { applyBedrockRegionPrefix, getBedrockRegionPrefix } from './bedrock.js'
import {
  getCanonicalName,
  getPublicModelDisplayName,
  getRuntimeMainLoopModel,
  parseUserSpecifiedModel,
} from './model.js'
import {
  getAPIProvider,
  isAnthropicCloudProvider,
  resolveModelSelectionProvider,
  resolveRequestProvider,
  type APIProvider,
} from './providers.js'

// The independent Opus choice is an exact selection, even on an Opus parent.
const independentOpus = currentClaudeRelease('opus')
const CODEX_AGENT_CHOICES = CURRENT_CODEX_RELEASES.map(release => release.id)
export const AGENT_TOOL_MODEL_OPTIONS = [
  'sonnet', 'opus', independentOpus.wire.firstParty, ...CODEX_AGENT_CHOICES,
] as const
export const AGENT_MODEL_OPTIONS = [
  'sonnet', 'opus', independentOpus.wire.firstParty, 'best', 'sonnet[1m]', 'opus[1m]', 'opusplan',
  ...CODEX_AGENT_CHOICES, 'inherit',
] as const
export type AgentModelAlias = (typeof AGENT_MODEL_OPTIONS)[number]
export type AgentModelSelection = Exclude<AgentModelAlias, 'inherit'>

export type AgentModelOption = {
  value: AgentModelAlias
  label: string
  description: string
}

/**
 * Get the default subagent model. Returns 'inherit' so subagents inherit
 * the model from the parent thread.
 */
export function getDefaultSubagentModel(): string {
  return 'inherit'
}

export type AgentModelRoute = { model: string; provider: APIProvider }

/** A new worker's explicit selection may cross providers without changing its parent. */
export function resolveAgentModel(
  agentModel: string | undefined,
  parentModel: string,
  toolSpecifiedModel?: AgentModelSelection,
  permissionMode?: PermissionMode,
  parentProvider?: APIProvider,
): AgentModelRoute {
  const sessionProvider = getAPIProvider()
  const effectiveParentProvider = resolveRequestProvider(
    parentModel, parentProvider ?? sessionProvider,
  )
  const override = process.env.CLAUDE_CODE_SUBAGENT_MODEL
  const spec = (override || (toolSpecifiedModel ?? agentModel ?? getDefaultSubagentModel())).trim()
  if (!override && spec === 'inherit') {
    const model = getRuntimeMainLoopModel({
      permissionMode: permissionMode ?? 'default',
      mainLoopModel: parentModel,
      exceeds200kTokens: false,
      provider: effectiveParentProvider,
    })
    return { model, provider: resolveRequestProvider(model, effectiveParentProvider) }
  }
  if (!override && aliasMatchesParentTier(spec, parentModel)) {
    return { model: parentModel, provider: effectiveParentProvider }
  }

  const selectionProvider = resolveModelSelectionProvider(
    spec.replace(/\[1m\]$/i, '').trim(), effectiveParentProvider,
  )
  const providerForSpec = effectiveParentProvider === 'openai' &&
    selectionProvider === 'firstParty' && isAnthropicCloudProvider(sessionProvider)
    ? sessionProvider
    : selectionProvider
  let model = parseUserSpecifiedModel(spec, providerForSpec)
  // A family override can resolve to an explicit Codex model.
  const provider = resolveRequestProvider(model, providerForSpec)
  if (!override && provider === 'bedrock' && !getBedrockRegionPrefix(spec)) {
    // Preserve the parent's IAM-scoped region unless the selection pins one.
    const parentRegion = getBedrockRegionPrefix(parentModel)
    if (parentRegion) model = applyBedrockRegionPrefix(model, parentRegion)
  }
  return { model, provider }
}

/**
 * Check if a bare family alias (opus/sonnet) matches the parent model's
 * tier. When it does, the subagent inherits the parent's exact model string
 * instead of resolving the alias to a provider default.
 *
 * Prevents surprising downgrades: a Vertex user on Opus 4.6 (via /model) who
 * spawns a subagent with `model: opus` should get Opus 4.6, not whatever
 * getDefaultOpusModel() previously returned on older provider defaults.
 * See https://github.com/anthropics/claude-code/issues/30815.
 *
 * Only bare family aliases match. `opus[1m]`, `best`, `opusplan`, and direct GPT model IDs fall through
 * since they carry semantics beyond "same tier as parent".
 */
function aliasMatchesParentTier(alias: string, parentModel: string): boolean {
  const canonical = getCanonicalName(parentModel)
  const family = matchClaudeRelease(canonical)?.family
  switch (alias.toLowerCase()) {
    case 'opus':
      return family === 'opus' || canonical.includes('opus')
    case 'sonnet':
      return family === 'sonnet' || canonical.includes('sonnet')
    default:
      return false
  }
}

export function getAgentModelDisplay(model: string | undefined): string {
  // When model is omitted, getDefaultSubagentModel() returns 'inherit' at runtime
  if (!model) return 'Inherit from parent (default)'
  if (model === 'inherit') return 'Inherit from parent'
  return getPublicModelDisplayName(model) ?? capitalize(model)
}

/**
 * Get available model options for agents
 */
export function getAgentModelOptions(): AgentModelOption[] {
  return [
    {
      value: 'sonnet',
      label: 'Sonnet',
      description: 'Balanced performance - best for most agents',
    },
    {
      value: 'opus',
      label: 'Opus',
      description: 'Most capable for complex reasoning tasks',
    },
    {
      value: independentOpus.wire.firstParty,
      label: independentOpus.label,
      description: `Pinned to ${independentOpus.label}, even when the parent runs something else`,
    },
    ...CURRENT_CODEX_RELEASES.map(release => ({
      value: release.id,
      label: release.label,
      description: release.agentDescription,
    })),
    {
      value: 'inherit',
      label: 'Inherit from parent',
      description: 'Use the same model as the main conversation',
    },
  ]
}
