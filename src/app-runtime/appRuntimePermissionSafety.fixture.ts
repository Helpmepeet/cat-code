import { mock } from 'bun:test'
import { join } from 'node:path'
import type { ToolPermissionContext, ToolUseContext } from '../Tool.js'
import type { AppPermissionRequest } from './sessionEvents.js'
import { YOLO_CLASSIFIER_TOOL_NAME } from '../utils/permissions/classifierShared.js'

const root = process.env.PERMISSION_SAFETY_TEST_ROOT!
if (!root || process.env.HOME !== root || process.cwd() !== join(root, 'workspace')) {
  throw new Error('Isolated environment required')
}

globalThis.fetch = (() => {
  throw new Error('Network forbidden in permission safety fixture')
}) as unknown as typeof fetch
;(globalThis as unknown as { MACRO: unknown }).MACRO = { VERSION: 'permission-safety-test' }
let classifierRequests = 0
// Only the API response is replaced: tool checks, rule evaluation, Auto routing,
// classifier adjudication, and the app permission handoff all run normally.
mock.module('../services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  resolveCodexOAuthTokensForLeaseOwner: async () => { throw new Error('OAuth forbidden') },
  getAnthropicClient: async () => ({
    beta: { messages: { create: (body: Record<string, unknown>) => {
      const choice = body.tool_choice as { name?: string } | undefined
      if (choice?.name !== YOLO_CLASSIFIER_TOOL_NAME) {
        throw new Error('Only classifier requests are permitted')
      }
      classifierRequests++
      return Promise.resolve({
        id: 'classifier-response', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
        content: [{ type: 'tool_use', id: 'classifier-verdict', name: choice.name,
          input: { thinking: 'Isolated approval verdict', shouldBlock: false, reason: 'Fixture allows action' } }],
        stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 12 },
      })
    } } },
  }),
}))

const { createAppRuntimeCanUseTool } = await import('./appRuntimeCanUseTool.js')
const { checkRuleBasedPermissions } = await import('../utils/permissions/permissions.js')
const { FileWriteTool } = await import('../tools/FileWriteTool/FileWriteTool.js')
const { createAssistantMessage } = await import('../utils/messages.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { enableConfigs } = await import('../utils/config.js')
enableConfigs()

const scenarios: Array<{
  name: string
  path: string
  overrides?: Partial<ToolPermissionContext>
}> = [
  { name: 'manual safety', path: join(process.cwd(), 'GIT~1/config') },
  { name: 'headless safety', path: join(process.cwd(), 'GIT~1/config'),
    overrides: { shouldAvoidPermissionPrompts: true } },
  { name: 'classifier safety', path: join(process.cwd(), '.git/config') },
  { name: 'ordinary ask', path: join(root, 'outside.txt') },
  { name: 'content deny', path: join(process.cwd(), 'GIT~1/config'),
    overrides: { alwaysDenyRules: { session: ['Edit(./GIT~1/**)'] } } },
  { name: 'tool deny', path: join(process.cwd(), 'GIT~1/config'),
    overrides: { alwaysDenyRules: { session: ['Write'] } } },
]

const results = []
for (const scenario of scenarios) {
  let state = getDefaultAppState()
  state = {
    ...state,
    toolPermissionContext: {
      ...state.toolPermissionContext,
      mode: 'auto',
      alwaysAskRules: { session: ['Write'] },
      ...scenario.overrides,
    },
  }
  const context = {
    abortController: new AbortController(),
    getAppState: () => state,
    setAppState: (update: Parameters<ToolUseContext['setAppState']>[0]) => {
      state = update(state)
    },
    messages: [],
    options: { tools: [FileWriteTool] },
  } as unknown as ToolUseContext
  const input = { file_path: scenario.path, content: 'fixture content' }
  const toolDecision = await FileWriteTool.checkPermissions(input, context)
  const ruleDecision = await checkRuleBasedPermissions(FileWriteTool, input, context)
  const requests: AppPermissionRequest[] = []
  const before = classifierRequests
  const canUseTool = createAppRuntimeCanUseTool({
    getPermissionRequestHandler: () => async request => {
      requests.push(request)
      return { behavior: 'deny', message: 'User declined fixture approval' }
    },
  })
  const decision = await canUseTool(
    FileWriteTool,
    input,
    context,
    createAssistantMessage({ content: 'Write the fixture file.' }),
    `permission-safety-${scenario.name}`,
  )
  results.push({
    name: scenario.name, toolDecision, ruleDecision, decision, requests,
    classifierRequests: classifierRequests - before,
  })
}
console.log(JSON.stringify(results))
