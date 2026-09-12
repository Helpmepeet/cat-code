import { afterEach, expect, mock, test } from 'bun:test'
import z from 'zod/v4'

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
let attachmentSnapshot: ReturnType<typeof gate> | null = null
let attachmentResume: ReturnType<typeof gate> | null = null
const actualAttachments = await import('./utils/attachments.js')
const realGetAttachmentMessages = actualAttachments.getAttachmentMessages
mock.module('./utils/attachments.js', () => ({
  ...actualAttachments,
  getAttachmentMessages: async function* (...args: Parameters<typeof realGetAttachmentMessages>) {
    if (args[3].length && attachmentSnapshot && attachmentResume) {
      // Delay the real asynchronous attachment seam after query's queue snapshot.
      // The actual attachment builder, lifecycle loop, queue, and sidecar remain real.
      attachmentSnapshot.release()
      await attachmentResume.promise
    }
    yield* realGetAttachmentMessages(...args)
  },
}))
let queryDeps: any = null
const actualDeps = await import('./query/deps.js')
mock.module('./query/deps.js', () => ({
  ...actualDeps,
  productionDeps: () => queryDeps ?? actualDeps.productionDeps(),
}))
const { query } = await import('./query.js')
const actualQueryModule = await import('./query.js')
mock.module('./query.js', () => ({
  ...actualQueryModule,
  query: (args: any) => query(queryDeps ? { ...args, deps: queryDeps } : args),
}))
const actualUserInput = await import('./utils/processUserInput/processUserInput.js')
mock.module('./utils/processUserInput/processUserInput.js', () => ({
  ...actualUserInput,
  processUserInput: async ({ input, uuid }: any) => ({
    messages: [createUserMessage({ content: input, uuid })], shouldQuery: true, allowedTools: [],
  }),
}))
const actualQueryContext = await import('./utils/queryContext.js')
mock.module('./utils/queryContext.js', () => ({
  ...actualQueryContext,
  fetchSystemPromptParts: async () => ({ defaultSystemPrompt: [], userContext: {}, systemContext: {} }),
}))
const { buildTool } = await import('./Tool.js')
const { createUserMessage, createAssistantMessage } = await import('./utils/messages.js')
const { getCommandQueueSnapshot, resetCommandQueue } = await import('./utils/messageQueueManager.js')
const { SidecarServer } = await import('../app/sidecar/sidecarServer.js')
const { FrameDecoder, encodeFrame } = await import('../app/shared/framing.js')
const { MAX_OUTBOUND_FRAME_BYTES } = await import('../app/shared/limits.js')
const { PROTOCOL_VERSION } = await import('../app/shared/protocol.js')
const { QueryEngine } = await import('./QueryEngine.js')
const { createQueryEngineAppSession } = await import('./app-runtime/createQueryEngineAppSession.js')
const { createQueryEngineSessionController } = await import('./app-runtime/createQueryEngineSessionController.js')
const { getDefaultAppState } = await import('./state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('./utils/fileStateCache.js')

let server: InstanceType<typeof SidecarServer> | undefined
afterEach(() => {
  server?.close()
  server = undefined
  resetCommandQueue()
  attachmentSnapshot = null
  attachmentResume = null
  queryDeps = null
})

async function waitFor(check: () => boolean) {
  for (let count = 0; count < 400; count++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('fixture wait timed out')
}
async function waitAt(promise: Promise<void>, stage: string) {
  await Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(stage)), 2000)),
  ])
}

