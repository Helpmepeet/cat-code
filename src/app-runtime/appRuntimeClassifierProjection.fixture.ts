import { mock } from 'bun:test'
import { join } from 'node:path'
import { z } from 'zod/v4'
import type { ToolUseContext } from '../Tool.js'
import { YOLO_CLASSIFIER_TOOL_NAME } from '../utils/permissions/classifierShared.js'

const root = process.env.CLASSIFIER_PROJECTION_TEST_ROOT!
if (!root || process.env.HOME !== root || process.cwd() !== join(root, 'workspace')) {
  throw new Error('Isolated environment required')
}

globalThis.fetch = (() => {
  throw new Error('Network forbidden in classifier projection fixture')
}) as unknown as typeof fetch
;(globalThis as unknown as { MACRO: unknown }).MACRO = { VERSION: 'classifier-projection-test' }
const classifierBodies: string[] = []
// Only the API response is replaced: tool checks, Auto routing, transcript
// encoding and the app permission handoff all run normally.
mock.module('../services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  resolveCodexOAuthTokensForLeaseOwner: async () => { throw new Error('OAuth forbidden') },
  getAnthropicClient: async () => ({
    beta: { messages: { create: (body: Record<string, unknown>) => {
      const choice = body.tool_choice as { name?: string } | undefined
      if (choice?.name !== YOLO_CLASSIFIER_TOOL_NAME) {
        throw new Error('Only classifier requests are permitted')
      }
      classifierBodies.push(JSON.stringify(body.messages))
      return Promise.resolve({
        id: 'classifier-response', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
        content: [{ type: 'tool_use', id: 'classifier-verdict', name: choice.name,
          input: { thinking: 'Isolated verdict', shouldBlock: true, reason: 'Fixture blocks action' } }],
        stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 12 },
      })
    } } },
  }),
}))

const { buildTool } = await import('../Tool.js')
const { createAppRuntimeCanUseTool } = await import('./appRuntimeCanUseTool.js')
const { createAssistantMessage } = await import('../utils/messages.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { enableConfigs } = await import('../utils/config.js')
enableConfigs()

type Mode = 'resolved' | 'empty' | 'throws'
let mode: Mode = 'resolved'
// What checkPermissions resolved for each call. A real tool would ask its host.
const resolved = new Map<string, string>()
let nextLabel = ''
const inputSchema = z.strictObject({ ref: z.string() })
const fixtureTool = buildTool({
  name: 'FixtureRefAction', maxResultSizeChars: 1000,
  userFacingName: () => 'FixtureRefAction', get inputSchema() { return inputSchema },
  isReadOnly: () => false, isConcurrencySafe: () => false,
  async description() { return 'Fixture action on an opaque ref' },
  async prompt() { return 'Fixture action on an opaque ref' },
  async checkPermissions(input, context) {
    if (context.toolUseId) resolved.set(context.toolUseId, `${nextLabel} (${input.ref})`)
    return { behavior: 'passthrough', message: 'Fixture action needs review' }
  },
  toAutoClassifierInput(input) { return `opaque ${input.ref}` },
  toAutoClassifierInputForUse(_input, toolUseID) {
    if (mode === 'throws') throw new Error('fixture projection failure')
    if (mode === 'empty') return ''
    return resolved.get(toolUseID)
  },
  async call() { return { data: 'done' } },
  mapToolResultToToolResultBlockParam(data, toolUseID) { return { type: 'tool_result', tool_use_id: toolUseID, content: String(data) } },
  renderToolUseMessage() { return null },
})

const scenarios: Array<{ name: string; mode: Mode; label: string; toolUseID: string }> = [
  { name: 'first resolved', mode: 'resolved', label: 'click button Delete project', toolUseID: 'projection-1' },
  { name: 'same input, second call', mode: 'resolved', label: 'click button Save draft', toolUseID: 'projection-2' },
  { name: 'empty projection', mode: 'empty', label: 'ignored', toolUseID: 'projection-3' },
  { name: 'throwing projection', mode: 'throws', label: 'ignored', toolUseID: 'projection-4' },
]

const results = []
for (const scenario of scenarios) {
  mode = scenario.mode
  nextLabel = scenario.label
  let state = getDefaultAppState()
  state = { ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: 'auto' } }
  const context = {
    abortController: new AbortController(),
    getAppState: () => state,
    setAppState: (update: Parameters<ToolUseContext['setAppState']>[0]) => { state = update(state) },
    messages: [],
    options: { tools: [fixtureTool] },
    toolUseId: scenario.toolUseID,
  } as unknown as ToolUseContext
  const before = classifierBodies.length
  const canUseTool = createAppRuntimeCanUseTool({
    getPermissionRequestHandler: () => async () => ({ behavior: 'deny', message: 'User declined fixture approval' }),
  })
  const decision = await canUseTool(
    fixtureTool, { ref: 'e12' }, context,
    createAssistantMessage({ content: 'Act on the fixture ref.' }),
    scenario.toolUseID,
  )
  results.push({ name: scenario.name, decision, bodies: classifierBodies.slice(before) })
}
console.log(JSON.stringify(results))
