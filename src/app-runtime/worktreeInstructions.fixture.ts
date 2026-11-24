import { mock } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.env.WORKTREE_INSTRUCTIONS_TEST_ROOT!
const cwdPhase = process.env.WORKTREE_CWD_PHASE
if (!root || process.env.HOME !== root || process.cwd() !== join(root, 'workspace')) {
  throw new Error('Isolated fixture required')
}
;(globalThis as unknown as { MACRO: unknown }).MACRO = { VERSION: 'worktree-instructions-test' }
globalThis.fetch = (() => { throw new Error('Network forbidden') }) as unknown as typeof fetch
type RequestEvidence = { modelRound: number; prefix: string; cwd: string }
const models: RequestEvidence[] = []
const reviews: RequestEvidence[] = []
const failures: string[] = []
mock.module('../services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  resolveCodexOAuthTokensForLeaseOwner: async () => { throw new Error('OAuth forbidden') },
  getAnthropicClient: async () => ({ beta: { messages: { create: (body: Record<string, unknown>) => {
    const messages = body.messages as unknown[]
    if (!body.stream) {
      reviews.push({ modelRound: models.length, prefix: JSON.stringify(messages[0]), cwd: process.cwd() })
      const choice = body.tool_choice as { name: string }
      return Promise.resolve({ id: 'review', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'tool_use', id: 'verdict', name: choice.name,
          input: { shouldBlock: false, thinking: 'Offline fixture admission', reason: 'Synthetic fixture' } }],
        stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 10 } })
    }
    const round = models.length + 1
    if (round > 5) throw new Error('Unexpected model request')
    models.push({ modelRound: round, prefix: JSON.stringify(messages.find(message => JSON.stringify(message).includes('# claudeMd'))), cwd: process.cwd() })
    const bash = (name: string) => ({ name: 'Bash', input: {
      command: `bash -c 'printf fixture > ${name}.txt'`, work_lifetime: 'finite', run_in_background: false,
    } })
    const write = (name: string) => ({ name: 'Write', input: { file_path: name + '.txt', content: 'fixture' } })
    const calls = cwdPhase === 'enter'
      ? round === 1 ? [{ name: 'EnterWorktree', input: { name: 'instructions' } }]
        : round === 3 ? [bash('next-shell'), write('next-file')] : []
      : cwdPhase === 'reopen'
        ? round === 1 ? [{ name: 'ExitWorktree', input: { action: 'keep' } }]
          : round === 3 ? [bash('return-shell'), write('return-file')] : []
        : round === 1
          ? [{ name: 'EnterWorktree', input: { name: 'instructions' } }, bash('stale-first')]
          : round === 2 ? [bash('fresh-first')]
            : round === 3 ? [{ name: 'ExitWorktree', input: { action: 'keep' } }, bash('stale-second')]
              : round === 4 ? [bash('fresh-second')] : []
    const stream = Object.assign((async function* () {
      yield { type: 'message_start', message: { id: `response-${round}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } }
      if (calls.length) for (const [index, call] of calls.entries()) {
        yield { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `call-${round}-${index}`, name: call.name, input: {} } }
        yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } }
        yield { type: 'content_block_stop', index }
      }
      else {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Finished synthetic transitions.' } }
        yield { type: 'content_block_stop', index: 0 }
      }
      yield { type: 'message_delta', delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }
      yield { type: 'message_stop' }
    })(), { controller: new AbortController() })
    return { withResponse: async () => ({ data: stream, request_id: `request-${round}`, response: new Response('') }) }
  } } } }),
}))
const { enableConfigs } = await import('../utils/config.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')
const { EnterWorktreeTool } = await import('../tools/EnterWorktreeTool/EnterWorktreeTool.js')
const { ExitWorktreeTool } = await import('../tools/ExitWorktreeTool/ExitWorktreeTool.js')
const { BashTool } = await import('../tools/BashTool/BashTool.js')
const { FileWriteTool } = await import('../tools/FileWriteTool/FileWriteTool.js')
const { getOriginalCwd, getSessionId } = await import('../bootstrap/state.js')
const { createAssistantMessage } = await import('../utils/messages.js')
const { getCurrentWorktreeSession } = await import('../utils/worktree.js')
const { restoreWorktreeForResume } = await import('../utils/sessionRestore.js')
enableConfigs()
if (cwdPhase === 'reopen') {
  restoreWorktreeForResume(JSON.parse(await readFile(join(root, 'checkout.json'), 'utf8')))
}
let state = getDefaultAppState()
state = { ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: 'auto' } }
const inlineFile = cwdPhase === 'reopen' ? 'return-inline.txt' : 'next-inline.txt'
const sourceMessage = createAssistantMessage({ content: '```bash\nprintf fixture > ' + inlineFile + '\n```' })
sourceMessage.message.stop_reason = 'end_turn'
const session = createQueryEngineAppSession({
  cwd: process.cwd(), getWorkspaceCwd: getOriginalCwd,
  ...(cwdPhase ? { initialMessages: [sourceMessage] } : {}),
  tools: [EnterWorktreeTool, ExitWorktreeTool, BashTool, FileWriteTool], commands: [], mcpClients: [], agents: [],
  getAppState: () => state, setAppState: update => { state = update(state) },
  readFileCache: createFileStateCacheWithSizeLimit(20), customSystemPrompt: 'Perform the synthetic transitions.',
  userSpecifiedModel: 'claude-sonnet-4-5',
  recordTranscript: async () => null,
})
const prompts = cwdPhase ? ['Change checkout.', 'Write the two fixture files.'] : ['Enter the fixture worktree, return, and report.']
for (const [index, prompt] of prompts.entries()) {
  for await (const message of session.submitMessage(prompt, {
    onPermissionRequest: async () => { failures.push('Unexpected manual approval'); return { behavior: 'deny', message: 'Fixture denies fallback' } },
  })) {
    if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) if (block.type === 'tool_result' && block.is_error) failures.push(String(block.content))
    }
  }
  if (cwdPhase && index === 0) {
    if (!session.executeInlineCommand) throw new Error('Missing inline command runtime')
    for await (const _message of session.executeInlineCommand({
      source: { engineSessionId: getSessionId(), messageUuid: sourceMessage.uuid, contentBlockIndex: 0, fenceOrdinal: 0 },
      runId: crypto.randomUUID(), signal: new AbortController().signal,
      onProgress: run => { if (run.status !== 'running' && run.exitCode !== 0) failures.push(run.output) },
    })) { /* drain the execution */ }
  }
}
if (cwdPhase === 'enter') {
  const checkout = getCurrentWorktreeSession()
  if (!checkout) throw new Error('Fixture did not enter its worktree')
  await writeFile(join(root, 'checkout.json'), JSON.stringify(checkout))
}
await writeFile(join(root, 'evidence.json'), JSON.stringify({ models, reviews, failures }))
session.dispose?.()
process.exit(0)