for (const queuedPrompt of [
  'MUST HANDLE THIS',
  [
    { type: 'text', text: 'MUST HANDLE IMAGE' },
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
      },
    },
  ],
] as const) {
for (const forceBoundary of ['none', 'preparation', 'delivery'] as const) {
  const force = forceBoundary !== 'none'
  const promptKind = typeof queuedPrompt === 'string' ? 'text' : 'image'
  test(`full QueryEngine ${promptKind}: force boundary = ${forceBoundary}`, async () => {
    ;(globalThis as any).MACRO = { VERSION: 'fixture-version' }
    const firstRequest = gate()
    const releaseFirst = gate()
    attachmentSnapshot = gate()
    attachmentResume = gate()
    let providerCalls = 0
    const submitted: any[] = []
    const submitCalls: unknown[] = []
    const tool = buildTool({
      name: 'QueueProbe', inputSchema: z.strictObject({}),
      isReadOnly: () => true, isConcurrencySafe: () => true,
      async description() { return 'fixture' }, async prompt() { return 'fixture' },
      async validateInput() { return { result: true as const } },
      renderToolUseMessage: () => null, renderToolResultMessage: () => null, renderToolUseErrorMessage: () => null,
      mapToolResultToToolResultBlockParam(_output: unknown, toolUseID: string) {
        return { tool_use_id: toolUseID, type: 'tool_result' as const, content: 'fixture complete' }
      },
      async call() { return { data: 'fixture complete' } },
    } as never)
    queryDeps = {
      uuid: () => 'full-adapter-query', microcompact: async (messages: any) => ({ messages }),
      autocompact: async () => ({ wasCompacted: false, consecutiveFailures: 0 }),
      async *callModel({ messages, signal }: any) {
        providerCalls++
        if (signal.aborted) return
        submitted.push(messages)
        if (submitted.length === 1) {
          firstRequest.release()
          await releaseFirst.promise
          const assistant = createAssistantMessage({ content: 'fixture tool' })
          assistant.message.content = [{ type: 'tool_use', id: 'full-fixture-tool', name: 'QueueProbe', input: {} }]
          assistant.message.stop_reason = 'tool_use'
          yield assistant
        } else {
          const assistant = createAssistantMessage({ content: 'queued prompt handled' })
          assistant.message.stop_reason = 'end_turn'
          yield assistant
        }
      },
    }
    let state = getDefaultAppState()
    let engine!: InstanceType<typeof QueryEngine>
    const appSession = createQueryEngineAppSession({
      cwd: process.cwd(), tools: [tool as any], commands: [], mcpClients: [], agents: [],
      canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      getAppState: () => state, setAppState: update => { state = update(state) },
      initialMessages: [], readFileCache: createFileStateCacheWithSizeLimit(20),
      customSystemPrompt: '', userSpecifiedModel: 'gpt-5.6-terra',
      recordTranscript: async () => null,
      createEngine(config) { engine = new QueryEngine(config); return engine },
    })
    const originalSubmit = appSession.submitMessage
    appSession.submitMessage = (prompt, options) => {
      submitCalls.push(prompt)
      return originalSubmit(prompt, options)
    }
    const controller = createQueryEngineSessionController(appSession)
    const received: any[] = []
    const decoder = new FrameDecoder(MAX_OUTBOUND_FRAME_BYTES)
    server = new SidecarServer({ sessionId: 'fixture-session', engineSessionId: 'fixture-engine', controller, log() {} })
    let queuedId: string | undefined
    let deliveryForceSent = false
    const conn = server.addConnection({ write(data) {
      for (const frame of decoder.push(Buffer.from(data))) {
        if (frame.kind !== 'frame') continue
        const payload = frame.payload as any
        received.push(payload)
        if (
          forceBoundary === 'delivery' &&
          queuedId &&
          !deliveryForceSent &&
          payload.kind === 'event' &&
          payload.event?.type === 'message' &&
          (payload.event.message?.uuid === queuedId ||
            payload.event.message?.attachment?.source_uuid === queuedId)
        ) {
          deliveryForceSent = true
          server!.handleData(
            conn,
            encodeFrame({
              protocolVersion: PROTOCOL_VERSION,
              sessionId: 'fixture-session',
              message: { type: 'prompt.force', requestId: 'force', promptId: queuedId },
            }),
          )
        }
      }
    }, end() {} })
    const send = (message: unknown) => server!.handleData(conn, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId: 'fixture-session', message }))
    send({ type: 'app.submit', requestId: 'first', prompt: 'start' })
    await waitAt(
      firstRequest.promise,
      `first request did not reach scripted model: ${JSON.stringify(received)}`,
    )
    send({ type: 'app.submit', requestId: 'queued', prompt: queuedPrompt })
    queuedId = received.filter(frame => frame.kind === 'queued-prompts.snapshot').at(-1).prompts[0].id
    releaseFirst.release()
    await waitAt(attachmentSnapshot.promise, 'queued preparation did not start')
    if (forceBoundary === 'preparation') {
      send({ type: 'prompt.force', requestId: 'force', promptId: queuedId })
    }
    attachmentResume.release()
    await waitFor(() => !controller.isTurnActive())
    await new Promise(resolve => setTimeout(resolve, 20))
    const result = received.filter(frame => frame.kind === 'event' && frame.event?.type === 'message' && frame.event.message?.type === 'result').at(-1)?.event.message
    console.log(JSON.stringify({ layer: 'QueryEngine plus app-session adapters', force, forceBoundary, deliveryForceSent, forceResult: received.find(frame => frame.kind === 'prompt-force.result'), providerCalls, submittedRequests: submitted.length, submitCalls, queuedRemaining: getCommandQueueSnapshot().length, storedQueuedAttachment: engine.getMessages().some((message: any) => message.attachment?.source_uuid === queuedId), resultSubtype: result?.subtype, resultStopReason: result?.stop_reason }))
    expect(submitCalls).toEqual(
      forceBoundary === 'preparation' ? ['start', queuedPrompt] : ['start'],
    )
    expect(submitted).toHaveLength(2)
    expect(getCommandQueueSnapshot()).toHaveLength(0)
    if (force) {
      if (forceBoundary === 'delivery') {
        expect(deliveryForceSent).toBe(true)
        expect(received.find(frame => frame.kind === 'prompt-force.result')?.ok).toBe(false)
      } else {
        expect(received.find(frame => frame.kind === 'prompt-force.result')?.ok).toBe(true)
      }
      expect(JSON.stringify(submitted[1])).toContain(
        typeof queuedPrompt === 'string' ? queuedPrompt : 'MUST HANDLE IMAGE',
      )
      expect(
        engine.getMessages().filter((message: any) =>
          message.uuid === queuedId || message.attachment?.source_uuid === queuedId,
        ),
      ).toHaveLength(1)
      expect(
        received.filter(frame =>
          frame.kind === 'event' &&
          frame.event?.type === 'message' &&
          frame.event.message?.uuid === queuedId,
        ),
      ).toHaveLength(1)
    } else {
      expect(JSON.stringify(submitted[1])).toContain(
        typeof queuedPrompt === 'string' ? queuedPrompt : 'MUST HANDLE IMAGE',
      )
    }
  })
}
}
