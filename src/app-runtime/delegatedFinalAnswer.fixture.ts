import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { mock } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.env.HOME
const scenario = process.argv[2]
if (!root || process.cwd() !== join(root, 'workspace') ||
    process.env.CLAUDE_CONFIG_DIR !== join(root, 'config')) {
  throw new Error('Isolated delegated answer fixture required')
}

Object.assign(globalThis, { MACRO: { VERSION: 'delegated-answer-fixture' } })
mock.module('../utils/settings/managedPath.js', () => ({
  getManagedFilePath: () => join(root, 'config', 'managed'),
  getManagedSettingsDropInDir: () => join(root, 'config', 'managed', 'managed-settings.d'),
}))

if (scenario === 'continued') {
  const flags = await import('../services/analytics/growthbook.js')
  const readFlag = flags.getFeatureValue_CACHED_MAY_BE_STALE
  mock.module('../services/analytics/growthbook.js', () => ({
    ...flags,
    getFeatureValue_CACHED_MAY_BE_STALE: (key: string, fallback: unknown) =>
      key === 'tengu_otk_slot_v1' ? true : readFlag(key, fallback),
  }))
}

const model = 'claude-sonnet-4-5'
const background = scenario === 'background'
const workerPrompt = 'Inspect the isolated lease evidence.'
const parentHasLaunchReceipt = Promise.withResolvers<void>()
const evidencePath = join(process.cwd(), 'lease.txt')
await writeFile(evidencePath, 'An expired lease survived reload.\n')

type ToolCall = { name: string; input: Record<string, unknown> }
type ScriptedBlock = {
  block: Record<string, unknown>
  delta: Record<string, unknown>
}

function textBlock(text: string, phase?: 'commentary' | 'final_answer'): ScriptedBlock {
  return {
    block: { type: 'text', text: '', ...(phase && { phase }) },
    delta: { type: 'text_delta', text },
  }
}

