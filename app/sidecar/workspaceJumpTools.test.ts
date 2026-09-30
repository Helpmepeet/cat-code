import { expect, test } from 'bun:test'
import { createWorkspaceJumpTools } from './workspaceJumpTools.js'
import { TurnHandoff } from '../../src/app-runtime/handoff.js'
import type { ToolUseContext } from '../../src/Tool.js'
import type { PeerHostRequester } from './peerHostRequester.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const handle = '8578a013-f8e9-4612-8227-ce2c6921f3cf'
function context() { return { turnHandoff: new TurnHandoff(), toolUseId: 'jump-call' } as ToolUseContext }
function setup(refuse: boolean | 'timeout' = false, cancellation: 'not_accepted' | 'cancelled' | 'lost' = 'lost') {
  const calls: string[] = []
  let reserved: string | null = null
  let unaccepted: string | null = null
  const request: PeerHostRequester = (async (verb: string, args: { operationId?: string }) => {
    calls.push(verb)
    if (verb === 'workspaces.list') return { ok: true, value: { eligible: true, workspaces: [{ handle, name: 'cat-code', path: '/workspace/cat-code' }] } }
    if (verb === 'workspace.jump') {
      expect(reserved).toBe(args.operationId!)
      return refuse ? { ok: false, error: { code: refuse === 'timeout' ? 'timeout' : 'unavailable', message: 'refused' } } : { ok: true, value: { operationId: args.operationId, status: 'accepted' } }
    }
    return cancellation !== 'lost' ? { ok: true, value: { operationId: args.operationId, status: cancellation } } : { ok: false, error: { code: 'unavailable', message: 'no accepted operation' } }
  }) as PeerHostRequester
  const [list, jump] = createWorkspaceJumpTools(request, () => ({ reserve(id) { reserved = id; return true }, release() { reserved = null }, cancelNotAccepted(id) { unaccepted = id } }))
  return { list: list!, jump: jump!, calls, get reserved(): string | null { return reserved }, get unaccepted(): string | null { return unaccepted } }
}

test('main-agent jump reserves before host acceptance and fences the accepted tool exchange', async () => {
  const fixture = setup()
  const ctx = context()
  await fixture.list.call({}, ctx)
  expect(fixture.jump.toAutoClassifierInput({ destination: handle })).toEqual({ action: 'move_this_conversation', destination: '/workspace/cat-code' })
  const result = await fixture.jump.call({ destination: handle }, ctx)
  expect(result.data.ok).toBe(true)
  expect(ctx.turnHandoff!.accepted?.toolUseId).toBe('jump-call')
  expect(ctx.turnHandoff!.accepted?.operationId).toEqual(fixture.reserved ?? undefined)
  expect(fixture.calls).toEqual(['workspaces.list', 'workspace.jump'])
})

test('workers cannot create an operation through an inherited jump tool', async () => {
  const fixture = setup()
  const ctx = context()
  await fixture.list.call({}, ctx)
  ctx.agentId = 'fork-worker' as ToolUseContext['agentId']
  expect((await fixture.jump.call({ destination: handle }, ctx)).data.ok).toBe(false)
  expect(fixture.calls).toEqual(['workspaces.list'])
  expect(fixture.reserved).toBeNull()
})

test('non-timeout error with no cancellation receipt retains source admission', async () => {
  const fixture = setup(true)
  const ctx = context()
  await fixture.list.call({}, ctx)
  expect((await fixture.jump.call({ destination: handle }, ctx)).data.ok).toBe(false)
  expect(fixture.calls).toEqual(['workspaces.list', 'workspace.jump', 'workspace.cancel'])
  expect(ctx.turnHandoff!.requested?.operationId).toEqual(fixture.reserved ?? undefined)
  expect(ctx.turnHandoff!.isValid).toBe(false)
  expect(fixture.reserved).not.toBeNull()
})

test('lost acceptance and cancellation acknowledgements retain the execution fence', async () => {
  const fixture = setup('timeout')
  const ctx = context()
  await fixture.list.call({}, ctx)
  expect((await fixture.jump.call({ destination: handle }, ctx)).data.ok).toBe(false)
  expect(fixture.calls).toEqual(['workspaces.list', 'workspace.jump', 'workspace.cancel'])
  expect(ctx.turnHandoff!.requested?.operationId).toEqual(fixture.reserved ?? undefined)
  expect(ctx.turnHandoff!.isValid).toBe(false)
  expect(fixture.reserved).not.toBeNull()
})

test('authoritative nonacceptance schedules idle settlement while keeping this turn fenced', async () => {
  const fixture = setup('timeout', 'not_accepted')
  const ctx = context()
  await fixture.list.call({}, ctx)
  expect((await fixture.jump.call({ destination: handle }, ctx)).data.ok).toBe(false)
  expect(fixture.unaccepted).toEqual(fixture.reserved)
  expect(ctx.turnHandoff!.requested?.operationId).toEqual(fixture.reserved ?? undefined)
  expect(ctx.turnHandoff!.isValid).toBe(false)
  expect(fixture.reserved).not.toBeNull()
})

