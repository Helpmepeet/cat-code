import { afterEach, expect, mock, test } from 'bun:test'
import { randomUUID } from 'crypto'
import z from 'zod/v4'
import { buildTool, type ToolUseContext } from './Tool.js'
import type { Message } from './types/message.js'
import { createAssistantMessage, createUserMessage } from './utils/messages.js'
import {
  enqueue,
  getCommandQueueSnapshot,
  resetCommandQueue,
} from './utils/messageQueueManager.js'

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => {
    release = resolve
  })
  return { promise, release }
}

let preparationStarted: ReturnType<typeof gate> | undefined
let resumePreparation: ReturnType<typeof gate> | undefined
const attachments = await import('./utils/attachments.js')
const realGetAttachmentMessages = attachments.getAttachmentMessages
mock.module('./utils/attachments.js', () => ({
  ...attachments,
  getAttachmentMessages: async function* (
    ...args: Parameters<typeof realGetAttachmentMessages>
  ) {
    if (args[3].length > 0 && preparationStarted && resumePreparation) {
      preparationStarted.release()
      await resumePreparation.promise
    }
    yield* realGetAttachmentMessages(...args)
  },
}))
const { query } = await import('./query.js')

afterEach(() => {
  resetCommandQueue()
  preparationStarted = undefined
  resumePreparation = undefined
})

const probeTool = buildTool({
  name: 'QueueRaceProbe',
  inputSchema: z.strictObject({}),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async description() { return 'fixture' },
  async prompt() { return 'fixture' },
  async validateInput() { return { result: true as const } },
  renderToolUseMessage: () => null,
  renderToolResultMessage: () => null,
  renderToolUseErrorMessage: () => null,
  mapToolResultToToolResultBlockParam(_output: unknown, toolUseID: string) {
    return { type: 'tool_result' as const, tool_use_id: toolUseID, content: 'ok' }
  },
  async call() { return { data: 'ok' } },
} as never)

function context(abortController: AbortController, messages: Message[]): ToolUseContext {
  const state = {
    toolPermissionContext: { mode: 'bypassPermissions', additionalWorkingDirectories: new Map() },
    mcp: { tools: [], clients: [] },
    tasks: {},
    sessionHooks: new Map(),
  }
  return {
    options: {
      commands: [], debug: false, verbose: false,
      mainLoopModel: 'gpt-5.6-terra', mainLoopProvider: 'openai',
      tools: [probeTool], thinkingConfig: { type: 'disabled' },
      mcpClients: [], mcpResources: {}, isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allowedAgentTypes: [] },
    },
    abortController,
    readFileState: new Map(),
    messages,
    getAppState: () => state as never,
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as ToolUseContext
}

for (const queuedValue of [
  'queued text',
  [
    { type: 'text', text: 'queued image' },
    {
      type: 'image',
      source: {
        type: 'base64', media_type: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
      },
    },
  ],
] as const) {
  const kind = typeof queuedValue === 'string' ? 'text' : 'image-bearing'
  for (const interrupted of [false, true]) {
  test(`${kind} attachment preparation ${interrupted ? 'retains ownership when interrupted' : 'consumes once in the control path'}`, async () => {
    preparationStarted = gate()
    resumePreparation = gate()
    const abortController = new AbortController()
    const initial = [createUserMessage({ content: 'start' })]
    const yielded: any[] = []
    const queuedUuid = randomUUID()
    let calls = 0
    let nonAbortedCalls = 0
    const run = (async () => {
      for await (const message of query({
        messages: initial,
        systemPrompt: ['fixture'] as never, userContext: {}, systemContext: {},
        canUseTool: async (_tool, input) => ({ behavior: 'allow' as const, updatedInput: input }),
        toolUseContext: context(abortController, initial),
        querySource: 'sdk',
        deps: {
          uuid: randomUUID,
          microcompact: async messages => ({ messages }),
          autocompact: async () => ({ wasCompacted: false, consecutiveFailures: 0 }),
          callModel: async function* ({ signal }) {
            calls++
            if (!signal.aborted) nonAbortedCalls++
            const assistant = createAssistantMessage({ content: calls === 1 ? 'tool' : 'done' })
            if (calls === 1) {
              assistant.message.content = [{ type: 'tool_use', id: 'probe', name: probeTool.name, input: {} }]
              assistant.message.stop_reason = 'tool_use'
            } else assistant.message.stop_reason = 'end_turn'
            yield assistant
          },
        },
      })) yielded.push(message)
    })()

    enqueue({ mode: 'prompt', value: queuedValue as never, uuid: queuedUuid })
    await preparationStarted.promise
    if (interrupted) abortController.abort('interrupt')
    resumePreparation.release()
    await run

    expect(getCommandQueueSnapshot()).toHaveLength(interrupted ? 1 : 0)
    if (interrupted) {
      expect(getCommandQueueSnapshot()[0]?.uuid).toBe(queuedUuid)
    }
    expect(yielded.some(message =>
      message.type === 'attachment' &&
      (message.attachment as { source_uuid?: string }).source_uuid === queuedUuid,
    )).toBe(!interrupted)
    expect(calls).toBe(2)
    expect(nonAbortedCalls).toBe(interrupted ? 1 : 2)
  })
  }
}
