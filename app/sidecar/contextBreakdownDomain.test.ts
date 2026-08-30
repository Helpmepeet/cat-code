import { describe, expect, mock, test } from 'bun:test'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import type { Tools, ToolUseContext } from '../../src/Tool.js'
import type { AgentDefinitionsResult } from '../../src/tools/AgentTool/loadAgentsDir.js'
import type { ContextData } from '../../src/utils/analyzeContext.js'
import type { LogOption, SerializedMessage } from '../../src/types/logs.js'
import {
  createRealContextBreakdownExecutor,
  createSidecarContextBreakdownDomain,
  projectContextBreakdown,
  type ContextBreakdownInput,
} from './contextBreakdownDomain.js'
import { DESKTOP_SYSTEM_PROMPT_ADDENDUM } from './desktopSystemPrompt.js'
import type { ContextBreakdownSnapshot } from '../shared/protocol.js'

/**
 * Shaped like REAL `analyzeContextUsage` output, trailing pseudo-categories
 * included. The engine appends `Free space` unconditionally
 * (`src/utils/analyzeContext.ts:1183`) and `Autocompact buffer` under
 * auto-compact (`:1166`); neither is marked `isDeferred`. A hand-trimmed fixture
 * that omitted them is what let those two ship as legend rows.
 */
const ENGINE_OUTPUT: ContextBreakdownInput = {
  categories: [
    { name: 'System prompt', tokens: 4_200, color: 'promptBorder' },
    { name: 'System tools', tokens: 8_600, color: 'inactive' },
    { name: 'MCP tools (deferred)', tokens: 9_000, color: 'inactive', isDeferred: true },
    { name: 'Messages', tokens: 21_000, color: 'purple_FOR_SUBAGENTS_ONLY' },
    { name: 'Autocompact buffer', tokens: 17_400, color: 'inactive' },
    { name: 'Free space', tokens: 148_800, color: 'promptBorder' },
  ],
  // Deliberately NOT the sum of the categories: the engine prefers the API's
  // fresh-input count when one exists (`analyzeContext.ts:1199-1204`).
  totalTokens: 31_500,
  maxTokens: 200_000,
  model: 'gpt-5.6-luna',
}

describe('projectContextBreakdown', () => {
  test('strips the categories that describe UNUSED window', () => {
    const snapshot = projectContextBreakdown(ENGINE_OUTPUT)
    expect(snapshot.categories.map(c => c.label)).toEqual([
      'System prompt',
      'System tools',
      'MCP tools (deferred)',
      'Messages',
    ])
    // Both would otherwise paint a segment AND a legend row, and `Free space`
    // carries `promptBorder` — the same hue as System prompt.
    expect(snapshot.categories.some(c => c.label === 'Free space')).toBe(false)
    expect(snapshot.categories.some(c => c.label === 'Autocompact buffer')).toBe(
      false,
    )
  })

  test('Free is the engine\'s own remainder, not window minus usedTokens', () => {
    const snapshot = projectContextBreakdown(ENGINE_OUTPUT)
    expect(snapshot.freeTokens).toBe(148_800)
    // The subtraction this replaced would have printed 168,500 — wrong by the
    // reserved buffer and by the API-vs-estimate basis difference.
    expect(snapshot.freeTokens).not.toBe(
      ENGINE_OUTPUT.maxTokens - ENGINE_OUTPUT.totalTokens,
    )
  })

  test('keeps the manual Compact buffer, which /context does show', () => {
    const snapshot = projectContextBreakdown({
      ...ENGINE_OUTPUT,
      categories: [
        { name: 'Messages', tokens: 21_000, color: 'purple_FOR_SUBAGENTS_ONLY' },
        { name: 'Compact buffer', tokens: 3_000, color: 'inactive' },
        { name: 'Free space', tokens: 176_000, color: 'promptBorder' },
      ],
    })
    expect(snapshot.categories.map(c => c.label)).toEqual([
      'Messages',
      'Compact buffer',
    ])
  })

  test('deferred categories keep their flag for the renderer to exclude', () => {
    const snapshot = projectContextBreakdown(ENGINE_OUTPUT)
    const deferred = snapshot.categories.filter(c => c.deferred)
    expect(deferred.map(c => c.label)).toEqual(['MCP tools (deferred)'])
  })

  test('an analysis with no Free space category reports null rather than 0', () => {
    const snapshot = projectContextBreakdown({
      ...ENGINE_OUTPUT,
      categories: [{ name: 'Messages', tokens: 21_000, color: 'claude' }],
    })
    expect(snapshot.freeTokens).toBeNull()
  })
})