function messageResponse(id: string, output: ToolCall | ScriptedBlock[], capped = false): Response {
  const blocks = Array.isArray(output) ? output : [{
    block: { type: 'tool_use', id, name: output.name, input: {} },
    delta: { type: 'input_json_delta', partial_json: JSON.stringify(output.input) },
  }]
  const events: string[] = []
  const emit = (type: string, fields: object = {}) => {
    events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`)
  }
  emit('message_start', { message: {
    id, type: 'message', role: 'assistant', model, content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 15, output_tokens: 0 },
  } })
  for (const [index, { block, delta }] of blocks.entries()) {
    emit('content_block_start', { index, content_block: block })
    emit('content_block_delta', { index, delta })
    emit('content_block_stop', { index })
  }
  const stop_reason = capped ? 'max_tokens' : blocks.some(({ block }) => block.type === 'tool_use') ? 'tool_use' : 'end_turn'
  emit('message_delta', { delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } })
  emit('message_stop')
  return new Response(events.join(''), { headers: { 'Content-Type': 'text/event-stream', 'request-id': id } })
}

function userBlocks(messages: BetaMessageParam[]) {
  return messages.flatMap(({ role, content }) => role !== 'user' ? [] :
    typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content)
}

function toolResultText(messages: BetaMessageParam[], id: string): string[] {
  const result = userBlocks(messages).find(block => block.type === 'tool_result' && block.tool_use_id === id)
  if (result?.type !== 'tool_result' || result.is_error) {
    throw new Error(`Expected a successful ${id} receipt: ${JSON.stringify(result)}`)
  }
  return typeof result.content === 'string' ? [result.content] :
    (result.content ?? []).flatMap(block => block.type === 'text' ? [block.text] : [])
}

const parentRequests: BetaMessageParam[][] = []
const unexpectedFetches: string[] = []
let workerRequests = 0
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input)
  if (url.origin !== 'https://delegated-answer.invalid' || url.pathname !== '/v1/messages') {
    unexpectedFetches.push(url.href)
    throw new Error(`Unexpected fixture URL ${url.href}`)
  }
  const { messages } = JSON.parse(input instanceof Request ? await input.text() : String(init?.body)) as {
    messages: BetaMessageParam[]
  }
  const worker = userBlocks(messages).some(block => block.type === 'text' && block.text.includes(workerPrompt))
  if (worker) {
    if (workerRequests++ === 0) {
      const read = { name: 'Read', input: { file_path: evidencePath } }
      return messageResponse('worker-read', [
        textBlock('I will check the persisted lease.'),
        { block: { type: 'tool_use', id: 'worker-read', name: read.name, input: {} },
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(read.input) } },
      ])
    }
    if (scenario === 'continued' && workerRequests === 4) {
      if (!userBlocks(messages).some(block => block.type === 'text' && block.text.includes('Output token limit hit'))) {
        throw new Error('Expected the worker to continue its capped answer')
      }
      return messageResponse('worker-continued', [textBlock('The expiry comparison is correct.', 'final_answer')])
    }
    if (scenario === 'continued' && workerRequests === 3) {
      return messageResponse('worker-prefix', [
        textBlock('Storage multiplies an already-millisecond deadline by 1,000.', 'final_answer'),
      ], true)
    }
    if (workerRequests !== 2 || !toolResultText(messages, 'worker-read').join('').includes('An expired lease survived reload.')) {
      throw new Error('Worker did not receive the lease evidence')
    }
    if (background) await parentHasLaunchReceipt.promise
    if (scenario === 'continued') {
      // The capped default is replayed at a higher limit before continuation.
      return messageResponse('worker-replayed', [textBlock('Discarded draft.', 'final_answer')], true)
    }
    const conclusion = textBlock('The expiry comparison is correct.', 'final_answer')
    return messageResponse('worker-final', scenario === 'single' ? [conclusion] : [
      { block: { type: 'thinking', thinking: '', signature: '' },
        delta: { type: 'thinking_delta', thinking: 'Hidden reasoning about the lease.' } },
      textBlock('I have almost finished the check.', 'commentary'),
      textBlock('Storage multiplies an already-millisecond deadline by 1,000.', 'final_answer'),
      conclusion,
    ])
  }

  const index = parentRequests.push(messages) - 1
  if (index === 0) return messageResponse('parent-agent', {
    name: 'Agent',
    input: { description: 'Inspect the lease evidence', subagent_type: 'general-purpose',
      prompt: workerPrompt, run_in_background: background },
  })
  if (background && index === 1) {
    const taskId = /\bagentId: (\S+)/.exec(toolResultText(messages, 'parent-agent').join(''))?.[1]
    if (!taskId) throw new Error('Parent did not receive a background agent ID')
    parentHasLaunchReceipt.resolve()
    // Await the real queue entry so the next tool boundary can deliver it to the parent.
    for (let attempt = 0; attempt < 200; attempt++) {
      if (getCommandQueue().some(command => command.mode === 'task-notification')) {
        return messageResponse('parent-output', { name: 'TaskOutput', input: { task_id: taskId } })
      }
      await Bun.sleep(25)
    }
    throw new Error('Background worker did not enqueue a notification')
  }
  if (index !== (background ? 2 : 1)) throw new Error('Unexpected parent provider request')
  return messageResponse('parent-final', [textBlock('Parent finished.')])
}, { preconnect: () => { throw new Error('Network preconnect forbidden') } })

const { getSessionId, switchSession } = await import('../bootstrap/state.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { AgentTool } = await import('../tools/AgentTool/AgentTool.js')
const { GENERAL_PURPOSE_AGENT } = await import('../tools/AgentTool/built-in/generalPurposeAgent.js')
const { FileReadTool } = await import('../tools/FileReadTool/FileReadTool.js')
const { TaskOutputTool } = await import('../tools/TaskOutputTool/TaskOutputTool.js')
const { enableConfigs } = await import('../utils/config.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { getCommandQueue } = await import('../utils/messageQueueManager.js')
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')

enableConfigs()
switchSession(getSessionId())
const initialState = getDefaultAppState()
let state: typeof initialState = {
  ...initialState,
  toolPermissionContext: {
    ...initialState.toolPermissionContext,
    mode: 'bypassPermissions',
    isBypassPermissionsModeAvailable: true,
  },
}
const session = createQueryEngineAppSession({
  cwd: process.cwd(), commands: [], agents: [GENERAL_PURPOSE_AGENT], mcpClients: [],
  tools: [AgentTool, FileReadTool, TaskOutputTool],
  getAppState: () => state, setAppState: update => { state = update(state) },
  readFileCache: createFileStateCacheWithSizeLimit(20),
  customSystemPrompt: 'Run the isolated agent answer fixture.', userSpecifiedModel: model,
  thinkingConfig: { type: 'disabled' },
})
try {
  const frames = await Array.fromAsync(session.submitMessage('Launch an isolated worker.'))
  const terminal = frames.at(-1)
  const lastParentRequest = parentRequests.at(-1)
  if (unexpectedFetches.length || parentRequests.length !== (background ? 3 : 2) || workerRequests !== (scenario === 'continued' ? 4 : 2) ||
      terminal?.type !== 'result' || terminal.subtype !== 'success' || !lastParentRequest) {
    throw new Error(JSON.stringify({ unexpectedFetches, parentRequests: parentRequests.length, workerRequests, terminal }))
  }
  if (background) {
    const outputReceipt = toolResultText(lastParentRequest, 'parent-output').join('\n')
    const taskOutput = /<output>\n([\s\S]*?)\n<\/output>/.exec(outputReceipt)?.[1]
    const userText = userBlocks(lastParentRequest).flatMap(block => block.type === 'text' ? [block.text] : [])
    const notification = [outputReceipt, ...userText]
      .map(text => /\nResult:\n([\s\S]*?)\nUsage:\n/.exec(text)?.[1]).find(Boolean)
    if (!outputReceipt.includes('<status>completed</status>') || !taskOutput || !notification) {
      throw new Error(`Expected TaskOutput and notification in the provider request: ${JSON.stringify(lastParentRequest)}`)
    }
    process.stdout.write(JSON.stringify({ taskOutput, notification }))
  } else {
    const receipt = toolResultText(lastParentRequest, 'parent-agent')
    const metadata = receipt.at(-1)
    if (!metadata?.startsWith('agentId: ')) throw new Error(`Unexpected Agent receipt: ${JSON.stringify(receipt)}`)
    process.stdout.write(JSON.stringify({ synchronous: receipt.slice(0, -1) }))
  }
} finally {
  session.dispose?.()
}
