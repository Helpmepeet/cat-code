import { mock } from 'bun:test'
import { join } from 'node:path'
import type { ToolUseContext } from '../Tool.js'
import type { PeerHostRequester } from '../../app/sidecar/peerHostRequester.js'
import { YOLO_CLASSIFIER_TOOL_NAME } from '../utils/permissions/classifierShared.js'

const root = process.env.BROWSER_PERMISSIONS_TEST_ROOT!
if (!root || process.env.HOME !== root || process.cwd() !== join(root, 'workspace')) throw new Error('Isolated environment required')
globalThis.fetch = (() => { throw new Error('Network forbidden in browser permission fixture') }) as unknown as typeof fetch
;(globalThis as unknown as { MACRO: unknown }).MACRO = { VERSION: 'browser-permissions-test' }
const bodies: string[] = []
mock.module('../services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  resolveCodexOAuthTokensForLeaseOwner: async () => { throw new Error('OAuth forbidden') },
  getAnthropicClient: async () => ({ beta: { messages: { create: (body: Record<string, unknown>) => {
    const choice = body.tool_choice as { name?: string } | undefined
    if (choice?.name !== YOLO_CLASSIFIER_TOOL_NAME) throw new Error('Only classifier requests are permitted')
    bodies.push(JSON.stringify(body.messages))
    return Promise.resolve({ id: 'classifier-response', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
      content: [{ type: 'tool_use', id: 'verdict', name: choice.name, input: { thinking: 'Fixture', shouldBlock: true, reason: 'Fixture blocks action' } }],
      stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 12 } })
  } } } }),
}))
const { getTools } = await import('../tools.js')
const { getEmptyToolPermissionContext } = await import('../Tool.js')
const { createAppRuntimeCanUseTool } = await import('./appRuntimeCanUseTool.js')
const { createAssistantMessage } = await import('../utils/messages.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { enableConfigs } = await import('../utils/config.js')
const { createBrowserTools } = await import('../../app/sidecar/browserTools.js')
const { resolveAgentTools } = await import('../tools/AgentTool/agentToolUtils.js')
enableConfigs()
const descriptions = ['navigate to localhost:3000/settings', 'read page on localhost:3000', 'screenshot page on localhost:3000', 'click button Save changes on localhost:3000']
let current = ''
let dispatches = 0
const request = (async (verb) => {
  if (verb !== 'browser.describe') { dispatches++; throw new Error('A denied tool must not dispatch') }
  return { ok: true, value: { description: current, url: 'http://localhost:3000/settings' } }
}) as PeerHostRequester
const tools = createBrowserTools(request)
const inputs = [{ action: 'navigate', target: 'http://localhost:3000/settings' }, {}, {}, { action: 'click', ref: 'g1-e12' }]
const results = []
for (const [i, tool] of tools.entries()) {
  current = descriptions[i]!
  let state = getDefaultAppState()
  state = { ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: 'auto' } }
  const context = { abortController: new AbortController(), getAppState: () => state,
    setAppState: (update: Parameters<ToolUseContext['setAppState']>[0]) => { state = update(state) },
    messages: [], options: { tools }, toolUseId: `browser-${i}` } as unknown as ToolUseContext
  const canUse = createAppRuntimeCanUseTool({ getPermissionRequestHandler: () => async () => ({ behavior: 'deny', message: 'Fixture declined' }) })
  const before = bodies.length
  const decision = await canUse(tool, inputs[i]!, context, createAssistantMessage({ content: 'Use the session browser.' }), `browser-${i}`)
  results.push({ name: tool.name, decision: decision.behavior, description: current, bodies: bodies.slice(before) })
}
const workerTools = resolveAgentTools({ tools: ['*'], disallowedTools: [], source: 'built-in', permissionMode: 'default' },
  [...getTools(getEmptyToolPermissionContext()), ...tools], false).resolvedTools.map(tool => tool.name)
console.log(JSON.stringify({ results, dispatches, workerTools }))
