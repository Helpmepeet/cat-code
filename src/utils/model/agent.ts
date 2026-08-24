import type { PermissionMode } from '../permissions/PermissionMode.js'
import { capitalize } from '../stringUtils.js'
import { MODEL_ALIASES, type ModelAlias } from './aliases.js'
import { applyBedrockRegionPrefix, getBedrockRegionPrefix } from './bedrock.js'
import {
  getCanonicalName,
  getDefaultOpusModel,
  getPublicModelDisplayName,
  getRuntimeMainLoopModel,
  parseUserSpecifiedModel,
} from './model.js'
import { getModelStrings } from './modelStrings.js'
import { getAPIProvider, resolveRequestProvider, type APIProvider } from './providers.js'

export const AGENT_MODEL_OPTIONS = ['sonnet', 'opus', 'best', 'sonnet[1m]', 'opus[1m]', 'opusplan', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'inherit'] as const
export type AgentModelAlias = (typeof AGENT_MODEL_OPTIONS)[number]

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

/**
 * Get the effective model string for an agent.
 *
 * For Bedrock, if the parent model uses a cross-region inference prefix (e.g., "eu.", "us."),
 * that prefix is inherited by subagents using alias models (e.g., "sonnet", "opus").
 * This ensures subagents use the same region as the parent, which is necessary when
 * IAM permissions are scoped to specific cross-region inference profiles.
 */
export function getAgentModel(
  agentModel: string | undefined,
  parentModel: string,
  toolSpecifiedModel?: ModelAlias,
  permissionMode?: PermissionMode,
  parentProvider?: APIProvider,
): string {
  if (process.env.CLAUDE_CODE_SUBAGENT_MODEL) {
    return parseUserSpecifiedModel(process.env.CLAUDE_CODE_SUBAGENT_MODEL)
  }

  const effectiveParentProvider = resolveRequestProvider(
    parentModel,
    parentProvider ?? getAPIProvider(),
  )

  // Extract Bedrock region prefix from parent model to inherit for subagents.
  // This ensures subagents use the same cross-region inference profile (e.g., "eu.", "us.")
  // as the parent, which is required when IAM permissions only allow specific regions.
  const parentRegionPrefix = getBedrockRegionPrefix(parentModel)

  // Helper to apply parent region prefix for Bedrock models.
  // `originalSpec` is the raw model string before resolution (alias or full ID).
  // If the user explicitly specified a full model ID that already carries its own
  // region prefix (e.g., "eu.anthropic.…"), we preserve it instead of overwriting
  // with the parent's prefix. This prevents silent data-residency violations when
  // an agent config intentionally pins to a different region than the parent.
  const applyParentRegionPrefix = (
    resolvedModel: string,
    originalSpec: string,
  ): string => {
    if (parentRegionPrefix && effectiveParentProvider === 'bedrock') {
      if (getBedrockRegionPrefix(originalSpec)) return resolvedModel
      return applyBedrockRegionPrefix(resolvedModel, parentRegionPrefix)
    }
    return resolvedModel
  }

  const resolveSubagentModel = (modelSpec: string): string => {
    if (modelSpec.toLowerCase() === 'sonnet') {
      return getModelStrings().sonnet46
    }
    if (modelSpec.toLowerCase() === 'opus') {
      return getDefaultOpusModel()
    }
    return parseUserSpecifiedModel(modelSpec)
  }

  // Prioritize tool-specified model if provided
  if (toolSpecifiedModel) {
    if (aliasMatchesParentTier(toolSpecifiedModel, parentModel)) {
      return parentModel
    }
    const model = resolveSubagentModel(toolSpecifiedModel)
    return applyParentRegionPrefix(model, toolSpecifiedModel)
  }

  const agentModelWithExp = agentModel ?? getDefaultSubagentModel()

  if (agentModelWithExp === 'inherit') {
    // Apply runtime model resolution for inherit to get the effective model
    // This ensures agents using 'inherit' get opusplan→Opus resolution in plan mode
    return getRuntimeMainLoopModel({
      permissionMode: permissionMode ?? 'default',
      mainLoopModel: parentModel,
      exceeds200kTokens: false,
    })
  }

  if (aliasMatchesParentTier(agentModelWithExp, parentModel)) {
    return parentModel
  }
  const model = resolveSubagentModel(agentModelWithExp)
  return applyParentRegionPrefix(model, agentModelWithExp)
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
  switch (alias.toLowerCase()) {
    case 'opus':
      return canonical.includes('opus')
    case 'sonnet':
      return canonical.includes('sonnet')
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
      value: 'gpt-5.6-sol',
      label: 'GPT-5.6 Sol',
      description: 'Frontier GPT-5.6 option for complex professional work',
    },
    {
      value: 'gpt-5.6-terra',
      label: 'GPT-5.6 Terra',
      description: 'Balanced GPT-5.6 option for everyday agentic coding (preview)',
    },
    {
      value: 'gpt-5.6-luna',
      label: 'GPT-5.6 Luna',
      description: 'Fast GPT-5.6 option for agentic coding (preview)',
    },
    {
      value: 'inherit',
      label: 'Inherit from parent',
      description: 'Use the same model as the main conversation',
    },
  ]
}
