import { afterEach, expect, mock, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  getSessionId,
  getSessionProjectDir,
  resetStateForTests,
  switchSession,
} from '../../bootstrap/state.js'
import { getDefaultAppState } from '../../state/AppState.js'
import { asSessionId } from '../../types/ids.js'
import type { McpRuntimeSnapshot, Tool, ToolUseContext } from '../../Tool.js'
import { createAssistantMessage } from '../../utils/messages.js'

const realForkSubagentModule = await import('./forkSubagent.js')
await mock.module('./forkSubagent.js', () => ({
  ...realForkSubagentModule,
  isForkSubagentEnabled: () => true,
}))
const { isForkSubagentEnabled } = await import('./forkSubagent.js')

const realRunAgentModule = await import('./runAgent.js')
let capturedRunAgentParams:
  | Parameters<typeof realRunAgentModule.runAgent>[0]
  | undefined
await mock.module('./runAgent.js', () => ({
  ...realRunAgentModule,
  runAgent: (params: Parameters<typeof realRunAgentModule.runAgent>[0]) => {
    capturedRunAgentParams = params
    return (async function* () {
      yield createAssistantMessage({ content: 'fixture complete' })
    })()
  },
}))

const { AgentTool } = await import('./AgentTool.js')

const originalSessionId = getSessionId()
const originalProjectDir = getSessionProjectDir()
let tempDir: string | undefined

afterEach(async () => {
  capturedRunAgentParams = undefined
  mock.restore()
  resetStateForTests()
  switchSession(asSessionId(originalSessionId), originalProjectDir)
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

test('passes coherent parent MCP inputs to a fresh fork', async () => {
  expect(isForkSubagentEnabled()).toBe(true)

  const parentTools = [{ name: 'parent-tool' }] as Tool[]
  const parentCommands = [{ name: 'parent-command' }]
  const parentClients = [{ name: 'parent-server', type: 'connected' }]
  const parentResources = {
    'parent-server': [{ uri: 'file://parent', name: 'parent' }],
  }
  const freshSnapshot = {
    tools: [{ name: 'new-tool' }],
    commands: [{ name: 'new-command' }],
    clients: [{ name: 'new-server', type: 'connected' }],
    resources: {},
  } as McpRuntimeSnapshot
  tempDir = mkdtempSync(join(tmpdir(), 'agent-fork-mcp-'))
  switchSession(asSessionId('session-fork-mcp'), tempDir)
  const appState = getDefaultAppState()
  const context = {
    toolUseId: 'fresh-fork-mcp',
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    options: {
      agentDefinitions: { allAgents: [], activeAgents: [] },
      commands: parentCommands,
      debug: false,
      mainLoopModel: 'claude-sonnet-4-5',
      tools: parentTools,
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: parentClients,
      mcpResources: parentResources,
      isNonInteractiveSession: false,
      getMcpRuntimeSnapshot: () => freshSnapshot,
    },
    messages: [],
    renderedSystemPrompt: ['parent prompt'],
  } as unknown as ToolUseContext

  await AgentTool.call(
    { prompt: 'continue the task', description: 'continue' },
    context,
    undefined as never,
    createAssistantMessage({ content: 'fork parent' }) as never,
  )
  for (
    let attempt = 0;
    attempt < 100 && !capturedRunAgentParams;
    attempt++
  ) {
    await Bun.sleep(1)
  }

  expect(capturedRunAgentParams?.useExactTools).toBe(true)
  expect(capturedRunAgentParams?.availableTools).toBe(parentTools)
  expect(capturedRunAgentParams?.mcpRuntimeSnapshot).toBeUndefined()
  expect(capturedRunAgentParams?.mcpRuntimeInputs).toEqual({
    tools: parentTools,
    commands: parentCommands,
    mcpClients: parentClients,
    mcpResources: parentResources,
  })
})
