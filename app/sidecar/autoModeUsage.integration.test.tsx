import { afterEach, expect, mock, test } from 'bun:test'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { renderToStaticMarkup } from 'react-dom/server'
import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { asSessionId } from '../../src/types/ids.js'
import type { Tool, ToolPermissionContext, ToolUseContext } from '../../src/Tool.js'
import { UsageAutoMode } from '../renderer/src/UsageAutoMode.js'
import { fitUsageDashboardSnapshot } from './usageSummary.js'
import { parseUsageCollectionResult } from '../shared/usageStatsWorker.js'
import { getSessionId, getSessionProjectDir, switchSession } from '../../src/bootstrap/state.js'
import { createUserMessage } from '../../src/utils/messages.js'
import {
  flushCurrentTranscriptDurably,
  getTranscriptPathForSession,
  recordTranscript,
  resetProjectForTesting,
} from '../../src/utils/sessionStorage.js'
import { releaseActiveTranscriptLease } from '../../src/utils/transcriptLease.js'
import { collectIndexedUsage } from '../../src/utils/statsUsageIndex.js'

const classifyYoloAction = mock()
const actualYoloClassifier = await import('../../src/utils/permissions/yoloClassifier.js')
mock.module('../../src/utils/permissions/yoloClassifier.js', () => ({
  ...actualYoloClassifier,
  classifyYoloAction,
  formatActionForClassifier: () => ({ role: 'assistant', content: [] }),
}))
const { createAppRuntimeCanUseTool } = await import('../../src/app-runtime/appRuntimeCanUseTool.js')

const originalSessionId = getSessionId()
const originalProjectDir = getSessionProjectDir()
const originalPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE

let root = ''
let transcript = ''

function permissionContext(): ToolPermissionContext {
  return {
    mode: 'auto',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  }
}

async function writeOrdinaryAssistantRow(sessionId: string): Promise<void> {
  await appendFile(transcript, `${JSON.stringify({
    type: 'assistant',
    sessionId,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      id: randomUUID(),
      model: 'integration-model',
      usage: { input_tokens: 5, output_tokens: 3 },
      content: [{ type: 'tool_use', id: 'ordinary-tool', name: 'Bash' }],
    },
  })}\n`)
}

