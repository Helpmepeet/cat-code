import { afterEach, beforeEach, expect, test } from 'bun:test'
import { feature } from 'bun:bundle'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSessionId, getSessionProjectDir, switchSession } from '../../bootstrap/state.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { asSessionId } from '../../types/ids.js'
import { createAssistantMessage, createCompactBoundaryMessage, createUserMessage, normalizeAttachmentForAPI } from '../../utils/messages.js'
import { getTodoReminderAttachments, getTaskReminderAttachments } from '../../utils/attachments.js'
import { TodoWriteTool } from '../../tools/TodoWriteTool/TodoWriteTool.js'
import { TaskUpdateTool } from '../../tools/TaskUpdateTool/TaskUpdateTool.js'
import { createTask, getTaskListId, updateTask } from '../../utils/tasks.js'
import { appendPostCompactRuntimeAttachments, buildPostCompactMessages, type CompactionResult } from './compact.js'
import { roughTokenCountEstimationForMessages } from '../tokenEstimation.js'
import { recordTranscript, flushCurrentTranscriptDurably, getTranscriptPathForSession, resetProjectForTesting, clearSessionMessagesCache, markActiveConversationTip } from '../../utils/sessionStorage.js'
import { releaseActiveTranscriptLease } from '../../utils/transcriptLease.js'