test('a published operation cancellation retains the source hold despite a non-timeout error', async () => {
  const fixture = setup(true, 'cancelled')
  const ctx = context()
  await fixture.list.call({}, ctx)
  expect((await fixture.jump.call({ destination: handle }, ctx)).data.ok).toBe(false)
  expect(fixture.unaccepted).toBeNull()
  expect(ctx.turnHandoff!.isValid).toBe(false)
  expect(fixture.reserved).not.toBeNull()
})

test('workspace refusals and rate limits describe their own action without raw host diagnostics', async () => {
  for (const code of ['unavailable', 'rate_limited'] as const) {
    const [list] = createWorkspaceJumpTools((async () => ({ ok: false, error: { code, message: 'raw host diagnostic /secret/path' } })) as PeerHostRequester)
    const result = await list.call({}, context())
    expect(result.data.ok).toBe(false)
    expect(result.data.message).toContain('workspace request')
    expect(result.data.message).not.toContain('not connected')
    expect(result.data.message).not.toContain('peer')
    expect(result.data.message).not.toContain('/secret/path')
  }
})

test('real jump errors fence following effects in a mixed engine tool batch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catcode-jump-tools-'))
  const previousConfig = process.env.CLAUDE_CONFIG_DIR, previousSimple = process.env.CLAUDE_CODE_SIMPLE
  const macroGlobal = globalThis as unknown as { MACRO?: unknown }
  const previousMacro = macroGlobal.MACRO
  const { getCwd } = await import('../../src/utils/cwd.js')
  const shell = await import('../../src/utils/Shell.js')
  const originalCwd = getCwd()
  const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
  try {
    process.env.CLAUDE_CONFIG_DIR = root
    process.env.CLAUDE_CODE_SIMPLE = '1'
    shell.setCwd(root)
    resetSettingsCache()
    await (await import('./workerRuntime.js')).bootstrapWorkerEngine()
    const { buildTool } = await import('../../src/Tool.js')
    const { z } = await import('../../node_modules/zod/v4')
    const { runTools } = await import('../../src/services/tools/toolOrchestration.js')
    const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
    const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.js')
    const { createAssistantMessage } = await import('../../src/utils/messages.js')
    for (const cancellation of ['cancelled', 'lost'] as const) {
      const fixture = setup(true, cancellation)
      let effects = 0
      const effect = buildTool({ name: 'FollowingEffect', inputSchema: z.strictObject({}), maxResultSizeChars: 100,
        description: async () => 'effect', prompt: async () => 'effect', isConcurrencySafe: () => false,
        renderToolUseMessage: () => null, async call() { effects++; return { data: 'effect ran' } },
        mapToolResultToToolResultBlockParam: (data, id) => ({ type: 'tool_result', tool_use_id: id, content: data }),
      })
      let state = getDefaultAppState()
      const ctx = { ...context(), options: { ...context().options, commands: [], debug: false, mainLoopModel: 'gpt-5.6-terra',
        tools: [fixture.jump, effect], verbose: false, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true,
        thinkingConfig: { type: 'disabled' }, agentDefinitions: { activeAgents: [], allAgents: [], allowedAgentTypes: [] } },
        abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(20), getAppState: () => state,
        setAppState: updater => { state = updater(state) }, setInProgressToolUseIDs() {}, setResponseLength() {},
        updateFileHistoryState() {}, updateAttributionState() {}, messages: [],
      } as ToolUseContext
      await fixture.list.call({}, ctx)
      const blocks = [{ type: 'tool_use' as const, name: 'JumpWorkspace', id: 'jump-call', caller: { type: 'direct' as const }, input: { destination: handle } },
        { type: 'tool_use' as const, name: 'FollowingEffect', id: 'later-effect', caller: { type: 'direct' as const }, input: {} }]
      const assistant = createAssistantMessage({ content: blocks })
      const results: Array<{ tool_use_id: string; is_error?: boolean }> = []
      for await (const update of runTools(blocks, [assistant], async (_tool, input) => ({ behavior: 'allow', updatedInput: input }), ctx)) {
        if (update.message?.type === 'user' && Array.isArray(update.message.message.content)) {
          for (const block of update.message.message.content) if (block.type === 'tool_result') results.push(block)
        }
      }
      expect(effects).toBe(0)
      expect(results).toEqual([expect.objectContaining({ tool_use_id: 'jump-call', is_error: true }), expect.objectContaining({ tool_use_id: 'later-effect', is_error: true })])
      expect(ctx.turnHandoff!.isValid).toBe(false)
      expect(fixture.reserved).not.toBeNull()
    }
  } finally {
    shell.setCwd(originalCwd)
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfig
    if (previousSimple === undefined) delete process.env.CLAUDE_CODE_SIMPLE
    else process.env.CLAUDE_CODE_SIMPLE = previousSimple
    resetSettingsCache()
    if (previousMacro === undefined) delete macroGlobal.MACRO
    else macroGlobal.MACRO = previousMacro
    rmSync(root, { recursive: true, force: true })
  }
})
