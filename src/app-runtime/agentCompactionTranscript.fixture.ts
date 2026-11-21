import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const root = process.env.HOME
if (!root || process.cwd() !== join(root, 'workspace') ||
    process.env.CLAUDE_CONFIG_DIR !== join(root, 'config')) {
  throw new Error('Isolated compaction fixture required')
}
const [scope, strategy] = process.argv.slice(2)
const background = scope === 'background'
const sessionMemory = strategy === 'session-memory'
const sessionMemorySummary = 'Isolated session memory summary.'
const parentTurn = Promise.withResolvers<void>()
const model = 'claude-sonnet-4-5'
const archiveDir = join(root, 'archive')
const readFiles = ['oldest-read-evidence', 'newest-read-evidence']
const readRounds = strategy === 'prefix' ? 2 : 1
const workerPrompt = 'Inspect files as the isolated worker.'
for (const [index, evidence] of readFiles.entries()) {
  await writeFile(join(process.cwd(), `evidence-${index}.txt`), evidence + '\n')
}

type ToolCall = { name: string; input: Record<string, unknown> }

function messageResponse(id: string, output: ToolCall | string, inputTokens = 100): Response {
  const tool = typeof output === 'string' ? undefined : output
  const events = [
    {
      type: 'message_start',
      message: {
        id, type: 'message', role: 'assistant', model, content: [],
        stop_reason: null, stop_sequence: null, usage: {
          input_tokens: inputTokens, cache_read_input_tokens: 20,
          cache_creation_input_tokens: 5, output_tokens: 0,
        },
      },
    },
    {
      type: 'content_block_start', index: 0,
      content_block: tool ? { type: 'tool_use', id, name: tool.name, input: {} } : { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta', index: 0,
      delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } : { type: 'text_delta', text: output },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta', delta: { stop_reason: null, stop_sequence: null },
      usage: { output_tokens: 10 },
    },
    {
      type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 15 },
    },
    { type: 'message_stop' },
  ]
  return new Response(
    events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'Content-Type': 'text/event-stream', 'request-id': id } },
  )
}

let parentRequestedAgent = false
let compactingRequests = 0
let responseCount = 0
let recoveryPath: string | undefined
let includedParentMemory = false
let preservedRead = false
let receiptUsage: Record<string, number> = {}
globalThis.fetch = (async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input)
  if (url.origin !== 'https://compaction.invalid' || url.pathname !== '/v1/messages') {
    throw new Error(`Unexpected fixture URL ${url.origin}${url.pathname}`)
  }
  const body = JSON.parse(input instanceof Request ? await input.text() : String(init?.body)) as {
    messages: BetaMessageParam[]
  }
  const userText = body.messages
    .filter(message => message.role === 'user')
    .flatMap(({ content }) => typeof content === 'string' ? [content] :
      content.flatMap(block => block.type === 'text' ? [block.text] : []))
    .join('\n')
  const id = `fixture-${++responseCount}`
  if (userText.includes('CRITICAL: Respond with TEXT ONLY.')) {
    return messageResponse(id, '<summary>Isolated compaction summary.</summary>')
  }
  if (userText.includes(sessionMemorySummary) || userText.includes('Isolated compaction summary')) {
    includedParentMemory = userText.includes(sessionMemorySummary)
    recoveryPath = /read the full transcript at: ([^\n]+)/.exec(userText)?.[1]
    preservedRead = body.messages.some(({ role, content }) =>
      role === 'assistant' && Array.isArray(content) &&
      content.some(block => block.type === 'tool_use' && block.name === 'Read'),
    )
    return messageResponse(id, 'Finished after compaction.')
  }
  if (scope !== 'main' && !userText.includes(workerPrompt)) {
    if (!parentRequestedAgent) {
      parentRequestedAgent = true
      return messageResponse(id, {
        name: 'Agent',
        input: {
          description: 'Inspect isolated evidence files',
          subagent_type: 'general-purpose',
          prompt: workerPrompt,
          run_in_background: background,
        },
      })
    }
    const receipt = JSON.stringify(body.messages).match(/<usage>(.*?)<\/usage>/)?.[1]
    receiptUsage = Object.fromEntries(
      Array.from((receipt ?? '').replace(/\\n/g, '\n').matchAll(/^([a-z_]+): (\d+)/gm),
        ([, key, value]) => [key, Number(value)]),
    )
    return messageResponse(id, 'Parent received the worker result.')
  }
  const round = compactingRequests++
  if (background && round === 0) await parentTurn.promise
  if (round < readRounds) {
    return messageResponse(id, {
      name: 'Read',
      input: { file_path: join(process.cwd(), `evidence-${round}.txt`) },
    }, sessionMemory ? 150_000 : undefined)
  }
  if (round === readRounds) {
    return Response.json({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum' },
    }, { status: 400 })
  }
  throw new Error('Compaction did not retry the interrupted request')
}) as typeof fetch
Object.assign(globalThis, { MACRO: { VERSION: 'compaction-fixture' } })