const envKeys = ['CLAUDE_CONFIG_DIR', 'CAT_CODE_EVAL_COMPACT_TASK_RESTORE', 'CLAUDE_CODE_TASK_LIST_ID', 'CLAUDE_CODE_ENABLE_TASKS', 'TEST_ENABLE_SESSION_PERSISTENCE'] as const
let previous: (string | undefined)[], dir: string
const session = getSessionId(), project = getSessionProjectDir()
const candidateTest = feature('COMPACT_TASK_RESTORE') ? test : test.skip
beforeEach(() => {
  previous = envKeys.map(k => process.env[k])
  dir = mkdtempSync(join(tmpdir(), 'compact-task-state-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.CAT_CODE_EVAL_COMPACT_TASK_RESTORE = '1'
  delete process.env.CLAUDE_CODE_TASK_LIST_ID
  process.env.CLAUDE_CODE_ENABLE_TASKS = '1'
  switchSession(asSessionId(randomUUID()), dir)
})
afterEach(() => {
  envKeys.forEach((k, i) => { if (previous[i] === undefined) delete process.env[k]; else process.env[k] = previous[i] })
  switchSession(session, project)
  rmSync(dir, { recursive: true, force: true })
})
function result(kept: Message[] = []): CompactionResult {
  return { boundaryMarker: createCompactBoundaryMessage('auto', 500),
    summaryMessages: [createUserMessage({ content: 'Continue the work.', isMeta: true, isCompactSummary: true })],
    attachments: [], hookResults: [], messagesToKeep: kept, truePostCompactTokenCount: 10 }
}
function toolRound(name: string, input: unknown, output: string): Message[] {
  const id = randomUUID()
  return [createAssistantMessage({ content: [{ type: 'tool_use', id, name, input }] }),
    createUserMessage({ content: [{ type: 'tool_result', tool_use_id: id, content: output }] })]
}
function context(messages: Message[], todos: unknown[] = []): ToolUseContext {
  const state = { todos: { [getSessionId()]: todos } }
  return { messages, options: { tools: todos.length ? [TodoWriteTool] : [TaskUpdateTool] },
    abortController: new AbortController(),
    getAppState: () => state,
    setAppState: (update: (state: unknown) => unknown) => Object.assign(state, update(state)),
  } as unknown as ToolUseContext
}
function text(r: CompactionResult): string {
  return r.attachments.flatMap(m => normalizeAttachmentForAPI(m.attachment as never)).map(m => String(m.message.content)).join('\n')
}

for (const kind of ['todo', 'task'] as const) {
  candidateTest(`${kind}: first post-compact request restores current unfinished state once`, async () => {
    const todos = [{ content: 'Verify the boundary', activeForm: 'Verifying the boundary', status: 'in_progress' }]
    const taskId = kind === 'task' ? await createTask(getTaskListId(), {
      subject: 'Verify the boundary', description: 'Use the independent oracle.', activeForm: 'Verifying the boundary',
      status: 'in_progress', blocks: [], blockedBy: ['blocking-task'],
    }) : undefined
    const activity = kind === 'todo' ? toolRound('TodoWrite', { todos }, 'Todos have been modified successfully.')
      : toolRound('TaskUpdate', { taskId, status: 'in_progress' }, `Updated task #${taskId}`)
    const messages = [createUserMessage({ content: 'Implement and verify.' }), ...activity]
    const ctx = context(messages, kind === 'todo' ? todos : [])
    const baselineReminder = kind === 'todo' ? getTodoReminderAttachments : getTaskReminderAttachments
    expect(await baselineReminder(buildPostCompactMessages(result()), ctx)).toEqual([])
    const restored = await appendPostCompactRuntimeAttachments(result(), ctx)
    expect(restored.attachments).toHaveLength(1)
    expect(text(restored)).toContain('Verify the boundary')
    expect(text(restored)).toContain('Verifying the boundary')
    if (kind === 'task') expect(text(restored)).toContain('blocking-task')
    expect(restored.truePostCompactTokenCount).toBe(roughTokenCountEstimationForMessages(buildPostCompactMessages(restored) as Parameters<typeof roughTokenCountEstimationForMessages>[0]))
    const second = await appendPostCompactRuntimeAttachments(restored, ctx)
    expect(second.attachments).toHaveLength(1)
    const preserved = await appendPostCompactRuntimeAttachments(result(restored.attachments), ctx)
    expect(preserved.attachments).toHaveLength(0)
    const idle = Array.from({ length: 12 }, () => createAssistantMessage({ content: 'Continue.' }))
    expect(await baselineReminder([...restored.attachments, ...idle], ctx)).toEqual([])
    // A new request without task activity cannot revive the previous request's list.
    ctx.messages = [...messages, createUserMessage({ content: 'Instead, explain the design only.' })]
    expect((await appendPostCompactRuntimeAttachments(result(), ctx)).attachments).toHaveLength(0)
    delete process.env.CAT_CODE_EVAL_COMPACT_TASK_RESTORE
    ctx.messages = messages
    expect((await appendPostCompactRuntimeAttachments(result(), ctx)).attachments).toHaveLength(0)
  })
}

candidateTest('todo: preserved successful write needs no duplicate, bounded text retains durable state', async () => {
  const todos = [{ content: 'X'.repeat(20_000), activeForm: 'Running checks', status: 'in_progress' }]
  const activity = toolRound('TodoWrite', { todos }, 'success')
  const ctx = context([createUserMessage({ content: 'Check it.' }), ...activity], todos)
  expect((await appendPostCompactRuntimeAttachments(result(activity), ctx)).attachments).toHaveLength(0)
  const restored = await appendPostCompactRuntimeAttachments(result(), ctx)
  expect(text(restored).length).toBeLessThanOrEqual(3000)
  expect((restored.attachments[0]!.attachment as { content: unknown }).content).toEqual(todos)
  // A retained worker can resume without its released AppState slot. A copied
  // parent snapshot must not become the child's unfinished work.
  ctx.messages = buildPostCompactMessages(restored)
  ctx.getAppState = () => ({ todos: {} }) as never
  expect((await appendPostCompactRuntimeAttachments(result(), ctx)).attachments).toHaveLength(1)
  ctx.agentId = 'other-agent' as never
  expect((await appendPostCompactRuntimeAttachments(result(), ctx)).attachments).toHaveLength(0)
  ctx.agentId = undefined
  ctx.getAppState = () => ({ todos: { [getSessionId()]: [] } }) as never
  expect((await appendPostCompactRuntimeAttachments(result(), ctx)).attachments).toHaveLength(0)
})

candidateTest('durable compaction attachment restores full TodoWrite state in a fresh process', async () => {
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  resetProjectForTesting()
  const todos = [{ content: 'Verify ' + 'X'.repeat(6000), activeForm: 'Verifying', status: 'pending' }]
  const messages = [createUserMessage({ content: 'Do the checks.' }), ...toolRound('TodoWrite', { todos }, 'success')]
  const restored = await appendPostCompactRuntimeAttachments(result(), context(messages, todos))
  try {
    await recordTranscript(messages)
    await recordTranscript(buildPostCompactMessages(restored), undefined, undefined, messages)
    await markActiveConversationTip(restored.summaryMessages.at(-1)!.uuid as never)
    await flushCurrentTranscriptDurably()
    const path = getTranscriptPathForSession(getSessionId())
    const rawRows = (await Bun.file(path).text()).trim().split('\n').map(line => JSON.parse(line))
    expect(rawRows.some(row => row.type === 'attachment' && row.attachment?.compactState), JSON.stringify(rawRows.map(r => r.type))).toBe(true)
    const moduleURL = (path: string) => new URL(path, import.meta.url).href
    const script = `
      const { loadTranscriptFromFile } = await import(${JSON.stringify(moduleURL('../../utils/sessionStorage.ts'))});
      const { restoreSessionStateFromLog } = await import(${JSON.stringify(moduleURL('../../utils/sessionRestore.ts'))});
      const { switchSession } = await import(${JSON.stringify(moduleURL('../../bootstrap/state.ts'))});
      const { getDefaultAppState } = await import(${JSON.stringify(moduleURL('../../state/AppStateStore.ts'))});
      switchSession(${JSON.stringify(getSessionId())}, ${JSON.stringify(dir)});
      const loaded = await loadTranscriptFromFile(${JSON.stringify(path)});
      let state = getDefaultAppState();
      restoreSessionStateFromLog(loaded, f => { state = f(state); });
      console.log(JSON.stringify({ todos: state.todos[${JSON.stringify(getSessionId())}], snapshots: loaded.messages.filter(m => m.type === 'attachment' && m.attachment?.compactState).length, types: loaded.messages.map(m => m.type) }));
    `
    const child = Bun.spawn([process.execPath, '--eval', script], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_ENABLE_TASKS: 'false' }, stdout: 'pipe', stderr: 'pipe',
    })
    const output = await new Response(child.stdout).text()
    const errors = await new Response(child.stderr).text()
    expect(await child.exited, errors).toBe(0)
    const data = JSON.parse(output.trim())
    expect(data.snapshots, JSON.stringify(data.types)).toBe(1)
    expect(data.todos).toEqual(todos)
  } finally {
    clearSessionMessagesCache()
    resetProjectForTesting()
    await releaseActiveTranscriptLease()
  }
})

