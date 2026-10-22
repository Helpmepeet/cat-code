import { mock } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EngineFixtureInput, EngineExperimentEvidence } from './engineProcess.js'

const root = process.env.EXPERIMENT_ROOT
if (!root || process.env.HOME !== root || !process.cwd().startsWith(root + '/')) throw new Error('Isolated environment required')
const input: EngineFixtureInput = JSON.parse(process.env.EXPERIMENT_INPUT!)
const model = input.provider === 'codex' ? 'gpt-5.6-terra' : 'claude-sonnet-4-5'
const evidence: EngineExperimentEvidence = { requests: [], frames: [], accepted: false, transcript: [] }
let enqueueResult: (() => void) | undefined
let convertCodexRequest: ((body: Record<string, unknown>) => { codexBody: Record<string, unknown> }) | undefined
let unexpectedNetworkCalls = 0
globalThis.fetch = (() => {
  unexpectedNetworkCalls++
  throw new Error('Unexpected network request forbidden')
}) as typeof fetch
;(globalThis as any).MACRO = { VERSION: 'experiment' }

// Only the transport client is replaced. QueryEngine, query, provider message
// assembly and streaming-event conversion remain real. Codex additionally uses
// the real request converter; its credential/client creation and response
// transport are replaced. Account-pool initialization is not exercised.
mock.module('../../src/services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  resolveCodexOAuthTokensForLeaseOwner: async () => { throw new Error('OAuth forbidden in experiment') },
  getAnthropicClient: async () => ({ beta: { messages: { create: (body: unknown) => {
    if ((body as any).model !== model || evidence.requests.length >= (input.busy || input.repeat ? 2 : 1)) {
      throw new Error('Unexpected provider dispatch')
    }
    evidence.requests.push(JSON.parse(JSON.stringify(body)))
    if (input.provider === 'codex') {
      const { codexBody } = convertCodexRequest!(body as Record<string, unknown>)
      ;(evidence.codexRequests ??= []).push(JSON.parse(JSON.stringify(codexBody)))
    }
    const busyFirstRequest = input.busy && evidence.requests.length === 1
    if (busyFirstRequest) {
      enqueueResult!()
      if (input.stopBeforeDispatch) abortController.abort()
    }
    const message = { id: 'fixture-message', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } }
    const events = [
      { type: 'message_start', message },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The command result was received. Here is the automatic follow-up.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } },
      { type: 'message_stop' },
    ]
    if (busyFirstRequest) {
      events.splice(1, 3,
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'fixture-tool', name: 'Read', input: {} } } as any,
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: join(root, 'workspace', 'fixture.txt') }) } } as any,
        { type: 'content_block_stop', index: 0 },
      )
      ;(events[4] as any).delta.stop_reason = 'tool_use'
    }
    const stream = Object.assign((async function* () { yield* events })(), { controller: new AbortController() })
    return { withResponse: async () => ({ data: stream, request_id: 'fixture-request', response: new Response('', { status: 200 }) }) }
  } } } }),
}))
const { QueryEngine } = await import('../../src/QueryEngine.js')
if (input.provider === 'codex') {
  const { translateToCodexBody } = await import('../../src/services/api/codex-fetch-adapter.js')
  convertCodexRequest = translateToCodexBody
}
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.js')
const { enqueue } = await import('../../src/utils/messageQueueManager.js')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.js')
await writeFile(join(root, 'workspace', 'fixture.txt'), 'Isolated tool-boundary fixture')
enqueueResult = () => enqueue({ mode: 'prompt', value: input.context, uuid: '11111111-1111-4111-8111-111111111111' })
let state = getDefaultAppState()
const abortController = new AbortController()
const initialMessages = input.recoveryPhase === 'restore-only' || input.recoveryPhase === 'retry'
  ? JSON.parse(await readFile(join(root, 'transcript.json'), 'utf8'))
  : []
const engine = new QueryEngine({
  initialMessages,
  cwd: process.cwd(), tools: input.busy ? [FileReadTool] : [], commands: [], mcpClients: [], agents: [],
  canUseTool: async (tool, toolInput) => {
    if (tool.name !== 'Read' || (toolInput as any).file_path !== join(root, 'workspace', 'fixture.txt')) throw new Error('Unexpected tool invocation')
    return { behavior: 'allow', updatedInput: toolInput }
  },
  getAppState: () => state, setAppState: update => { state = update(state) },
  readFileCache: createFileStateCacheWithSizeLimit(20), customSystemPrompt: 'Explain user command results.',
  userSpecifiedModel: model, abortController,
  recordTranscript: async messages => {
    if (input.failPersistence) throw new Error('Injected transcript write failure')
    evidence.transcript = JSON.parse(JSON.stringify(messages))
    // Deliberately a fixture snapshot, not production session storage or an
    // fsync receipt. Readback proves survival of this process kill only.
    await writeFile(join(root, 'transcript.json'), JSON.stringify(messages))
    return null
  },
})
try {
  if (input.recoveryPhase === 'restore-only') {
    // Construction/restoration is not a continuation scheduler. Do not invent
    // a submit here: capture precisely what a fresh engine restores.
    evidence.transcript = JSON.parse(JSON.stringify(engine.getMessages()))
  } else {
    for (let attempt = 0; attempt < (input.repeat ? 2 : 1); attempt++) {
      for await (const frame of engine.submitMessage(input.busy ? 'Start the fixture task.' : input.context, {
        uuid: '22222222-2222-4222-8222-222222222222',
        onInputPersisted: async () => {
          evidence.accepted = true
          if (input.recoveryPhase === 'kill-after-acceptance') {
            if (unexpectedNetworkCalls) throw new Error(`Forbidden network calls attempted: ${unexpectedNetworkCalls}`)
            await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence))
            process.kill(process.pid, 'SIGKILL')
            await new Promise(() => {})
          }
          if (input.crashAfterAcceptance) throw new Error('Injected interruption after context acceptance, before provider dispatch')
          if (input.stopBeforeDispatch && !input.busy) abortController.abort()
        },
      })) evidence.frames.push(frame)
    }
  }
} catch (error) { evidence.error = String(error) }
if (unexpectedNetworkCalls) throw new Error(`Forbidden network calls attempted: ${unexpectedNetworkCalls}`)
await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence))
process.exit(0)
