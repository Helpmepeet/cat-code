import { expect, test } from 'bun:test'
import type {
  AgentModeWorkerSessionStatus,
  AgentModeWorkerSynthesisStatus,
} from '../../src/agent-mode/sessionState.js'
import type { TaskStatus } from '../../src/Task.js'
import { BashTool } from '../../src/tools/BashTool/BashTool.js'
import { getToolUseSummary as getReadToolUseSummary } from '../../src/tools/FileReadTool/UI.js'
import { getToolUseSummary as getEditToolUseSummary } from '../../src/tools/FileEditTool/UI.js'
import { getToolUseSummary as getGrepToolUseSummary } from '../../src/tools/GrepTool/UI.js'
import { getToolUseSummary as getWebFetchToolUseSummary } from '../../src/tools/WebFetchTool/UI.js'
import { getToolUseSummary as getWebSearchToolUseSummary } from '../../src/tools/WebSearchTool/UI.js'
import { GenerateImageTool } from '../../src/tools/GenerateImageTool/GenerateImageTool.js'
import type { SettingSource } from '../../src/utils/settings/constants.js'
import {
  getActiveAgentsFromList,
  type AgentDefinition,
} from '../../src/tools/AgentTool/loadAgentsDir.js'
import type { AgentDefinitionsResult } from '../../src/tools/AgentTool/loadAgentsDir.js'
import { AGENT_CONFIG_SOURCE_ORDER } from '../renderer/src/agentConfigState.js'
import {
  deriveAgentModeWorkerState,
  deriveTaskAgentState,
} from '../renderer/src/agentIdentity.js'
import { describeToolForInspector } from '../renderer/src/toolInspectorModel.js'
import type { ToolUseRow } from '../renderer/src/transcriptProjector.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import type {
  AgentConfigSnapshotFrame,
  AgentConfigSourceId,
} from '../shared/protocol.js'
import { buildAgentConfigSnapshot } from './agentConfigDomain.js'

type AssertAssignable<T extends true> = T
type EngineAgentSource = AgentDefinition['source']
type ProtocolCoversEngineAgentSources = AssertAssignable<
  Exclude<EngineAgentSource, AgentConfigSourceId> extends never ? true : false
>
type EngineCoversProtocolAgentSources = AssertAssignable<
  Exclude<AgentConfigSourceId, EngineAgentSource> extends never ? true : false
>
type SettingsBackedAgentSourcesStillUseSettingSource = AssertAssignable<
  Exclude<SettingSource, EngineAgentSource> extends never ? true : false
>
const ENGINE_TASK_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'killed',
] as const satisfies readonly TaskStatus[]
const ENGINE_WORKER_STATUSES = [
  'running',
  'completed',
  'failed',
  'killed',
] as const satisfies readonly AgentModeWorkerSessionStatus[]
const ENGINE_WORKER_SYNTHESIS_STATUSES = [
  'pending',
  'synthesized',
] as const satisfies readonly AgentModeWorkerSynthesisStatus[]
type TaskStatusesCovered = AssertAssignable<
  Exclude<TaskStatus, (typeof ENGINE_TASK_STATUSES)[number]> extends never ? true : false
>
type WorkerStatusesCovered = AssertAssignable<
  Exclude<AgentModeWorkerSessionStatus, (typeof ENGINE_WORKER_STATUSES)[number]> extends never
    ? true
    : false
>
type WorkerSynthesisStatusesCovered = AssertAssignable<
  Exclude<
    AgentModeWorkerSynthesisStatus,
    (typeof ENGINE_WORKER_SYNTHESIS_STATUSES)[number]
  > extends never
    ? true
    : false
>
void (null as unknown as ProtocolCoversEngineAgentSources)
void (null as unknown as EngineCoversProtocolAgentSources)
void (null as unknown as SettingsBackedAgentSourcesStillUseSettingSource)
void (null as unknown as TaskStatusesCovered)
void (null as unknown as WorkerStatusesCovered)
void (null as unknown as WorkerSynthesisStatusesCovered)

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