candidateTest('task: latest disk state wins, unrelated shared tasks and failed writes stay out', async () => {
  process.env.CLAUDE_CODE_TASK_LIST_ID = 'shared-evaluation-list'
  const make = (subject: string) => createTask(getTaskListId(), { subject, description: '', status: 'pending', blocks: [], blockedBy: [] })
  const id = await make('Current work')
  await make('Unrelated work')
  const messages = [createUserMessage({ content: 'Do current work.' }), ...toolRound('TaskUpdate', { taskId: id }, `Updated task #${id}`)]
  await updateTask(getTaskListId(), id, { subject: 'Corrected work', activeForm: 'Checking corrected work' })
  const ctx = context(messages)
  const changed = await TaskUpdateTool.call({ taskId: id, subject: 'Tool-updated work', activeForm: 'Verifying tool-updated work' }, ctx)
  const actualOutput = TaskUpdateTool.mapToolResultToToolResultBlockParam(changed.data as never, 'actual-update')
  ctx.messages = [createUserMessage({ content: 'Do current work.' }), ...toolRound('TaskUpdate', { taskId: id }, String(actualOutput.content))]
  const restored = await appendPostCompactRuntimeAttachments(result(), ctx)
  expect(text(restored)).toContain('Tool-updated work')
  expect(text(restored)).not.toContain('Unrelated work')
  await updateTask(getTaskListId(), id, { status: 'completed' })
  expect((await appendPostCompactRuntimeAttachments(result(), ctx)).attachments).toHaveLength(0)
  await updateTask(getTaskListId(), id, { status: 'pending', owner: 'another-agent' })
  expect((await appendPostCompactRuntimeAttachments(result(), ctx)).attachments).toHaveLength(0)
  await updateTask(getTaskListId(), id, { owner: '' })
  const failed = toolRound('TaskUpdate', { taskId: id }, 'not applied')
  ;(failed[1] as any).message.content[0].is_error = true
  ctx.messages = [createUserMessage({ content: 'Current work.' }), ...failed]
  expect((await appendPostCompactRuntimeAttachments(result(), ctx)).attachments).toHaveLength(0)
})
