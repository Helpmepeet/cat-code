import { join } from 'path'
import {
  hasRequiredMcpServers,
  type AgentDefinition,
  type AgentDefinitionsResult,
  type AgentMcpServerSpec,
} from '../../src/tools/AgentTool/loadAgentsDir.js'
import { resolveAgentOverrides } from '../../src/tools/AgentTool/agentDisplay.js'
import type { AppStateStore } from '../../src/state/AppStateStore.js'
import { selectAvailableMcpServerNames } from '../../src/services/mcp/mcpState.js'
import type {
  AgentConfigDefinition,
  AgentConfigSnapshot,
  AgentConfigSourceId,
  AgentConfigTools,
} from '../shared/protocol.js'

export type SidecarAgentConfigDomain = {
  /** Live agent definition snapshot over current MCP availability. */
  getSnapshot(): AgentConfigSnapshot
  subscribe(listener: () => void): () => void
}

const READ_ONLY_SCOPE_REASON =
  'P4-7 exposes a read-only snapshot; desktop editing waits for a full-fidelity writer.'

export function createSidecarAgentConfigDomain({
  agentDefinitions,
  appStateStore,
}: {
  agentDefinitions: AgentDefinitionsResult
  appStateStore: AppStateStore
}): SidecarAgentConfigDomain {
  const getAvailableMcpServers = () =>
    selectAvailableMcpServerNames(appStateStore.getState().mcp)

  return {
    getSnapshot() {
      return buildAgentConfigSnapshot({
        result: agentDefinitions,
        availableMcpServers: getAvailableMcpServers(),
      })
    },
    subscribe(listener) {
      let previous = JSON.stringify(getAvailableMcpServers())
      return appStateStore.subscribe(() => {
        const next = JSON.stringify(getAvailableMcpServers())
        if (next === previous) return
        previous = next
        listener()
      })
    },
  }
}

export function buildAgentConfigSnapshot({
  result,
  availableMcpServers,
}: {
  result: AgentDefinitionsResult
  availableMcpServers: readonly string[]
}): AgentConfigSnapshot {
  const activeDefinitionIds = new Set(
    result.activeAgents.map(agent => agentDefinitionId(agent)),
  )
  const resolved = resolveAgentOverrides(result.allAgents, result.activeAgents)

  const definitions = resolved.map(agent => {
    const id = agentDefinitionId(agent)
    const isActive = activeDefinitionIds.has(id)
    const missingMcpServers = missingRequiredMcpServers(agent, availableMcpServers)
    return {
      id,
      agentType: agent.agentType,
      source: agent.source as AgentConfigSourceId,
      ...(agent.baseDir ? { baseDir: agent.baseDir } : {}),
      ...(agent.filename ? { filename: agent.filename } : {}),
      ...(agent.baseDir && agent.filename
        ? { filePath: join(agent.baseDir, `${agent.filename}.md`) }
        : {}),
      ...('plugin' in agent && agent.plugin ? { plugin: agent.plugin } : {}),
      whenToUse: agent.whenToUse,
      tools: toolsSnapshot(agent.tools),
      ...(agent.disallowedTools ? { disallowedTools: [...agent.disallowedTools] } : {}),
      ...(agent.skills ? { skills: [...agent.skills] } : {}),
      ...(agent.model ? { model: agent.model } : {}),
      provider: 'runtime' as const,
      ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
      ...(agent.permissionMode ? { permissionMode: agent.permissionMode } : {}),
      ...(agent.maxTurns !== undefined ? { maxTurns: agent.maxTurns } : {}),
      ...(agent.color ? { color: agent.color } : {}),
      background: agent.background === true,
      ...(agent.memory ? { memory: agent.memory } : {}),
      ...(agent.isolation ? { isolation: agent.isolation } : {}),
      hasInitialPrompt: Boolean(agent.initialPrompt),
      hasHooks: Boolean(agent.hooks),
      hasMcpServers: Boolean(agent.mcpServers?.length),
      ...mcpServerSummary(agent.mcpServers),
      requiredMcpServers: [...(agent.requiredMcpServers ?? [])],
      missingMcpServers,
      active: isActive,
      ...(agent.overriddenBy
        ? { overriddenBy: agent.overriddenBy as AgentConfigSourceId }
        : {}),
      available: isActive && hasRequiredMcpServers(agent, [...availableMcpServers]),
      editable: false,
      readOnlyReason: READ_ONLY_SCOPE_REASON,
      systemPrompt: {
        available: true,
        withheldReason: 'secret-boundary' as const,
      },
    } satisfies AgentConfigDefinition
  })

  definitions.sort((left, right) => {
    const bySource = sourceDisplayRank(left.source) - sourceDisplayRank(right.source)
    if (bySource !== 0) return bySource
    return left.agentType.localeCompare(right.agentType)
  })

  return {
    definitions,
    failedFiles: result.failedFiles ?? [],
    availableMcpServers: [...availableMcpServers].sort((a, b) => a.localeCompare(b)),
  }
}

function agentDefinitionId(agent: AgentDefinition): string {
  return [agent.source, agent.agentType, agent.baseDir ?? '', agent.filename ?? '']
    .join(':')
    .replace(/\s+/g, ' ')
}

function toolsSnapshot(tools: string[] | undefined): AgentConfigTools {
  if (tools === undefined) return { mode: 'all' }
  if (tools.length === 0) return { mode: 'none' }
  return { mode: 'list', names: [...tools].sort((a, b) => a.localeCompare(b)) }
}

function mcpServerSummary(mcpServers: AgentMcpServerSpec[] | undefined): {
  mcpServerRefs: string[]
  inlineMcpServerNames: string[]
} {
  const refs: string[] = []
  const inlineNames: string[] = []
  for (const spec of mcpServers ?? []) {
    if (typeof spec === 'string') {
      refs.push(spec)
    } else {
      inlineNames.push(...Object.keys(spec))
    }
  }
  return {
    mcpServerRefs: refs.sort((a, b) => a.localeCompare(b)),
    inlineMcpServerNames: inlineNames.sort((a, b) => a.localeCompare(b)),
  }
}

function missingRequiredMcpServers(
  agent: AgentDefinition,
  availableMcpServers: readonly string[],
): string[] {
  return (agent.requiredMcpServers ?? []).filter(
    pattern =>
      !availableMcpServers.some(server =>
        server.toLowerCase().includes(pattern.toLowerCase()),
      ),
  )
}

function sourceDisplayRank(source: AgentConfigSourceId): number {
  switch (source) {
    case 'policySettings':
      return 0
    case 'flagSettings':
      return 1
    case 'localSettings':
      return 2
    case 'projectSettings':
      return 3
    case 'userSettings':
      return 4
    case 'plugin':
      return 5
    case 'built-in':
      return 6
  }
}
