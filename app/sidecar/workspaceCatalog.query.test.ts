import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AssistantMessage } from '../../src/types/message.js'
import type { PeerHostRequester } from './peerHostRequester.js'
import type { PeerRegistryRow } from '../main/peerRequestPlane.js'
import type { SDKMessage } from '../../src/entrypoints/agentSdkTypes.js'

// Engine suites use persistent module mocks. A fresh runtime keeps this proof
// on the real query/classifier owners when the whole desktop suite runs.
if (process.env.CATCODE_WORKSPACE_CATALOG_TEST_CHILD !== '1') {
  test('catalog query, cancellation and Auto projection use real owners in an isolated runtime', () => {
    const result = Bun.spawnSync([
      process.execPath, '--feature=TRANSCRIPT_CLASSIFIER', '--feature=AUTO_MODE_UPSTREAM_PORT',
      'test', import.meta.path,
    ], { cwd: new URL('../..', import.meta.url).pathname,
      env: { ...process.env, CATCODE_WORKSPACE_CATALOG_TEST_CHILD: '1' },
      stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
  })
} else {
  // All engine settings, transcript and lease owners use isolated state. Only
  // provider output is scripted; metadata and jump acceptance use real owners.
  const root = mkdtempSync(join(tmpdir(), 'workspace-catalog-query-'))
  const previousEnv = Object.fromEntries(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SIMPLE', 'ANTHROPIC_API_KEY', 'CATCODE_SIDECAR_MODEL', 'TEST_ENABLE_SESSION_PERSISTENCE'].map(key => [key, process.env[key]]))
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  process.env.CLAUDE_CODE_SIMPLE = '1'
  process.env.ANTHROPIC_API_KEY = 'isolated-scripted-test-key'
  process.env.CATCODE_SIDECAR_MODEL = 'gpt-6-luna'
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  await (await import('./workerRuntime.js')).bootstrapWorkerEngine()
  const { QueryEngine } = await import('../../src/QueryEngine.js')
  const { createNormalSidecarQueryEngineConfig } = await import('./sessionController.js')
  const { setPeerHostRequester } = await import('./peerHostRequester.js')
  const { setWorkspaceJumpAdmission } = await import('./workspaceJumpTools.js')
  const { WorkspaceJumpCoordinator } = await import('../main/workspaceJumpCoordinator.js')
  const claude = await import('../../src/services/api/claude.js')
  const bootstrap = await import('../../src/bootstrap/state.js')
  const shell = await import('../../src/utils/Shell.js')
  const storage = await import('../../src/utils/sessionStorage.js')
  const { releaseActiveTranscriptLease } = await import('../../src/utils/transcriptLease.js')
  const { asSessionId } = await import('../../src/types/ids.js')
  const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
  const { toolToAPISchema } = await import('../../src/utils/api.js')
  const { clearToolSchemaCache } = await import('../../src/utils/toolSchemaCache.js')
  const { classifyYoloAction, formatActionForClassifier, YOLO_CLASSIFIER_TOOL_NAME } = await import('../../src/utils/permissions/yoloClassifier.js')
  const sideQuery = await import('../../src/utils/sideQuery.js')
  const { enqueue, getCommandQueueSnapshot, resetCommandQueue } = await import('../../src/utils/messageQueueManager.js')

  const previousSession = bootstrap.getSessionId(), previousProject = bootstrap.getSessionProjectDir()
  const previousCwd = bootstrap.getCwdState(), previousProvider = bootstrap.getSessionProvider()
  const previousModel = bootstrap.getMainLoopModelOverride()
  const disposers: Array<() => Promise<void>> = []
  const spies: Array<{ mockRestore(): void }> = []
  beforeEach(async () => {
    resetCommandQueue()
    await releaseActiveTranscriptLease()
    storage.resetProjectForTesting()
    bootstrap.switchSession(asSessionId(randomUUID()), root)
    resetSettingsCache()
    clearToolSchemaCache()
  })
  afterEach(async () => {
    resetCommandQueue()
    for (const spy of spies.splice(0)) spy.mockRestore()
    for (const dispose of disposers.splice(0)) await dispose()
    setPeerHostRequester(null)
    setWorkspaceJumpAdmission(null)
    await storage.flushSessionStorage()
    await releaseActiveTranscriptLease()
    storage.resetProjectForTesting()
    bootstrap.switchSession(asSessionId(previousSession), previousProject)
    bootstrap.setSessionProvider(previousProvider)
    bootstrap.setMainLoopModelOverride(previousModel)
    shell.setCwd(previousCwd)
    resetSettingsCache()
    clearToolSchemaCache()
  })
  afterAll(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  })
  function assistant(content: AssistantMessage['message']['content']): AssistantMessage {
    return { type: 'assistant', uuid: randomUUID(), timestamp: new Date().toISOString(), message: {
      id: randomUUID(), role: 'assistant', model: 'gpt-6-luna', content,
      usage: { input_tokens: 10, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      stop_reason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null,
    } } as AssistantMessage
  }
  async function drain(turn: AsyncIterable<SDKMessage>) {
    const events: SDKMessage[] = []
    for await (const event of turn) events.push(event)
    return events
  }
  async function config() {
    const source = join(root, randomUUID())
    mkdirSync(source)
    const appSessionId = randomUUID()
    const binding = { kind: 'managed' as const, storageId: randomUUID(), storageRootId: randomUUID() }
    const setup = await createNormalSidecarQueryEngineConfig(source, [], { appSessionId, binding })
    disposers.push(() => setup.mcpLifecycle.dispose())
    return { ...setup, source, appSessionId, binding }
  }

  test('first real sidecar query carries recent metadata and jumps directly without a model discovery turn', async () => {
    const setup = await config()
    const target = join(root, 'project')
    mkdirSync(target)
    writeFileSync(join(target, 'CLAUDE.md'), 'CANDIDATE_INSTRUCTIONS_MUST_NOT_LOAD')
    const row: PeerRegistryRow = { appSessionId: setup.appSessionId, engineSessionId: bootstrap.getSessionId(), cwd: setup.source,
      binding: setup.binding, lastAttachedAt: 1, lastMessageSentAt: 1, shutdown: null }
    const generation = randomUUID()
    const coordinator = new WorkspaceJumpCoordinator({
      row: id => id === setup.appSessionId ? row : undefined,
      knownProjects: () => [{ path: target, lastUsedAt: 10 }],
      validateCwd: path => ({ ok: true, realpath: realpathSync(path) }), trustedProjectRoots: async roots => roots,
      host: { getSessionGeneration: () => generation,
        reserveWorkspaceJump: async () => ({ ok: true, value: undefined }), releaseWorkspaceJump() {},
        moveWorkspaceJump: async () => { throw new Error('acceptance must not move') } },
      verifyReady: () => false, control: async () => ({ kind: 'unavailable' }),
    })
    const hostCalls: string[] = []
    let selectedHandle = ''
    setPeerHostRequester((async (verb, args) => {
      hostCalls.push(verb)
      const result = await coordinator.handleRequest(setup.appSessionId, { verb, ...args } as never)
      if (result.ok && 'workspaces' in result.value) selectedHandle = result.value.workspaces[0]!.handle
      return result
    }) as PeerHostRequester)
    setWorkspaceJumpAdmission({ reserve: () => true, release() {}, cancelNotAccepted() {} })
    const jump = setup.queryEngineConfig.tools.find(tool => tool.name === 'JumpWorkspace')!
    const schemaOptions = { tools: setup.queryEngineConfig.tools, agents: [], model: 'gpt-6-luna', getToolPermissionContext: async () => setup.appStateStore.getState().toolPermissionContext }
    const before = JSON.stringify(await toolToAPISchema(jump, schemaOptions))
    let providerCalls = 0
    let deliveredInstructions: string | undefined
    let deliveredTools: readonly { name: string }[] = []
    spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* (request) {
      providerCalls++
      deliveredInstructions = request.openAIInstructionAssembly?.instructions
      deliveredTools = request.tools
      yield assistant(selectedHandle
        ? [{ type: 'tool_use', id: 'direct-jump', name: 'JumpWorkspace', input: { destination: selectedHandle } }]
        : [{ type: 'text', text: 'No initial catalog was supplied.' }])
    }))
    const projections: unknown[] = []
    const runtime = new QueryEngine({ ...setup.queryEngineConfig, thinkingConfig: { type: 'disabled' },
      canUseTool: async (tool, input) => { projections.push(tool.toAutoClassifierInput?.(input as never)); return { behavior: 'allow', updatedInput: input } },
    })
    const events = await drain(runtime.submitMessage('What is project? Reply in chat only; do not edit files.'))
    expect(providerCalls).toBe(1)
    expect(deliveredInstructions).toContain(JSON.stringify({ handle: selectedHandle, name: 'project', path: realpathSync(target) }))
    expect(deliveredInstructions).not.toContain('CANDIDATE_INSTRUCTIONS_MUST_NOT_LOAD')
    expect(deliveredInstructions).toContain('do not by themselves prohibit selecting a workspace')
    expect(deliveredTools).toContain(jump)
    expect(hostCalls).toEqual(['workspaces.list', 'workspace.jump'])
    expect(projections).toContainEqual({ action: 'move_this_conversation', destination: realpathSync(target) })
    expect(events.findLast(event => event.type === 'result')).toMatchObject({ type: 'result', subtype: 'handoff' })
    expect(coordinator.snapshot(setup.appSessionId)?.phase).toBe('accepted')
    expect(runtime.getMessages().flatMap(message => message.type === 'assistant' ? message.message.content.filter(block => block.type === 'tool_use').map(block => block.name) : [])).toEqual(['JumpWorkspace'])
    clearToolSchemaCache()
    expect(JSON.stringify(await toolToAPISchema(jump, schemaOptions))).toBe(before)

    // Ordinary policy may base-allow the host action. When policy does route it
    // through Auto, the real classifier must receive the destination, not UUIDs.
    let classifierRequest = ''
    spies.push(spyOn(sideQuery, 'sideQuery').mockImplementation(async request => {
      classifierRequest = JSON.stringify(request.messages)
      return { ...assistant([{ type: 'tool_use', id: 'verdict', name: YOLO_CLASSIFIER_TOOL_NAME, input: { shouldBlock: false } }]).message, type: 'message' } as never
    }))
    const verdict = await classifyYoloAction([], formatActionForClassifier('JumpWorkspace', { destination: selectedHandle }),
      setup.queryEngineConfig.tools, { ...setup.appStateStore.getState().toolPermissionContext, mode: 'auto' }, new AbortController().signal)
    expect(verdict.shouldBlock).toBe(false)
    expect(classifierRequest).toContain(realpathSync(target))
    expect(classifierRequest).toContain('move_this_conversation')
    expect(classifierRequest).not.toContain(selectedHandle)
  })

  test.each(['throw', 'reject'] as const)('runtime metadata %s preserves ordinary query and submitted input', async failure => {
    const setup = await config()
    let providerCalls = 0
    spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
      providerCalls++
      yield assistant([{ type: 'text', text: 'ordinary answer' }])
    }))
    const runtime = new QueryEngine({ ...setup.queryEngineConfig, thinkingConfig: { type: 'disabled' },
      canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
      getRuntimeSystemPromptAddendum: () => {
        if (failure === 'throw') throw new Error('metadata unavailable')
        return Promise.reject(new Error('metadata unavailable'))
      },
    })
    const events = await drain(runtime.submitMessage('Answer normally.'))
    expect(providerCalls).toBe(1)
    expect(events.findLast(event => event.type === 'result')).toMatchObject({ subtype: 'success', result: 'ordinary answer' })
    expect(runtime.getMessages().filter(message => message.type === 'user' && message.message.content === 'Answer normally.')).toHaveLength(1)
  })

  test('Stop during automatic observation settles without a provider call or late cache seeding, then ordinary input works', async () => {
    const setup = await config()
    let observe!: () => void
    const entered = new Promise<void>(resolve => { observe = resolve })
    let finish!: (value: unknown) => void
    let observations = 0
    setPeerHostRequester((async () => { observations++; observe(); return await new Promise<unknown>(resolve => { finish = resolve }) }) as PeerHostRequester)
    let providerCalls = 0
    spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* (request) {
      providerCalls++
      expect(request.openAIInstructionAssembly?.instructions).not.toContain('/projects/late')
      yield assistant([{ type: 'text', text: 'recovered' }])
    }))
    const runtime = new QueryEngine({ ...setup.queryEngineConfig, thinkingConfig: { type: 'disabled' }, canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }) })
    const turn = drain(runtime.submitMessage('What is late-project?'))
    await entered
    runtime.interrupt('user-stop')
    const stopped = await Promise.race([turn, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Stop waited for metadata')), 1000))])
    expect(providerCalls).toBe(0)
    expect(stopped.findLast(event => event.type === 'result')).toMatchObject({ subtype: 'interrupted' })
    expect(runtime.getMessages().filter(message => message.type === 'user' && message.message.content === 'What is late-project?')).toHaveLength(1)
    const handle = randomUUID()
    finish({ ok: true, value: { eligible: true, workspaces: [{ handle, name: 'late-project', path: '/projects/late' }] } })
    await Promise.resolve()
    expect(setup.queryEngineConfig.tools.find(tool => tool.name === 'JumpWorkspace')!.toAutoClassifierInput!({ destination: handle } as never)).toMatchObject({ destination: 'unavailable' })
    runtime.refreshAbortController()
    const recovered = await drain(runtime.submitMessage('Reply only: recovered.'))
    expect(recovered.findLast(event => event.type === 'result')).toMatchObject({ subtype: 'success', result: 'recovered' })
    expect(providerCalls).toBe(1)
    expect(observations).toBe(1)
  })

  test('destination continuation leaves queued user input for a later turn across tool rounds', async () => {
    const setup = await config()
    const readTool = setup.queryEngineConfig.tools.find(tool => tool.name === 'Read')
    expect(readTool).toBeDefined()
    const firstPath = join(setup.source, 'continuation-tool-one.txt')
    const secondPath = join(setup.source, 'continuation-tool-two.txt')
    writeFileSync(firstPath, 'CONTINUATION_TOOL_RESULT_ONE')
    writeFileSync(secondPath, 'CONTINUATION_TOOL_RESULT_TWO')

    const queuedPrompt = 'QUEUED_AFTER_WORKSPACE_CONTINUATION'
    enqueue({ mode: 'prompt', value: queuedPrompt, uuid: randomUUID() })

    let providerCalls = 0
    const requestBodies: string[] = []
    spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* (request) {
      providerCalls++
      requestBodies.push(JSON.stringify({
        messages: request.messages,
        inputMessages: request.openAIInstructionAssembly?.inputMessages,
      }))
      if (providerCalls === 1) {
        yield assistant([{
          type: 'tool_use',
          id: 'continuation-read-one',
          name: 'Read',
          input: { file_path: firstPath },
        }])
      } else if (providerCalls === 2) {
        yield assistant([{
          type: 'tool_use',
          id: 'continuation-read-two',
          name: 'Read',
          input: { file_path: secondPath },
        }])
      } else {
        yield assistant([{ type: 'text', text: 'Both continuation reads completed.' }])
      }
    }))

    const runtime = new QueryEngine({
      ...setup.queryEngineConfig,
      thinkingConfig: { type: 'disabled' },
      canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
    })
    const events = await drain(
      runtime.continueHandoff(randomUUID(), { uuid: randomUUID() }),
    )

    expect(events.findLast(event => event.type === 'result')).toMatchObject({
      type: 'result',
      subtype: 'success',
    })
    expect(providerCalls).toBe(3)
    expect(requestBodies[1]).toContain('CONTINUATION_TOOL_RESULT_ONE')
    expect(requestBodies[2]).toContain('CONTINUATION_TOOL_RESULT_TWO')
    expect(requestBodies.every(body => !body.includes(queuedPrompt))).toBe(true)
    expect(getCommandQueueSnapshot()).toMatchObject([
      { mode: 'prompt', value: queuedPrompt },
    ])
  })
}
