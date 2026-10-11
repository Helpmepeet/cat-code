import { getSessionId } from '../../bootstrap/state.js'
import { feature } from 'bun:bundle'
import { isDeepStrictEqual } from 'node:util'
import { toolMatchesName, type ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import type { Attachment } from '../../utils/attachments.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getTaskListId, listTasks } from '../../utils/tasks.js'
import { getAgentName } from '../../utils/teammate.js'
import { TodoListSchema } from '../../utils/todo/types.js'

// An evaluation candidate, never enabled by the production default.
export const POST_COMPACT_TASK_TOKEN_BUDGET = 1_000
export function isCompactTaskRestoreEnabled(): boolean {
  if (!feature('COMPACT_TASK_RESTORE')) return false
  return isEnvTruthy(process.env.CAT_CODE_EVAL_COMPACT_TASK_RESTORE)
}

function currentRequest(messages: Message[]): Message[] {
  const index = messages.findLastIndex(m => m.type === 'user' && !m.isMeta && !m.isCompactSummary &&
    (typeof m.message.content === 'string' || m.message.content.some(b => b.type === 'text') && !m.message.content.some(b => b.type === 'tool_result')))
  return messages.slice(Math.max(0, index))
}

function successfulCalls(messages: Message[]) {
  const successful = new Map<string, string>()
  for (const m of messages) if (m.type === 'user' && Array.isArray(m.message.content)) {
    for (const b of m.message.content) if (b.type === 'tool_result' && !b.is_error) {
      successful.set(b.tool_use_id, typeof b.content === 'string' ? b.content : '')
    }
  }
  return messages.flatMap(m => m.type === 'assistant' ? m.message.content.flatMap(b =>
    b.type === 'tool_use' && successful.has(b.id) ? [{ name: b.name, input: b.input, output: successful.get(b.id)! }] : []) : [])
}

function snapshotIn(messages: Message[], type: 'todo_reminder' | 'task_reminder', scope: string, allowNormal = false): Extract<Attachment, { type: typeof type }> | undefined {
  for (const m of [...messages].reverse()) {
    if (m.type !== 'attachment' || !m.attachment || typeof m.attachment !== 'object') continue
    const a = m.attachment as Attachment
    if (a.type === type && (a.compactState?.scope === scope || allowNormal && !a.compactState)) return a
  }
  return undefined
}

function boundedText(lines: string[]): string {
  const prefix = 'Unfinished tracked work at compaction. Follow the latest user instructions.\n'
  let text = prefix, kept = 0
  for (const line of lines) {
    if (text.length + line.length > 2800) break
    text += line + '\n'; kept++
  }
  if (kept < lines.length) text += `${lines.length - kept} more items remain in the task state.\n`
  return text
}
const clip = (s: string) => s.length > 240 ? s.slice(0, 240) + '…' : s

/** Restore only work evidenced in this request, never an entire shared list.
 * Full existing attachment content stays durable; its model-facing snapshot is
 * bounded independently, so resume never hydrates a truncated TodoWrite list. */
export async function getPostCompactTaskAttachments(
  messages: Message[], preserved: Message[], context: ToolUseContext,
): Promise<Attachment[]> {
  if (!isCompactTaskRestoreEnabled()) return []
  const recent = currentRequest(messages)
  const calls = successfulCalls(recent)
  const todoScope = context.agentId ?? getSessionId()
  if (context.options.tools.some(t => toolMatchesName(t, 'TodoWrite'))) {
    const prior = snapshotIn(recent, 'todo_reminder', todoScope)
    if (!prior && !calls.some(c => c.name === 'TodoWrite')) return []
    const latestWrite = calls.findLast(c => c.name === 'TodoWrite')
    const writeInput = latestWrite?.input && typeof latestWrite.input === 'object' && 'todos' in latestWrite.input
      ? latestWrite.input.todos : undefined
    // Retained workers release their AppState slot at run end. Their scoped
    // transcript evidence remains authoritative until a newer write exists.
    const parsed = TodoListSchema().safeParse(context.getAppState().todos?.[todoScope] ?? (prior ? writeInput ?? prior.content : []))
    if (!parsed.success || !parsed.data.some(t => t.status !== 'completed')) return []
    const todos = parsed.data
    const retained = snapshotIn(preserved, 'todo_reminder', todoScope, true)
    if (retained && isDeepStrictEqual(retained.content, todos)) return []
    if (successfulCalls(preserved).some(c => c.name === 'TodoWrite' && c.input && typeof c.input === 'object' &&
      isDeepStrictEqual((c.input as { todos?: unknown }).todos, todos))) return []
    const lines = todos.filter(t => t.status !== 'completed').sort((a, b) => Number(b.status === 'in_progress') - Number(a.status === 'in_progress'))
      .map(t => `[${t.status}] ${clip(t.content)}; current step: ${clip(t.activeForm)}`)
    return [{ type: 'todo_reminder', content: todos, itemCount: todos.length,
      compactState: { scope: todoScope, text: boundedText(lines) } }]
  }
  if (!context.options.tools.some(t => toolMatchesName(t, 'TaskUpdate'))) return []
  const listId = getTaskListId(), scope = `${listId}/${context.agentId ?? getSessionId()}`
  const prior = snapshotIn(recent, 'task_reminder', scope)
  const ids = new Set(prior?.content.map(t => t.id) ?? [])
  for (const c of calls) {
    if (['TaskUpdate', 'TaskGet'].includes(c.name) && c.input && typeof c.input === 'object' &&
      'taskId' in c.input && typeof c.input.taskId === 'string') ids.add(c.input.taskId)
    if (c.name === 'TaskCreate') {
      const id = c.output.match(/^Task #(\S+) created successfully:/)?.[1]
      if (id) ids.add(id)
    }
    // A shared list read does not assign all its unowned work to this agent.
    if (c.name === 'TaskList' && listId === getSessionId() && !context.agentId) {
      for (const match of c.output.matchAll(/^#(\S+) \[(?:pending|in_progress|completed)\]/gm)) ids.add(match[1]!)
    }
  }
  if (!ids.size) return []
  // Read after summary/hooks: concurrent changes and completed tasks win.
  const tasks = (await listTasks(listId)).filter(t => ids.has(t.id) && !t.metadata?._internal && t.status !== 'completed' &&
    (!t.owner || t.owner === context.agentId || t.owner === getAgentName()))
  if (!tasks.length) return []
  const retained = snapshotIn(preserved, 'task_reminder', scope, true)
  if (retained && isDeepStrictEqual(retained.content, tasks)) return []
  if (tasks.every(t => !t.activeForm) && successfulCalls(preserved).some(c => c.name === 'TaskList' &&
    tasks.every(t => c.output.split('\n').includes(`#${t.id} [${t.status}] ${t.subject}${t.owner ? ` (${t.owner})` : ''}${t.blockedBy.length ? ` [blocked by ${t.blockedBy.map(id => `#${id}`).join(', ')}]` : ''}`)))) return []
  const lines = [...tasks].sort((a, b) => Number(b.status === 'in_progress') - Number(a.status === 'in_progress')).map(t =>
    `#${t.id} [${t.status}] ${clip(t.subject)}${t.activeForm ? `; current step: ${clip(t.activeForm)}` : ''}${t.blockedBy.length ? `; blocked by: ${clip(t.blockedBy.join(', '))}` : ''}`)
  return [{ type: 'task_reminder', content: tasks, itemCount: tasks.length,
    compactState: { scope, text: boundedText(lines) } }]
}
