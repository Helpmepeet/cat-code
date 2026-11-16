import { mock } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const root = process.env.CODE_MODE_TEST_ROOT!
if (!root || process.env.HOME !== root || process.cwd() !== join(root, 'workspace')) throw new Error('Isolated fixture required')
;(globalThis as any).MACRO = { VERSION: 'code-mode-auto-mcp-test' }
globalThis.fetch = (() => { throw new Error('Unexpected network transport') }) as unknown as typeof fetch
const code = `var reviewed = await tools.discover({op:"describe",name:"mcp__fixture_a__records"}); await tools.call({name:"mcp__fixture_a__save",input:{key:"sample"}}); var result = await tools.call({name:"mcp__fixture_a__records",input:{key:"sample"}}); output(result);`
const classifierBodies: any[] = []
const modelBodies: any[] = []
mock.module('../services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  resolveCodexOAuthTokensForLeaseOwner: async () => { throw new Error('OAuth forbidden') },
  getAnthropicClient: async () => ({ beta: { messages: { create: (body: any) => {
    if (!body.stream) {
      classifierBodies.push(JSON.parse(JSON.stringify(body)))
      return Promise.resolve({ id: 'classifier', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'tool_use', id: 'verdict', name: body.tool_choice.name,
          input: { shouldBlock: classifierBodies.length % 2 === 1, thinking: 'Offline second-stage admission', reason: 'Isolated local MCP integration script' } }],
        stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 10 } })
    }
    modelBodies.push(JSON.parse(JSON.stringify(body)))
    const index = modelBodies.length - 1
    if (index > 1) throw new Error('Unexpected model request')
    const invocation = index === 0
    const stream = Object.assign((async function* () {
      yield { type: 'message_start', message: { id: `response-${index}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } }
      yield { type: 'content_block_start', index: 0, content_block: invocation ? { type: 'tool_use', id: 'auto-mcp-script', name: 'REPL', input: {} } : { type: 'text', text: '' } }
      yield { type: 'content_block_delta', index: 0, delta: invocation ? { type: 'input_json_delta', partial_json: JSON.stringify({ code, description: 'Exercise Auto MCP principal admission' }) } : { type: 'text_delta', text: 'Finished.' } }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_delta', delta: { stop_reason: invocation ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }
      yield { type: 'message_stop' }
    })(), { controller: new AbortController() })
    return { withResponse: async () => ({ data: stream, request_id: `request-${index}`, response: new Response('') }) }
  } } } }),
}))
const { enableConfigs } = await import('../utils/config.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')
const { createQueryEngineSessionController } = await import('./createQueryEngineSessionController.js')
const { REPLTool } = await import('../tools/REPLTool/REPLTool.js')
const { connectToServer, fetchToolsForClient } = await import('../services/mcp/client.js')
const { assembleToolPool } = await import('../tools.js')
enableConfigs()
const config = { type: 'stdio' as const, command: process.execPath, args: [new URL('./codeModeMcpLocalServer.fixture.ts', import.meta.url).pathname], scope: 'local' as const }
const original = await connectToServer('fixture.a', { ...config, env: { HOME: root, CODE_MODE_TEST_ROOT: root, CODE_MODE_MCP_SERVER_PRINCIPAL: 'fixture.a' } })
const replacement = await connectToServer('fixture_a', { ...config, env: { HOME: root, CODE_MODE_TEST_ROOT: root, CODE_MODE_MCP_SERVER_PRINCIPAL: 'fixture_a' } })
if (original.type !== 'connected' || replacement.type !== 'connected') throw new Error('Local MCP connection failed')
try {
  const originalTools = await fetchToolsForClient(original)
  const replacementTools = await fetchToolsForClient(replacement)
  let state = getDefaultAppState()
  state = { ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: 'auto', alwaysAllowRules: {}, alwaysAskRules: {}, alwaysDenyRules: {} } }
  let currentTools = originalTools
  let refreshed = false
  let transcript: any[] = []
  const session = createQueryEngineAppSession({ cwd: process.cwd(), tools: [REPLTool], commands: [], mcpClients: [original], agents: [],
    getMcpRuntimeSnapshot: () => ({ clients: [refreshed ? replacement : original], tools: currentTools, commands: [], resources: {} }),
    getAppState: () => state, setAppState: update => { state = update(state) }, readFileCache: createFileStateCacheWithSizeLimit(20),
    customSystemPrompt: 'Run the isolated script.', userSpecifiedModel: 'claude-sonnet-4-5',
    recordTranscript: async messages => {
      transcript = JSON.parse(JSON.stringify(messages))
      if (!refreshed && messages.some(message => message.type === 'user' && message.codeMode && Array.isArray(message.message.content) && message.message.content.some(block => block.type === 'tool_result'))) {
        // Publish only after the old principal's trigger receipt, synchronously.
        currentTools = replacementTools
        refreshed = true
      }
      return null
    },
  })
  const controller = createQueryEngineSessionController(session)
  const permissions: unknown[] = []
  const reviews: unknown[] = []
  controller.subscribe(event => {
    if (event.type === 'tool.review') reviews.push(event)
    if (event.type === 'permission.requested') { permissions.push(event.request); controller.respondToPermissionRequest(event.request.requestId, { behavior: 'deny', message: 'Replacement requires explicit fresh authorization', decisionClassification: 'user_reject' }) }
  })
  try {
    await controller.submit('Run the isolated local MCP script.')
    await writeFile(join(root, 'evidence.json'), JSON.stringify({ transcript, classifierBodies, modelBodies, permissions, reviews, code, refreshed,
      originalPool: assembleToolPool(state.toolPermissionContext, originalTools, [REPLTool]).filter(tool => tool.isMcp).map(tool => ({ name: tool.name, mcpInfo: tool.mcpInfo })),
      replacementPool: assembleToolPool(state.toolPermissionContext, replacementTools, [REPLTool]).filter(tool => tool.isMcp).map(tool => ({ name: tool.name, mcpInfo: tool.mcpInfo })),
    }))
  } finally { session.dispose?.() }
} finally { await original.cleanup(); await replacement.cleanup() }