const { getSessionId, switchSession } = await import('../bootstrap/state.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { AgentTool } = await import('../tools/AgentTool/AgentTool.js')
const { GENERAL_PURPOSE_AGENT } = await import('../tools/AgentTool/built-in/generalPurposeAgent.js')
const { FileReadTool } = await import('../tools/FileReadTool/FileReadTool.js')
const { enableConfigs } = await import('../utils/config.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { flushSessionStorage } = await import('../utils/sessionStorage.js')
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')
const { createQueryEngineSessionController } = await import('./createQueryEngineSessionController.js')
const { getCommandQueue } = await import('../utils/messageQueueManager.js')
const { parseTaskNotificationDetails } = await import('../utils/taskNotification.js')

enableConfigs()
const sessionId = getSessionId()
switchSession(sessionId, archiveDir)
if (sessionMemory) {
  const { getSessionMemoryPath } = await import('../utils/permissions/filesystem.js')
  const memoryPath = getSessionMemoryPath()
  await mkdir(dirname(memoryPath), { recursive: true })
  await writeFile(memoryPath, `# Current State\n${sessionMemorySummary}\n`)
}
let state = getDefaultAppState()
state = {
  ...state,
  toolPermissionContext: {
    ...state.toolPermissionContext,
    mode: 'bypassPermissions',
    isBypassPermissionsModeAvailable: true,
  },
}
const session = createQueryEngineAppSession({
  cwd: process.cwd(),
  tools: [AgentTool, FileReadTool],
  commands: [],
  mcpClients: [],
  agents: [GENERAL_PURPOSE_AGENT],
  getAppState: () => state,
  setAppState: update => { state = update(state) },
  readFileCache: createFileStateCacheWithSizeLimit(20),
  customSystemPrompt: 'Work on the isolated evidence files.',
  userSpecifiedModel: model,
})
try {
  const controller = createQueryEngineSessionController(session)
  await controller.submit('Inspect the isolated evidence files.')
  parentTurn.resolve()
  let liveNotification: string | undefined
  if (background) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const entry = getCommandQueue().find(command => command.mode === 'task-notification')
      if (typeof entry?.value === 'string') {
        liveNotification = entry.value
        break
      }
      await Bun.sleep(25)
    }
    if (!liveNotification) throw new Error('Background completion did not reach the queue')
  }
  await flushSessionStorage()
  const parentTranscript = join(archiveDir, `${sessionId}.jsonl`)
  let transcript = parentTranscript
  let savedNotification: string | undefined
  if (scope !== 'main') {
    const subagents = join(archiveDir, sessionId, 'subagents')
    // The dispatched Agent has metadata. The summarization fork also has a
    // transcript, but it is not the worker archive that should be linked.
    const metadata = (await readdir(subagents)).filter(file => file.endsWith('.meta.json'))
    if (metadata.length !== 1) throw new Error(`Expected one worker, found ${metadata.length}`)
    transcript = join(subagents, metadata[0]!.replace(/\.meta\.json$/, '.jsonl'))
    if (background) {
      savedNotification = (await readFile(parentTranscript, 'utf8')).trim().split('\n')
        .map(line => JSON.parse(line))
        .find(entry => entry.type === 'subagent-terminal' && entry.status === 'completed')
        ?.notification
    }
  }
  const archive = await readFile(transcript, 'utf8')
  console.log(JSON.stringify({
    transcript,
    recoveryPath,
    preservedRead,
    includedParentMemory,
    receiptUsage,
    liveUsage: liveNotification && parseTaskNotificationDetails(liveNotification)?.usage,
    savedUsage: savedNotification && parseTaskNotificationDetails(savedNotification)?.usage,
    olderReadInArchive: archive.includes(readFiles[0]!),
  }))
} finally {
  session.dispose?.()
}