function mkToolRow(toolName: string, input: Record<string, unknown>): ToolUseRow {
  return {
    id: `s:m:0:${toolName}`,
    sessionId: 's',
    frameId: 'f',
    messageId: 'm',
    blockIndex: 0,
    parentToolUseId: null,
    kind: 'tool-use',
    toolUseId: `toolu_${toolName}`,
    toolName,
    toolFamily: 'other',
    agentCompletion: null,
    input,
    status: 'pending',
    result: null,
  }
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

test('agent source taxonomy and active override precedence stay synced with the engine', () => {
  // AgentDefinition.source: src/tools/AgentTool/loadAgentsDir.ts:136-165.
  expect(AGENT_CONFIG_SOURCE_ORDER).toEqual([
    'policySettings',
    'flagSettings',
    'localSettings',
    'projectSettings',
    'userSettings',
    'plugin',
    'built-in',
  ])

  // Active precedence: src/tools/AgentTool/loadAgentsDir.ts:193-220.
  const competingSources: EngineAgentSource[] = [
    'built-in',
    'plugin',
    'userSettings',
    'projectSettings',
    'flagSettings',
    'policySettings',
  ]
  const allAgents = competingSources.map(source =>
    customAgent({ agentType: 'reviewer', source }),
  )
  const active = getActiveAgentsFromList(allAgents)
  expect(active).toHaveLength(1)
  expect(active[0]!.source).toBe('policySettings')

  const snapshot = buildAgentConfigSnapshot({
    result: { allAgents, activeAgents: active } satisfies AgentDefinitionsResult,
    availableMcpServers: [],
  })
  expect(snapshot.definitions.map(definition => definition.source)).toEqual([
    'policySettings',
    'flagSettings',
    'projectSettings',
    'userSettings',
    'plugin',
    'built-in',
  ])
  expect(
    snapshot.definitions.find(definition => definition.source === 'policySettings'),
  ).toMatchObject({
    active: true,
    available: true,
  })
  expect(
    snapshot.definitions.find(definition => definition.source === 'built-in'),
  ).toMatchObject({
    active: false,
    overriddenBy: 'policySettings',
  })
})

test('a duplicate agent name inside one source never marks the losing definition active', () => {
  // Every directory from cwd up to home is tagged projectSettings
  // (src/utils/markdownConfigLoader.ts), so one agent name can collide inside one source.
  // getActiveAgentsFromList keeps the LAST collision (loadAgentsDir.ts) while
  // resolveAgentOverrides keeps the FIRST (agentDisplay.ts), so the engine's real winner
  // is absent from the resolved list entirely.
  const parentDir = customAgent({
    agentType: 'reviewer',
    source: 'projectSettings',
    filename: 'reviewer',
    baseDir: '/home/pt/work/.cat-code/agents',
    tools: ['Read'],
    model: 'inherit',
  })
  const repoDir = customAgent({
    agentType: 'reviewer',
    source: 'projectSettings',
    filename: 'reviewer',
    baseDir: '/home/pt/work/repo/.cat-code/agents',
    tools: ['Read', 'Grep'],
    model: 'opus',
  })

  const allAgents = [parentDir, repoDir]
  const active = getActiveAgentsFromList(allAgents)
  expect(active).toHaveLength(1)
  expect(active[0]!.baseDir).toBe('/home/pt/work/repo/.cat-code/agents')

  const snapshot = buildAgentConfigSnapshot({
    result: { allAgents, activeAgents: active } satisfies AgentDefinitionsResult,
    availableMcpServers: [],
  })

  const reviewers = snapshot.definitions.filter(
    definition => definition.agentType === 'reviewer',
  )
  expect(reviewers).toHaveLength(1)
  expect(reviewers[0]!.filePath).toBe('/home/pt/work/.cat-code/agents/reviewer.md')
  expect(reviewers[0]!.tools).toEqual({ mode: 'list', names: ['Read'] })
  // The engine will run the other file, so the surviving row must not claim to be active.
  expect(reviewers[0]).toMatchObject({ active: false, available: false })
  expect(snapshot.definitions.some(definition => definition.active)).toBe(false)
})

test('agent display state covers every engine task and durable worker status', () => {
  // TaskStatus: src/Task.ts:15-20.
  expect(ENGINE_TASK_STATUSES.map(status =>
    deriveTaskAgentState({
      type: 'local_agent',
      id: `task-${status}`,
      status,
      description: status,
      agentType: 'general-purpose',
      isBackgrounded: false,
    }),
  )).toEqual(['running', 'running', 'completed', 'failed', 'stopped'])

  // AgentModeWorkerSessionStatus/SynthesisStatus: src/agent-mode/sessionState.ts:18-24.
  expect(ENGINE_WORKER_STATUSES.map(status =>
    deriveAgentModeWorkerState({
      agentId: `worker-${status}`,
      role: 'agent-mode-coding-worker',
      description: status,
      status,
      worktreePath: null,
    }),
  )).toEqual(['running', 'completed', 'failed', 'stopped'])

  expect(ENGINE_WORKER_SYNTHESIS_STATUSES.map(synthesisStatus =>
    deriveAgentModeWorkerState({
      agentId: `worker-${synthesisStatus}`,
      role: 'agent-mode-coding-worker',
      description: synthesisStatus,
      status: 'completed',
      synthesisStatus,
      worktreePath: null,
    }),
  )).toEqual(['result-ready', 'reviewed'])
})

test('tool inspector summaries stay coupled to real engine tool summary functions', () => {
  const cases = [
    {
      toolName: 'Read',
      input: { file_path: '/repo/src/main.tsx' },
      expected: getReadToolUseSummary({ file_path: '/repo/src/main.tsx' }) ?? '',
    },
    {
      toolName: 'Edit',
      input: { file_path: '/repo/src/main.tsx', old_string: 'a', new_string: 'b' },
      expected: getEditToolUseSummary({
        file_path: '/repo/src/main.tsx',
        old_string: 'a',
        new_string: 'b',
      }) ?? '',
    },
    {
      toolName: 'Bash',
      input: { command: 'bun test app/sidecar/agentConfigDomain.test.ts' },
      expected: BashTool.getToolUseSummary?.({
        command: 'bun test app/sidecar/agentConfigDomain.test.ts',
      } as never) ?? '',
    },
    {
      toolName: 'Grep',
      input: { pattern: 'PermissionUpdate' },
      expected: getGrepToolUseSummary({ pattern: 'PermissionUpdate' }) ?? '',
    },
    {
      toolName: 'WebFetch',
      input: { url: 'https://example.invalid/spec' },
      expected: getWebFetchToolUseSummary({ url: 'https://example.invalid/spec' }) ?? '',
    },
    {
      toolName: 'WebSearch',
      input: { query: 'Cat Code migration' },
      expected: getWebSearchToolUseSummary({ query: 'Cat Code migration' }) ?? '',
    },
  ]

  for (const { toolName, input, expected } of cases) {
    expect(describeToolForInspector(mkToolRow(toolName, input)).summary).toBe(
      expected,
    )
  }
})

test('documents current GenerateImage summary drift against the real engine summary', () => {
  const input = {
    prompt: 'draw a cat',
    output_path: '/tmp/cat.png',
  }

  expect(describeToolForInspector(mkToolRow('GenerateImage', input)).summary).toBe('draw a cat')
  expect(GenerateImageTool.getToolUseSummary?.(input as never)).toBe('/tmp/cat.png')
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
