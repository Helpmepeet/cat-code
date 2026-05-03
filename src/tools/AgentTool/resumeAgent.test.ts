import { describe, expect, mock, test } from 'bun:test'

const runAsyncAgentLifecycle = mock(async () => {})

await mock.module('../../bootstrap/state.js', () => ({
  getSdkAgentProgressSummariesEnabled: () => false,
  getSessionId: () => 'session-resume',
}))

await mock.module('../../agent-mode/agentMode.js', () => ({
  getCurrentSessionMode: () => 'agent',
}))

await mock.module('../../constants/prompts.js', () => ({
  getSystemPrompt: async () => undefined,
}))

await mock.module('../../coordinator/coordinatorMode.js', () => ({
  isCoordinatorMode: () => false,
}))

await mock.module('../../tasks/LocalAgentTask/LocalAgentTask.js', () => ({
  registerAsyncAgent: () => ({
    agentId: 'agent-resume',
    abortController: new AbortController(),
  }),
}))

await mock.module('../../tools.js', () => ({
  assembleToolPool: () => [],
}))

await mock.module('../../utils/agentContext.js', () => ({
  runWithAgentContext: (_context: unknown, fn: () => unknown) => fn(),
}))

await mock.module('../../utils/cwd.js', () => ({
  runWithCwdOverride: (_cwd: string, fn: () => unknown) => fn(),
}))

await mock.module('../../utils/debug.js', () => ({
  logForDebugging: () => {},
}))

await mock.module('../../utils/sessionStorage.js', () => ({
  getAgentTranscript: async () => ({
    messages: [],
    contentReplacements: [],
  }),
  getAgentTranscriptForSession: async () => ({
    messages: [],
    contentReplacements: [],
  }),
  getTranscriptPath: () => '/tmp/session-resume.jsonl',
  readAgentMetadata: async () => ({
    description: 'Continue current objective',
  }),
  readAgentMetadataForSession: async () => ({
    description: 'Continue current objective',
  }),
}))

await mock.module('../../utils/systemPrompt.js', () => ({
  buildEffectiveSystemPrompt: () => undefined,
}))

await mock.module('../../utils/task/diskOutput.js', () => ({
  getTaskOutputPath: (agentId: string) => `/tmp/${agentId}.txt`,
}))

await mock.module('../../utils/teammate.js', () => ({
  getParentSessionId: () => 'parent-session',
}))

await mock.module('../../utils/toolResultStorage.js', () => ({
  reconstructForSubagentResume: () => ({}),
}))

await mock.module('./agentToolUtils.js', () => ({
  runAsyncAgentLifecycle,
}))

await mock.module('./forkSubagent.js', () => ({
  FORK_AGENT: { agentType: 'fork' },
  isForkSubagentEnabled: () => false,
}))

await mock.module('./runAgent.js', () => ({
  runAgent: async function* () {},
}))

const { resumeAgentBackground } = await import('./resumeAgent.js')

describe('resumeAgentBackground', () => {
  test('passes Agent Mode session state tracking into the async lifecycle', async () => {
    await resumeAgentBackground({
      agentId: 'agent-resume',
      prompt: 'continue',
      canUseTool: (() => undefined) as never,
      toolUseContext: {
        toolUseId: 'toolu-resume',
        contentReplacementState: {},
        renderedSystemPrompt: undefined,
        setAppState: () => {},
        getAppState: () => ({
          toolPermissionContext: {
            mode: 'acceptEdits',
            additionalWorkingDirectories: new Map(),
          },
          mcp: { tools: [] },
          tasks: {},
          agent: undefined,
          agentDefinitions: { activeAgents: [] },
        }),
        options: {
          agentDefinitions: { activeAgents: [] },
          tools: [],
          mcpClients: [],
          mainLoopModel: 'gpt-5.3-codex',
          customSystemPrompt: undefined,
          appendSystemPrompt: undefined,
        },
      } as never,
    })

    expect(runAsyncAgentLifecycle).toHaveBeenCalledTimes(1)
    expect(runAsyncAgentLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: 'session-resume',
        sessionStateTracking: expect.objectContaining({
          sessionId: 'session-resume',
          mode: 'agent',
          objective: 'Continue current objective',
        }),
      }),
    )
  })
})