const SNAPSHOT: ContextBreakdownSnapshot = projectContextBreakdown(ENGINE_OUTPUT)

describe('context breakdown domain', () => {
  test('passes the engine analysis through untouched', async () => {
    const domain = createSidecarContextBreakdownDomain({
      executor: { analyze: async () => SNAPSHOT },
    })
    expect(await domain.snapshot()).toEqual(SNAPSHOT)
  })

  test('a session with no transcript yet reports null, not an empty breakdown', async () => {
    const domain = createSidecarContextBreakdownDomain({
      executor: { analyze: async () => null },
    })
    expect(await domain.snapshot()).toBeNull()
  })

  // Display degrades gracefully: an analyzer throw must cost the popover its
  // breakdown, never the connection.
  test('an analyzer failure degrades to null and reports the error', async () => {
    const seen: unknown[] = []
    const domain = createSidecarContextBreakdownDomain({
      executor: {
        analyze: async () => {
          throw new Error('tokenizer unavailable')
        },
      },
      onError: error => seen.push(error),
    })
    expect(await domain.snapshot()).toBeNull()
    expect(seen).toHaveLength(1)
    expect((seen[0] as Error).message).toBe('tokenizer unavailable')
  })
})

function fixtureLog(): LogOption {
  const message: SerializedMessage = {
    type: 'user',
    uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    timestamp: '2026-08-30T00:00:00.000Z',
    message: { role: 'user', content: 'fixture transcript line' },
    cwd: '/tmp/fixture-not-a-real-session',
    userType: 'external',
    sessionId: '11111111-2222-4333-8444-555555555555',
    version: '0.0.0',
  }
  return {
    date: '2026-08-30',
    messages: [message],
    value: 0,
    created: new Date('2026-08-30T00:00:00.000Z'),
    modified: new Date('2026-08-30T00:00:00.000Z'),
    firstPrompt: 'fixture transcript line',
    messageCount: 1,
    isSidechain: false,
  }
}

const realSessionStorage = await import('../../src/utils/sessionStorage.js')
mock.module('../../src/utils/sessionStorage.js', () => ({
  ...realSessionStorage,
  getLastSessionLog: async () => fixtureLog(),
}))

// Untyped on purpose: typing this as `Pick<ToolUseContext, 'options'>` makes
// tsc narrow it to `never` at the assertion site below (the reassignment
// happens inside the mocked-module closure, which the checker can't see is
// what runs). Cast only at the point of use instead.
let capturedToolUseContext: unknown
const FAKE_ANALYSIS: ContextData = {
  categories: [{ name: 'System prompt', tokens: 4_200, color: 'promptBorder' }],
  totalTokens: 4_200,
  maxTokens: 200_000,
  model: 'gpt-5.6-luna',
} as unknown as ContextData

const realAnalyzeContext = await import('../../src/utils/analyzeContext.js')
mock.module('../../src/utils/analyzeContext.js', () => ({
  ...realAnalyzeContext,
  analyzeContextUsage: async (
    ..._args: unknown[]
  ): Promise<ContextData> => {
    capturedToolUseContext = _args[6]
    return FAKE_ANALYSIS
  },
}))

describe('createRealContextBreakdownExecutor — desktop system-prompt addendum', () => {
  test('feeds the desktop appendSystemPrompt addendum into analyzeContextUsage, so countSystemTokens measures it', async () => {
    capturedToolUseContext = undefined
    const executor = createRealContextBreakdownExecutor({
      tools: [] as unknown as Tools,
      agentDefinitions: { activeAgents: [], allAgents: [] } as AgentDefinitionsResult,
      getToolPermissionContext: () => getDefaultAppState().toolPermissionContext,
      getMainLoopModel: () => 'gpt-5.6-luna',
    })

    const result = await executor.analyze()

    expect(result).not.toBeNull()
    const toolUseContext = capturedToolUseContext as
      | Pick<ToolUseContext, 'options'>
      | undefined
    expect(toolUseContext?.options.appendSystemPrompt).toBe(
      DESKTOP_SYSTEM_PROMPT_ADDENDUM,
    )
  })
})
