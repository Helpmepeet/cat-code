import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { z } from 'zod/v4'
import type { Tool, ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import type { PermissionDecision } from './PermissionResult.js'
import {
  createAutoModePermissionObservationContext,
  resolveInitialPermissionOccurrence,
} from './autoModeObservation.js'

const classifyYoloAction = mock()
const actualYoloClassifier = await import('./yoloClassifier.js')
mock.module('./yoloClassifier.js', () => ({
  ...actualYoloClassifier,
  classifyYoloAction,
  formatActionForClassifier: () => ({ role: 'assistant', content: [] }),
}))

const { hasPermissionsToUseTool } = await import('./permissions.js')

type ObservationRun = {
  decision?: PermissionDecision
  error?: unknown
  events: unknown[]
}

function permissionContext(
  overrides: Partial<ToolPermissionContext> = {},
): ToolPermissionContext {
  return {
    mode: 'auto',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    ...overrides,
  }
}

function toolUseContext(
  permissionContext: ToolPermissionContext,
  denialTracking?: { consecutiveDenials: number; totalDenials: number },
): ToolUseContext {
  let state = { toolPermissionContext: permissionContext, denialTracking }
  return {
    abortController: new AbortController(),
    getAppState: () => state,
    setAppState: update => {
      state = update(state)
    },
    messages: [],
    options: { tools: [] },
  } as unknown as ToolUseContext
}

function tool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: 'UnlistedTool',
    inputSchema: z.object({}),
    checkPermissions: async () => ({ behavior: 'ask', message: 'approval' }),
    ...overrides,
  } as unknown as Tool
}

async function observe(
  testedTool: Tool,
  context: ToolUseContext,
  forceDecision?: PermissionDecision,
): Promise<ObservationRun> {
  const events: unknown[] = []
  const observation = createAutoModePermissionObservationContext({
    writer: event => events.push(event),
    toolUseId: 'tool-1',
    toolKind: 'other',
    effectiveAutoMode: 'auto',
    createAttemptId: () => 'attempt-1',
  })
  if (forceDecision !== undefined) observation?.markRoute('forced')
  try {
    const decision = await resolveInitialPermissionOccurrence({
      observer: observation?.observer ?? null,
      forceDecision,
      getPermissionResult: () =>
        hasPermissionsToUseTool(
          testedTool,
          {},
          context,
          { message: { id: 'message-1' } } as never,
          'tool-1',
          undefined,
          observation,
        ),
      finishResult: result => observation!.finishResult(result.behavior),
      finishError: () => observation!.finishError(),
    })
    return { decision, events }
  } catch (error) {
    return { error, events }
  }
}

function end(run: ObservationRun): Record<string, unknown> {
  return run.events.at(-1) as Record<string, unknown>
}

beforeEach(() => {
  classifyYoloAction.mockReset()
})

