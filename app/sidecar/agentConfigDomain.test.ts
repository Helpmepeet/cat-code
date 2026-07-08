import { expect, test } from 'bun:test'
import type { AgentDefinition } from '../../src/tools/AgentTool/loadAgentsDir.js'
import type { AgentDefinitionsResult } from '../../src/tools/AgentTool/loadAgentsDir.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import type { AgentConfigSnapshotFrame } from '../shared/protocol.js'
import { buildAgentConfigSnapshot } from './agentConfigDomain.js'

function customAgent(
  fields: Partial<AgentDefinition> & Pick<AgentDefinition, 'agentType' | 'source'>,
): AgentDefinition {
  const { agentType, source, whenToUse, ...rest } = fields
  return {
    ...rest,
    agentType,
    whenToUse: whenToUse ?? `Use ${agentType}`,
    source,
    getSystemPrompt: () => 'prompt body that stays engine-side',
  } as AgentDefinition
}

test('builds active, overridden, and MCP availability from the real resolved agent lists', () => {
  const builtIn = customAgent({
    agentType: 'reviewer',
    source: 'built-in',
    tools: ['Read'],
    model: 'inherit',
  })
  const project = customAgent({
    agentType: 'reviewer',
    source: 'projectSettings',
    filename: 'reviewer',
    baseDir: '/repo/.cat-code/agents',
    tools: ['Read', 'Grep'],
    requiredMcpServers: ['linear'],
  })
  const missing = customAgent({
    agentType: 'ticket-agent',
    source: 'userSettings',
    requiredMcpServers: ['jira'],
  })

  const snapshot = buildAgentConfigSnapshot({
    result: {
      allAgents: [builtIn, project, missing],
      activeAgents: [project, missing],
    } satisfies AgentDefinitionsResult,
    availableMcpServers: ['linear-prod'],
  })

  const byType = new Map(snapshot.definitions.map(definition => [definition.id, definition]))
  const projectReviewer = snapshot.definitions.find(
    definition => definition.agentType === 'reviewer' && definition.source === 'projectSettings',
  )
  const builtInReviewer = snapshot.definitions.find(
    definition => definition.agentType === 'reviewer' && definition.source === 'built-in',
  )
  const ticketAgent = snapshot.definitions.find(definition => definition.agentType === 'ticket-agent')

  expect(projectReviewer).toMatchObject({ active: true, available: true })
  expect(projectReviewer).toMatchObject({
    editable: false,
    readOnlyReason: 'P4-7 exposes a read-only snapshot; desktop editing waits for a full-fidelity writer.',
  })
  expect(projectReviewer?.tools).toEqual({ mode: 'list', names: ['Grep', 'Read'] })
  expect(projectReviewer?.filePath).toBe('/repo/.cat-code/agents/reviewer.md')
  expect(builtInReviewer).toMatchObject({ active: false, overriddenBy: 'projectSettings' })
  expect(ticketAgent).toMatchObject({ active: true, available: false, missingMcpServers: ['jira'] })
  expect(byType.size).toBe(snapshot.definitions.length)
})

test('does not expose prompt bodies, hook payloads, or inline MCP config objects', () => {
  const agent = customAgent({
    agentType: 'secure-agent',
    source: 'userSettings',
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo sk-live-HOOK' }] }] },
    mcpServers: [
      'safe-ref',
      {
        privateServer: {
          type: 'stdio',
          command: 'env',
          env: { API_KEY: 'sk-live-MCP' },
        },
      },
    ] as never,
  })

  const snapshot = buildAgentConfigSnapshot({
    result: { allAgents: [agent], activeAgents: [agent] } satisfies AgentDefinitionsResult,
    availableMcpServers: [],
  })
  const definition = snapshot.definitions[0]!

  expect(definition.systemPrompt).toEqual({
    available: true,
    withheldReason: 'secret-boundary',
  })
  expect(definition.hasHooks).toBe(true)
  expect(definition.hasMcpServers).toBe(true)
  expect(definition.mcpServerRefs).toEqual(['safe-ref'])
  expect(definition.inlineMcpServerNames).toEqual(['privateServer'])

  const frame: AgentConfigSnapshotFrame = {
    kind: 'agent-config.snapshot',
    protocolVersion: 1,
    sessionId: 'sess-1',
    agents: snapshot,
  }
  const serialized = JSON.stringify(frame)
  expect(serialized).not.toContain('sk-live')
  expect(serialized).not.toContain('API_KEY')
  expect(scanForSecrets(frame).ok).toBe(true)
})
