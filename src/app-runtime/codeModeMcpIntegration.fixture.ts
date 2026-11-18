import { mock } from 'bun:test'
import { writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
const root = process.env.CODE_MODE_TEST_ROOT!
if (!root || process.env.HOME !== root || process.cwd() !== join(root, 'workspace')) throw new Error('Isolated fixture required')
globalThis.fetch = (() => { throw new Error('Network forbidden') }) as unknown as typeof fetch
;(globalThis as any).MACRO = { VERSION: 'code-mode-mcp-test' }
const hooked = process.env.CODE_MODE_MCP_HOOK === '1'
const generationTest = process.env.CODE_MODE_MCP_GENERATION === '1'
const principalTest = process.env.CODE_MODE_MCP_PRINCIPAL === '1'
const latePrincipalTest = process.env.CODE_MODE_MCP_LATE_PRINCIPAL === '1'
if (hooked) await writeFile(join(root, 'config', 'settings.json'), JSON.stringify({ hooks: { PostToolUse: [{
  matcher: 'mcp__fixture__.*', hooks: [{ type: 'command', command: `printf '%s' '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedMCPToolOutput: [{ type: 'text', text: 'EFFECTIVE_SELECTED_MARKER' }] } })}'` }],
}] } }))
let script = generationTest ? `var reviewed = await tools.discover({op:"describe",name:"mcp__fixture__records"}); await tools.call({name:"mcp__fixture__save",input:{key:"sample"}}); var replacement = await tools.call({name:"mcp__fixture__records",input:{key:"sample"}}); output({reviewed,replacement});` : `var search = await tools.discover({op:"search",query:"mcp__fixture",max:10});
var descriptionSearch = await tools.discover({op:"search",query:"integration",max:1});
var schema = await tools.discover({op:"describe",name:"mcp__fixture__records"});
var record = await tools.call({name:"mcp__fixture__records",input:{key:"sample"}});
var saved = await tools.call({name:"mcp__fixture__save",input:{key:"sample"}});
var rejected = []; for (var name of ["mcp__fixture__unknown","records","mcp__revoked__records"]) { try { await tools.call({name:name,input:{key:"sample"}}); rejected.push(false); } catch(e) { rejected.push(true); } }
output({search,descriptionSearch,schema,record,saved,rejected});`
if (latePrincipalTest) script = `await tools.call({name:"mcp__fixture__save",input:{key:"sample"}});
var reviewed = await tools.discover({op:"describe",name:"mcp__fixture__records"});
if (reviewed.schemaComplete) output("first principal discovered");
await tools.call({name:"mcp__fixture__save",input:{key:"sample"}});
await tools.call({name:"mcp__fixture__records",input:{key:"sample"}});`
if (principalTest) script = script.replaceAll('mcp__fixture__', 'mcp__fixture_a__')
let requests = 0
const modelBodies: unknown[] = []
mock.module('../services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  resolveCodexOAuthTokensForLeaseOwner: async () => { throw new Error('OAuth forbidden') },
  getAnthropicClient: async () => ({ beta: { messages: { create: (body: unknown) => {
    modelBodies.push(JSON.parse(JSON.stringify(body)))
    const index = requests++
    if (index > 3) throw new Error('Unexpected model request')
    const invocation = index === 0 || (!generationTest && index === 2)
    const cellScript = index === 0 ? script : `var revoked = []; for (var name of ["mcp__fixture__records","records"]) { try { await tools.call({name:name,input:{key:"sample"}}); revoked.push(false); } catch(e) { revoked.push(true); } } output({revoked});`
    const stream = Object.assign((async function* () {
      yield { type: 'message_start', message: { id: `response-${index}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } }
      yield { type: 'content_block_start', index: 0, content_block: invocation ? { type: 'tool_use', id: `mcp-cell-${index}`, name: 'REPL', input: {} } : { type: 'text', text: '' } }
      yield { type: 'content_block_delta', index: 0, delta: invocation ? { type: 'input_json_delta', partial_json: JSON.stringify({ code: cellScript, description: 'Exercise isolated MCP integration' }) } : { type: 'text_delta', text: 'Finished.' } }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_delta', delta: { stop_reason: invocation ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }
      yield { type: 'message_stop' }
    })(), { controller: new AbortController() })
    return { withResponse: async () => ({ data: stream, request_id: `request-${index}`, response: new Response('', { status: 200 }) }) }
  } } } }),
}))
const { enableConfigs } = await import('../utils/config.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')
const { createQueryEngineSessionController } = await import('./createQueryEngineSessionController.js')
const { REPLTool } = await import('../tools/REPLTool/REPLTool.js')
const { connectToServer, fetchToolsForClient } = await import('../services/mcp/client.js')
const { normalizeMessagesForAPI } = await import('../utils/messages.js')
const { assembleToolPool } = await import('../tools.js')
const { buildMcpPermissionRuleName } = await import('../services/mcp/mcpStringUtils.js')
enableConfigs()
const serverConfig = { type: 'stdio' as const, command: process.execPath, args: [new URL('./codeModeMcpLocalServer.fixture.ts', import.meta.url).pathname], scope: 'local' as const, env: { CODE_MODE_TEST_ROOT: root, HOME: root, CODE_MODE_MCP_GENERATION: generationTest ? '1' : '0', CODE_MODE_MCP_NARROW: process.env.CODE_MODE_MCP_NARROW ?? '0' } }
const client = await connectToServer(principalTest ? 'fixture.a' : 'fixture', {
  ...serverConfig, env: { ...serverConfig.env, CODE_MODE_MCP_SERVER_PRINCIPAL: principalTest ? 'fixture.a' : 'fixture' },
})
if (client.type !== 'connected') throw new Error(`MCP connection failed: ${JSON.stringify(client)}`)
let replacementClient: typeof client | undefined
const tools = await fetchToolsForClient(client)
// Fetch the replacement generation before the cell starts so the transcript
// callback publishes it synchronously, before the next dispatch can race it.
let preparedReplacement = tools
if (generationTest) {
  await writeFile(join(root, 'schema-refreshed'), '2')
  if (principalTest) {
    const connected = await connectToServer('fixture_a', {
      ...serverConfig, env: { ...serverConfig.env, CODE_MODE_MCP_SERVER_PRINCIPAL: 'fixture_a' },
    })
    if (connected.type !== 'connected') throw new Error('Replacement local MCP failed')
    replacementClient = connected
  }
  fetchToolsForClient.cache.delete((replacementClient ?? client).name)
  preparedReplacement = await fetchToolsForClient(replacementClient ?? client)
  await unlink(join(root, 'schema-refreshed'))
}
let state = getDefaultAppState()
state = { ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: 'default', alwaysAllowRules: { session: principalTest
  ? ['REPL', buildMcpPermissionRuleName('fixture.a', 'records'), buildMcpPermissionRuleName('fixture.a', 'save'),
    ...(latePrincipalTest ? [buildMcpPermissionRuleName('fixture_a', 'records')] : [])]
  : ['REPL', 'mcp__fixture__*'] } } }
let transcript: any[] = []
const saves = tools.filter(tool => tool.mcpInfo?.toolName === 'save')
let currentPool = assembleToolPool(state.toolPermissionContext, latePrincipalTest ? saves : tools, [REPLTool])
let publishedFirstPrincipal = false
let refreshed = false
let refreshedSchema: unknown
let refreshedPrincipal: unknown
const session = createQueryEngineAppSession({
  cwd: process.cwd(), tools: [REPLTool], commands: [], mcpClients: [client], agents: [],
  getMcpRuntimeSnapshot: () => ({
    clients: latePrincipalTest ? [client, ...(refreshed && replacementClient ? [replacementClient] : [])] : [replacementClient ?? client],
    tools: currentPool.filter(tool => tool.isMcp), commands: [], resources: {},
  }),
  getAppState: () => state, setAppState: update => { state = update(state) },
  readFileCache: createFileStateCacheWithSizeLimit(20), customSystemPrompt: 'Run the synthetic integration script.', userSpecifiedModel: 'claude-sonnet-4-5',
  recordTranscript: async messages => {
    transcript = JSON.parse(JSON.stringify(messages))
    const childResults = messages.filter(message =>
      message.type === 'user' && message.codeMode && Array.isArray(message.message.content) &&
      message.message.content.some(block => block.type === 'tool_result')).length
    if (latePrincipalTest && !publishedFirstPrincipal && childResults === 1) {
      publishedFirstPrincipal = true
      currentPool = assembleToolPool(state.toolPermissionContext, tools, [REPLTool])
    }
    if (generationTest && !refreshed && childResults >= (latePrincipalTest ? 2 : 1)) {
      refreshed = true
      const replacementTools = preparedReplacement
      refreshedSchema = replacementTools.find(tool => tool.mcpInfo?.toolName === 'records')?.inputJSONSchema
      refreshedPrincipal = replacementTools.find(tool => tool.mcpInfo?.toolName === 'records')?.mcpInfo
      const assembled = assembleToolPool(state.toolPermissionContext, latePrincipalTest
        ? [...saves, ...replacementTools.filter(tool => tool.mcpInfo?.toolName === 'records')] : replacementTools, [REPLTool])
      currentPool = assembled
    }
    return null
  },
})
const controller = createQueryEngineSessionController(session)
const permissions: unknown[] = []
controller.subscribe(event => {
  if (event.type === 'permission.requested') { permissions.push(event.request); controller.respondToPermissionRequest(event.request.requestId, { behavior: 'deny', message: 'Unexpected permission request in isolated fixture' }) }
})
try {
  await controller.submit('Run MCP integration.')
  if (!generationTest) {
    currentPool = [REPLTool]
    await controller.submit('Inspect the selected result without replaying the script.')
  }
  const restoredProjection = normalizeMessagesForAPI(JSON.parse(JSON.stringify(transcript)))
  await writeFile(join(root, 'evidence.json'), JSON.stringify({ transcript, modelBodies, permissions, restoredProjection, refreshed, refreshedSchema, refreshedPrincipal, tools: tools.map(tool => ({ name: tool.name, aliases: tool.aliases, mcpInfo: tool.mcpInfo })) }))
} finally { session.dispose?.(); await client.cleanup(); await replacementClient?.cleanup() }
