import { mock } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SessionId } from '../types/ids.js'
const root = process.env.CODE_MODE_TEST_ROOT!
const phase = process.env.CODE_MODE_RESUME_PHASE!
if (!root || process.env.HOME !== root || process.cwd() !== join(root, 'workspace')) throw new Error('Isolated resume fixture required')
globalThis.fetch = (() => { throw new Error('Network forbidden') }) as unknown as typeof fetch
;(globalThis as any).MACRO = { VERSION: 'code-mode-resume-test' }
const changedPath = join(root, 'workspace', 'finished.txt')
const readPaths = Array.from({ length: 12 }, (_, index) => join(root, 'workspace', `large-${index}.txt`))
const completedMutation = `for (const file_path of ${JSON.stringify(readPaths)}) await tools.call({name:"Read", input:{file_path}}); await tools.call({name:"Write",input:{file_path:${JSON.stringify(changedPath)},content:"written before interruption ".repeat(1800)}});`
if (phase === 'crash') {
  await Promise.all(readPaths.map(path => writeFile(path, ('Synthetic retained audit line. '.repeat(5) + '\n').repeat(220))))
}
const bodies: any[] = []
mock.module('../services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  resolveCodexOAuthTokensForLeaseOwner: async () => { throw new Error('OAuth forbidden') },
  getAnthropicClient: async () => ({ beta: { messages: { create: (body: any) => {
    const index = bodies.length
    bodies.push(JSON.parse(JSON.stringify(body)))
    if (index > 1) throw new Error('Unexpected resume model request')
    const tool = index === 0 ? { name: 'REPL', input: {
      code: phase === 'crash' ? `var retainedCrash = "must-reset"; ${completedMutation} await tools.call({name:"Bash",input:{command:"printf crash-child",work_lifetime:"finite",run_in_background:false}});` : phase === 'headless-eof-fault' ? 'output("test previous tool outcome");' : phase === 'foreground'
        ? 'var retainedCrash = "must-reset"; await tools.call({name:"Bash",input:{command:"printf must-not-run",work_lifetime:"finite",run_in_background:false},nothrow:true}); output("foreground-seed");'
        : 'output({prior:typeof retainedCrash});',
      description: 'Isolated incarnation fixture', ...(phase === 'crash' || phase === 'headless-eof-fault' ? { run_in_background: true } : {}),
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
const { FileReadTool } = await import('../tools/FileReadTool/FileReadTool.js')
const { FileWriteTool } = await import('../tools/FileWriteTool/FileWriteTool.js')
const storage = await import('../utils/sessionStorage.js')
const { getSessionId, switchSession } = await import('../bootstrap/state.js')
enableConfigs()
if (phase === 'history') {
  await (await import('./codeModeHistory.fixture.js')).runCodeModeHistoryFixture(root)
  process.exit(0)
}
if (phase === 'headless-eof-fault' || phase === 'headless-legacy') {
  const { randomUUID } = await import('node:crypto')
  const { runHeadlessStreaming } = await import('../cli/print.js')
  const { StructuredIO } = await import('../cli/structuredIO.js')
  const { createAssistantMessage, createUserMessage } = await import('../utils/messages.js')
  const { toSDKMessages } = await import('../utils/messages/mappers.js')
  let state = getDefaultAppState()
  state = { ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: 'bypassPermissions', isBypassPermissionsModeAvailable: true } }
  const messages: import('../types/message.js').Message[] = []
  if (phase === 'headless-legacy') {
    const assistant = createAssistantMessage({ content: [{ type: 'tool_use', id: 'legacy-script', name: 'REPL', input: { code: 'output(1)' } }] })
    const error = 'This runtime incarnation does not own or continue the prior background execution, which has no terminal receipt here. Its final outcome is unknown; recorded completed effects remain valid. No continuation was resumed or replayed.'
    const outcome = { kind: 'code-mode', cellId: 'legacy-script', generation: 'legacy-generation', taskId: 'legacy-task', status: 'failed', calls: [], changedFiles: [], error, output: `[Code Mode] Prior background execution is no longer owned. ${error}` }
    messages.push(assistant, createUserMessage({
      content: outcome.output, isMeta: true, toolUseResult: outcome, sourceToolAssistantUUID: assistant.uuid as `${string}-${string}-${string}-${string}-${string}`,
    }))
  }
  const legacyUuid = messages[1]?.uuid
  async function* stdin() {
    if (phase === 'headless-eof-fault') {
      yield JSON.stringify({ type: 'user', uuid: randomUUID(), session_id: getSessionId(), parent_tool_use_id: null, message: { role: 'user', content: 'Run the harmless output fixture.' } }) + '\n'
    }
  }
  const io = new StructuredIO(stdin(), false)
  const options = { systemPrompt: 'Run the isolated Script.', userSpecifiedModel: 'claude-sonnet-4-5', thinkingConfig: { type: 'disabled' }, verbose: true } as Parameters<typeof runHeadlessStreaming>[10]
  let writeAttempts = 0
  const frames = []
  for await (const frame of runHeadlessStreaming(io, [], [], [REPLTool], messages,
    async (_tool, input) => ({ behavior: 'allow', updatedInput: input }), {},
    () => state, update => { state = update(state) }, [], options, { kind: 'none' }, false,
    late => {
      if (late.type === 'user' && late.origin?.kind === 'task-notification') {
        writeAttempts++
        throw new Error('Fixture transport cannot accept the late receipt.')
      }
    })) frames.push(frame)
  await writeFile(join(root, `${phase}-evidence.json`), JSON.stringify({
    writeAttempts, frames, legacyUuid, projected: toSDKMessages(messages),
  }))
  await (await import('../utils/transcriptLease.js')).releaseActiveTranscriptLease()
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
  ...state.toolPermissionContext, mode: 'default',
  alwaysAllowRules: { session: ['Read', 'Write'] }, alwaysAskRules: { session: ['Bash'] },
} }
let transcript: any[] = []
const crashChildRecorded = Promise.withResolvers<void>()
const session = createQueryEngineAppSession({
  initialMessages, cwd: process.cwd(), tools: [REPLTool, BashTool, FileReadTool, FileWriteTool], commands: [], mcpClients: [], agents: [],
  getAppState: () => state, setAppState: update => { state = update(state) },
  readFileCache: createFileStateCacheWithSizeLimit(20), customSystemPrompt: 'Run the isolated incarnation script.', userSpecifiedModel: 'claude-sonnet-4-5',
  recordTranscript: async messages => { transcript = JSON.parse(JSON.stringify(messages)); return storage.recordTranscript(messages) },
  publishLateToolMessage: frame => {
    if (frame.type === 'assistant' && 'code_mode' in frame &&
        frame.message.content.some(block => block && typeof block === 'object' &&
          'type' in block && block.type === 'tool_use' && 'name' in block && block.name === 'Bash')) crashChildRecorded.resolve()
  },
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