describe('auto-mode permission observation core routes', () => {
  test('records forced allow and deny without calling the core checker', async () => {
    const context = toolUseContext(permissionContext())
    const forcedAllow = { behavior: 'allow', updatedInput: {} } as PermissionDecision
    const allowed = await observe(tool(), context, forcedAllow)
    expect(allowed.decision).toBe(forcedAllow)
    expect(end(allowed)).toMatchObject({ route: 'forced', raw_result: 'allow' })

    const forcedDeny = { behavior: 'deny', message: 'forced' } as PermissionDecision
    const denied = await observe(tool(), context, forcedDeny)
    expect(denied.decision).toBe(forcedDeny)
    expect(end(denied)).toMatchObject({ route: 'forced', raw_result: 'deny' })
    expect(classifyYoloAction).not.toHaveBeenCalled()
  })

  test('records base rule decisions and interaction guards', async () => {
    const denied = await observe(
      tool(),
      toolUseContext(permissionContext({ alwaysDenyRules: { session: ['UnlistedTool'] } })),
    )
    expect(end(denied)).toMatchObject({
      route: 'base',
      disposition: 'policy_blocked',
    })

    const bypassed = await observe(
      tool({ checkPermissions: async () => ({ behavior: 'passthrough' }) }),
      toolUseContext(permissionContext({ mode: 'bypassPermissions' })),
    )
    expect(end(bypassed)).toMatchObject({
      route: 'base',
      raw_result: 'allow',
    })

    const guarded = await observe(
      tool({ requiresUserInteraction: () => true }),
      toolUseContext(permissionContext()),
    )
    expect(guarded.decision?.behavior).toBe('ask')
    expect(end(guarded)).toMatchObject({ route: 'guard', raw_result: 'ask' })
  })

  test('records accept-edits and allowlist fast paths without a classifier call', async () => {
    const acceptEdits = await observe(
      tool({
        checkPermissions: async (_input, context) => ({
          behavior:
            context.getAppState().toolPermissionContext.mode === 'acceptEdits'
              ? 'allow'
              : 'ask',
        }),
      }),
      toolUseContext(permissionContext()),
    )
    expect(end(acceptEdits)).toMatchObject({
      route: 'accept_edits',
      raw_result: 'allow',
    })

    const allowlisted = await observe(
      tool({ name: 'Sleep' }),
      toolUseContext(permissionContext()),
    )
    expect(end(allowlisted)).toMatchObject({
      route: 'allowlist',
      raw_result: 'allow',
    })
    expect(classifyYoloAction).not.toHaveBeenCalled()
  })

  test('records stage 1 and stage 2 classifier outcomes and ask fallback', async () => {
    classifyYoloAction.mockImplementationOnce(async (...args: unknown[]) => {
      const observer = args[5] as {
        enterStage(stage: 'fast' | 'thinking'): void
        resolveStage(stage: 'fast' | 'thinking', result: { should_block: boolean }): void
      }
      observer.enterStage('fast')
      observer.resolveStage('fast', { should_block: false })
      return { shouldBlock: false, reason: 'safe' }
    })
    const stage1 = await observe(tool(), toolUseContext(permissionContext()))
    expect(end(stage1)).toMatchObject({ route: 'stage1', raw_result: 'allow' })

    classifyYoloAction.mockImplementationOnce(async (...args: unknown[]) => {
      const observer = args[5] as {
        enterStage(stage: 'fast' | 'thinking'): void
        resolveStage(stage: 'fast' | 'thinking', result: { should_block: boolean }): void
      }
      observer.enterStage('fast')
      observer.resolveStage('fast', { should_block: true })
      observer.enterStage('thinking')
      observer.resolveStage('thinking', { should_block: false })
      return { shouldBlock: false, reason: 'safe after review' }
    })
    const stage2Allow = await observe(tool(), toolUseContext(permissionContext()))
    expect(end(stage2Allow)).toMatchObject({
      route: 'stage2',
      raw_result: 'allow',
    })

    classifyYoloAction.mockImplementationOnce(async (...args: unknown[]) => {
      const observer = args[5] as {
        enterStage(stage: 'fast' | 'thinking'): void
        resolveStage(stage: 'fast' | 'thinking', result: { should_block: boolean }): void
      }
      observer.enterStage('fast')
      observer.resolveStage('fast', { should_block: true })
      observer.enterStage('thinking')
      observer.resolveStage('thinking', { should_block: true })
      return {
        shouldBlock: true,
        reason: 'blocked',
        category: { kind: 'built_in', id: 'filesystem' },
      }
    })
    const stage2 = await observe(tool(), toolUseContext(permissionContext()))
    expect(end(stage2)).toMatchObject({
      route: 'stage2',
      raw_result: 'deny',
      disposition: 'policy_blocked',
      primary_category: { kind: 'built_in', id: 'filesystem' },
    })

    classifyYoloAction.mockImplementationOnce(async (...args: unknown[]) => {
      const observer = args[5] as {
        enterStage(stage: 'fast' | 'thinking'): void
        resolveStage(stage: 'fast' | 'thinking', result: { should_block: boolean }): void
      }
      observer.enterStage('fast')
      observer.resolveStage('fast', { should_block: true })
      observer.enterStage('thinking')
      observer.resolveStage('thinking', { should_block: true })
      return { shouldBlock: true, reason: 'blocked' }
    })
    const fallback = await observe(
      tool(),
      toolUseContext(permissionContext(), {
        consecutiveDenials: 2,
        totalDenials: 2,
      }),
    )
    expect(fallback.decision?.behavior).toBe('ask')
    expect(end(fallback)).toMatchObject({
      route: 'stage2',
      raw_result: 'ask',
      disposition: 'review_required',
    })
  })

  test('preserves typed context-limit and user-abort outcomes', async () => {
    classifyYoloAction.mockImplementationOnce(async (...args: unknown[]) => {
      const observer = args[5] as {
        enterStage(stage: 'fast' | 'thinking'): void
        resolveStage(
          stage: 'fast' | 'thinking',
          result: { failure: 'context_limit' },
        ): void
      }
      observer.enterStage('fast')
      observer.resolveStage('fast', { failure: 'context_limit' })
      return {
        shouldBlock: true,
        unavailable: true,
        transcriptTooLong: true,
        reason: 'context limit',
      }
    })
    const limited = await observe(
      tool(),
      toolUseContext(permissionContext({ shouldAvoidPermissionPrompts: true })),
    )
    expect(limited.error).toBeInstanceOf(Error)
    expect(end(limited)).toMatchObject({
      raw_result: 'throw',
      disposition: 'operational_error',
      cause: 'context_limit',
    })

    const context = toolUseContext(permissionContext())
    classifyYoloAction.mockImplementationOnce(async (...args: unknown[]) => {
      const observer = args[5] as {
        enterStage(stage: 'fast' | 'thinking'): void
        resolveStage(
          stage: 'fast' | 'thinking',
          result: { failure: 'interrupted' },
        ): void
      }
      observer.enterStage('fast')
      observer.resolveStage('fast', { failure: 'interrupted' })
      context.abortController.abort()
      return { shouldBlock: true, unavailable: true, reason: 'interrupted' }
    })
    const aborted = await observe(tool(), context)
    expect(end(aborted)).toMatchObject({
      raw_result: 'deny',
      disposition: 'cancelled',
      cause: 'interrupted',
    })
  })
})
