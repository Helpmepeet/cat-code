import { mock } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SessionId } from '../types/ids.js'
const root = process.env.CODE_MODE_TEST_ROOT!
const phase = process.env.CODE_MODE_RESUME_PHASE!
if (!root || process.env.HOME !== root || process.cwd() !== join(root, 'workspace')) throw new Error('Isolated resume fixture required')
globalThis.fetch = (() => { throw new Error('Network forbidden') }) as unknown as typeof fetch
;(globalThis as any).MACRO = { VERSION: 'code-mode-resume-test' }
const bodies: any[] = []
mock.module('../services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  resolveCodexOAuthTokensForLeaseOwner: async () => { throw new Error('OAuth forbidden') },
  getAnthropicClient: async () => ({ beta: { messages: { create: (body: any) => {
    const index = bodies.length
    bodies.push(JSON.parse(JSON.stringify(body)))
    if (index > 1) throw new Error('Unexpected resume model request')
    const tool = index === 0 ? { name: 'REPL', input: {
      code: phase === 'crash' ? 'var retainedCrash = "must-reset"; await tools.call({name:"Bash",input:{command:"printf crash-child",work_lifetime:"finite",run_in_background:false}});' : phase === 'foreground'
        ? 'var retainedCrash = "must-reset"; await tools.call({name:"Bash",input:{command:"printf must-not-run",work_lifetime:"finite",run_in_background:false},nothrow:true}); output("foreground-seed");'
        : 'output({prior:typeof retainedCrash});',
      description: 'Isolated incarnation fixture', ...(phase === 'crash' ? { run_in_background: true } : {}),
    } } : undefined
    const id = phase === 'crash' ? 'crash-cell' : phase === 'foreground' ? 'foreground-cell' : 'restored-cell'
    const stream = Object.assign((async function* () {
      yield { type: 'message_start', message: { id: `${id}-${index}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } }
      yield { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id, name: tool.name, input: {} } : { type: 'text', text: '' } }
      yield { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } : { type: 'text_delta', text: 'Incarnation fixture finished.' } }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }
      yield { type: 'message_stop' }
    })(), { controller: new AbortController() })
    return { withResponse: async () => ({ data: stream, request_id: `${id}-${index}`, response: new Response('', { status: 200 }) }) }
  } } } }),
}))
const { enableConfigs } = await import('../utils/config.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')
const { createQueryEngineSessionController } = await import('./createQueryEngineSessionController.js')
const { REPLTool } = await import('../tools/REPLTool/REPLTool.js')
const { BashTool } = await import('../tools/BashTool/BashTool.js')
const storage = await import('../utils/sessionStorage.js')
const { getSessionId, switchSession } = await import('../bootstrap/state.js')
enableConfigs()
if (phase === 'history') {
  await (await import('./codeModeHistory.fixture.js')).runCodeModeHistoryFixture(root)
  process.exit(0)
}
let initialMessages: any[] = []
if (phase !== 'crash' && phase !== 'foreground') {
  const source = process.env.CODE_MODE_SOURCE_PATH!
  const restored = await (await import('../utils/conversationRecovery.js')).loadConversationForResume(undefined, source, { interruptedTurn: 'defer', mutable: false })
  if (!restored) throw new Error('Real transcript resume failed')
  initialMessages = restored.messages
  if (phase === 'resume' && restored.sessionId) switchSession(restored.sessionId as SessionId, dirname(source))
}
let state = getDefaultAppState()
state = { ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: 'bypassPermissions', isBypassPermissionsModeAvailable: true } }
if (phase === 'foreground') state = { ...state, toolPermissionContext: { ...state.toolPermissionContext, alwaysDenyRules: { session: ['Bash'] } } }
if (phase === 'crash') state = { ...state, toolPermissionContext: {
  ...state.toolPermissionContext, mode: 'default', alwaysAskRules: { session: ['Bash'] },
} }
let transcript: any[] = []
const crashChildRecorded = Promise.withResolvers<void>()
const session = createQueryEngineAppSession({
  initialMessages, cwd: process.cwd(), tools: [REPLTool, BashTool], commands: [], mcpClients: [], agents: [],
  getAppState: () => state, setAppState: update => { state = update(state) },
  readFileCache: createFileStateCacheWithSizeLimit(20), customSystemPrompt: 'Run the isolated incarnation script.', userSpecifiedModel: 'claude-sonnet-4-5',
  recordTranscript: async messages => { transcript = JSON.parse(JSON.stringify(messages)); return storage.recordTranscript(messages) },
  publishLateToolMessage: frame => { if (frame.type === 'assistant' && 'code_mode' in frame) crashChildRecorded.resolve() },
})
const restoredBeforeTurn = JSON.parse(JSON.stringify(session.getMessages()))
await createQueryEngineSessionController(session).submit('Inspect this interpreter incarnation.')
if (phase === 'crash') await crashChildRecorded.promise
await storage.flushSessionStorage()
const sourcePath = storage.getTranscriptPathForSession(getSessionId())
// Crash between ordinary transcript-lease release and runtime cleanup, avoiding
// a stale-lock timeout while still losing a genuinely active background cell.
if (phase === 'crash' || phase === 'foreground') await (await import('../utils/transcriptLease.js')).releaseActiveTranscriptLease()
const decisions = (await import('../utils/permissions/permissionDecisionContext.js')).collectPermissionDecisionContexts(restoredBeforeTurn)
const normalize = (await import('../utils/messages.js')).normalizeMessagesForAPI
const normalized = { firstParty: normalize(restoredBeforeTurn, [], 'firstParty'), openai: normalize(restoredBeforeTurn, [], 'openai') }
await writeFile(join(root, phase === 'crash' || phase === 'foreground' ? 'ready.json' : `${phase}-evidence.json`), JSON.stringify({ sourcePath, sessionId: getSessionId(), bodies, transcript, restoredBeforeTurn, decisions, normalized }))
if (phase === 'crash') await new Promise(() => {})
session.dispose?.()
await storage.flushSessionStorage()
await (await import('../utils/transcriptLease.js')).releaseActiveTranscriptLease()