afterEach(async () => {
  classifyYoloAction.mockReset()
  await releaseActiveTranscriptLease()
  resetProjectForTesting()
  switchSession(asSessionId(originalSessionId), originalProjectDir)
  if (originalPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  else process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalPersistence
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
  transcript = ''
})

const featureTest = feature('TRANSCRIPT_CLASSIFIER') ? test : test.skip

featureTest('persists one production auto-mode occurrence through the index, worker, and renderer without changing ordinary usage', async () => {
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  root = await mkdtemp(join(tmpdir(), 'auto-mode-usage-integration-'))
  const sessionId = randomUUID()
  resetProjectForTesting()
  switchSession(asSessionId(sessionId), root)
  await recordTranscript([createUserMessage({ content: 'fixture owner', uuid: randomUUID() })])
  await flushCurrentTranscriptDurably()
  transcript = getTranscriptPathForSession(sessionId)
  await writeOrdinaryAssistantRow(sessionId)

  const indexPath = join(root, 'index-v9.sqlite')
  const indexOptions = { path: indexPath, deadline: Date.now() + 60_000 }
  const before = await collectIndexedUsage([transcript], new Date().toISOString(), indexOptions)
  const beforeRange = before.ranges['7d']
  const input = { command: 'echo original' }
  classifyYoloAction.mockImplementationOnce(async (...args: unknown[]) => {
    const observer = args[5] as {
      enterStage(stage: 'fast' | 'thinking'): void
      resolveStage(stage: 'fast' | 'thinking', result: { should_block: boolean }): void
    }
    observer.enterStage('fast')
    observer.resolveStage('fast', { should_block: false })
    return { shouldBlock: false, reason: 'fixture safe' }
  })
  const useTool = createAppRuntimeCanUseTool({
    getPermissionRequestHandler: () => undefined,
  })
  let appState = { toolPermissionContext: permissionContext() }
  const context = {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: (update: (state: typeof appState) => typeof appState) => {
      appState = update(appState)
    },
    messages: [],
    options: { tools: [] },
  } as unknown as ToolUseContext
  const testedTool = {
    name: 'Bash',
    inputSchema: z.object({ command: z.string() }),
    checkPermissions: async () => ({ behavior: 'ask' as const, message: 'approval' }),
  } as unknown as Tool

  const result = await useTool(
    testedTool,
    input,
    context,
    { message: { id: 'assistant-message' } } as never,
    'auto-tool',
  )
  expect(result).toMatchObject({ behavior: 'allow' })
  expect(result.updatedInput).toBe(input)
  expect(classifyYoloAction).toHaveBeenCalledTimes(1)

  const persisted = (await readFile(transcript, 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>)
  const observationRows = persisted.filter(row =>
    row.type === 'system' &&
    ['auto_permission_start', 'auto_permission_stage', 'auto_permission_end'].includes(row.subtype as string),
  )
  const capabilityIndex = persisted.findIndex(row =>
    row.type === 'system' && row.subtype === 'auto_permission_capability')
  expect(capabilityIndex).toBeGreaterThanOrEqual(0)
  expect(capabilityIndex).toBeLessThan(
    persisted.findIndex(row => row.subtype === 'auto_permission_start'),
  )
  expect(observationRows.map(row => row.subtype)).toEqual([
    'auto_permission_start',
    'auto_permission_stage',
    'auto_permission_stage',
    'auto_permission_end',
  ])
  expect(observationRows.at(0)).toMatchObject({
    tool_use_id: 'auto-tool',
    tool_kind: 'bash',
    auto_mode: 'auto',
    initial: true,
  })
  expect(observationRows.at(-1)).toMatchObject({
    route: 'stage1',
    raw_result: 'allow',
    disposition: 'allowed',
  })

  const asOf = new Date().toISOString()
  const produced = await collectIndexedUsage([transcript], asOf, indexOptions)
  const range = produced.ranges['7d']
  expect(range.autoMode.allTools.outcomes.allowed).toBe(1)
  expect(range.autoMode.commands.outcomes.allowed).toBe(1)
  expect(range.autoMode.routes).toEqual([{ route: 'stage1', outcome: 'allowed', count: 1 }])
  expect(range.autoMode.commands.coverage.state).toBe('complete')
  expect(range.tokens).toEqual(beforeRange.tokens)
  expect(range.requests).toBe(beforeRange.requests)
  expect(range.sessions).toBe(beforeRange.sessions)
  expect(range.records).toBe(beforeRange.records)
  expect(range.timing).toEqual(beforeRange.timing)

  fitUsageDashboardSnapshot(produced)
  const parsed = parseUsageCollectionResult({ type: 'usage', version: 1, snapshot: produced })
  expect(parsed).not.toBeNull()
  const html = renderToStaticMarkup(<UsageAutoMode summary={parsed!.snapshot.ranges['7d']}/>)
  expect(html).toContain('Decision flow for 1 recorded automatic permission attempt')
  expect(html).toContain('Stage 1')
  expect(html).toContain('Allowed')
  expect(html).toContain('0 / 1 commands')
  expect(html).toContain('0.0%')

  await appendFile(transcript, `${observationRows.map(row => JSON.stringify(row)).join('\n')}\n`)
  const replayed = await collectIndexedUsage([transcript], asOf, indexOptions)
  expect(replayed.ranges['7d'].autoMode).toEqual(produced.ranges['7d'].autoMode)
  let warmReads = 0
  const warm = await collectIndexedUsage([transcript], new Date(Date.parse(asOf) + 1_000).toISOString(), {
    ...indexOptions,
    onReadSource: () => { warmReads++ },
  })
  expect(warmReads).toBe(0)
  expect(warm.ranges['7d'].autoMode.allTools.outcomes.allowed).toBe(1)

  await appendFile(transcript, `${JSON.stringify({
    type: 'system',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    subtype: 'auto_permission_end',
    attempt_id: 'malformed-attempt',
    raw_result: 'deny',
    disposition: 'not-a-disposition',
    route: 'base',
    raw_input: 'must not be retained',
  })}\n`)
  const malformed = await collectIndexedUsage([transcript], new Date().toISOString(), indexOptions)
  const malformedRange = malformed.ranges['7d']
  expect(malformedRange.tokens).toEqual(beforeRange.tokens)
  expect(malformedRange.requests).toBe(beforeRange.requests)
  expect(malformedRange.sessions).toBe(beforeRange.sessions)
  expect(malformedRange.records).toBe(beforeRange.records)
  expect(malformedRange.timing).toEqual(beforeRange.timing)
})

test('keeps retained historical inference out of Auto mode charts', async () => {
  root = await mkdtemp(join(tmpdir(), 'auto-mode-usage-history-'))
  transcript = join(root, 'history.jsonl')
  const indexPath = join(root, 'index-v9.sqlite')
  const asOf = '2026-09-13T12:00:00.000Z'
  await writeFile(transcript, [
    {
      type: 'system',
      subtype: 'run_facts',
      uuid: 'mode',
      timestamp: '2026-09-13T09:00:00.000Z',
      permissionMode: 'auto',
    },
    {
      type: 'assistant',
      uuid: 'assistant',
      timestamp: '2026-09-13T09:01:00.000Z',
      message: {
        id: 'assistant',
        model: 'fixture-model',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          { type: 'tool_use', id: 'blocked-tool', name: 'Bash' },
          { type: 'tool_use', id: 'unknown-tool', name: 'Bash' },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'blocked-result',
      timestamp: '2026-09-13T09:01:01.000Z',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'blocked-tool',
          is_error: true,
          content: 'Permission for this action has been denied. Reason: fixture policy',
        }],
      },
    },
    {
      type: 'user',
      uuid: 'unknown-result',
      timestamp: '2026-09-13T09:01:02.000Z',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'unknown-tool',
          content: 'ordinary result',
        }],
      },
    },
  ].map(row => JSON.stringify(row)).join('\n'))

  const produced = fitUsageDashboardSnapshot(await collectIndexedUsage(
    [transcript],
    asOf,
    { path: indexPath, deadline: Date.now() + 60_000 },
  ))
  const parsed = parseUsageCollectionResult({ type: 'usage', version: 1, snapshot: produced })
  expect(parsed).not.toBeNull()
  const autoMode = parsed!.snapshot.ranges['7d'].autoMode
  expect(autoMode.allTools.coverage.state).toBe('unavailable')
  expect(Object.values(autoMode.allTools.outcomes).every(count => count === 0)).toBe(true)
  expect(autoMode.categories).toEqual([])
  const html = renderToStaticMarkup(<UsageAutoMode summary={parsed!.snapshot.ranges['7d']}/>)
  expect(html).toContain('Decision flow unavailable')
  expect(html).not.toContain('Unknown outcome')
  expect(html).not.toContain('Uncategorized')
})
