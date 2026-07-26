import type { MessageOrigin } from '../types/message.js'

export type TaskNotificationStatus =
  | 'completed'
  | 'failed'
  | 'killed'
  | 'running'
  | 'pending'

export type TaskNotificationUsage = {
  totalTokens: number
  toolUses: number
  durationMs: number
}

export type TaskNotificationDetails = {
  summary: string
  status?: TaskNotificationStatus
  taskId?: string
  taskType?: string
  outputFile?: string
  toolUseId?: string
  result?: string
  usage?: TaskNotificationUsage
  worktreePath?: string
  worktreeBranch?: string
}

export function formatTaskNotificationText(
  details: TaskNotificationDetails,
): string {
  const lines = ['Task notification']

  if (details.taskId) lines.push(`Task ID: ${details.taskId}`)
  if (details.taskType) lines.push(`Task type: ${details.taskType}`)
  if (details.outputFile) lines.push(`Output file: ${details.outputFile}`)
  if (details.toolUseId) lines.push(`Tool use ID: ${details.toolUseId}`)
  if (details.status) lines.push(`Status: ${details.status}`)
  lines.push(`Summary: ${details.summary}`)

  if (details.result) {
    lines.push('Result:')
    lines.push(details.result)
  }

  if (details.usage) {
    lines.push('Usage:')
    lines.push(`- Total tokens: ${details.usage.totalTokens}`)
    lines.push(`- Tool uses: ${details.usage.toolUses}`)
    lines.push(`- Duration ms: ${details.usage.durationMs}`)
  }

  if (details.worktreePath) {
    lines.push('Worktree:')
    lines.push(`- Path: ${details.worktreePath}`)
    if (details.worktreeBranch) {
      lines.push(`- Branch: ${details.worktreeBranch}`)
    }
  }

  return lines.join('\n')
}

function extractLegacyTag(text: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)
  return match?.[1]?.trim() || undefined
}

function extractLineValue(text: string, label: string): string | undefined {
  const match = new RegExp(`^${label}:\\s*(.+)$`, 'm').exec(text)
  return match?.[1]?.trim() || undefined
}

function extractSection(text: string, label: string): string | undefined {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.trim() === `${label}:`)
  if (start === -1) return undefined

  const collected: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (/^[A-Z][A-Za-z ]+:\s*.*$/.test(line) && !line.startsWith('- ')) break
    if (line.trim() === 'Worktree:' || line.trim() === 'Usage:') break
    collected.push(line)
  }

  const value = collected.join('\n').trim()
  return value || undefined
}

function extractBulletValue(text: string, label: string): string | undefined {
  const match = new RegExp(`^- ${label}:\\s*(.+)$`, 'm').exec(text)
  return match?.[1]?.trim() || undefined
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const STRUCTURED_TASK_NOTIFICATION_HEADER = 'Task notification'
const LEGACY_TASK_NOTIFICATION_OPEN_TAG = '<task-notification>'

export function isTaskNotificationText(text: string): boolean {
  const trimmed = text.trim()
  return (
    trimmed === STRUCTURED_TASK_NOTIFICATION_HEADER ||
    trimmed.startsWith(`${STRUCTURED_TASK_NOTIFICATION_HEADER}\n`) ||
    trimmed.startsWith(LEGACY_TASK_NOTIFICATION_OPEN_TAG)
  )
}

export function parseTaskNotificationDetails(
  text: string,
): TaskNotificationDetails | null {
  const trimmed = text.trim()

  // Compatibility-only parser for older transcripts/sessions that still contain
  // the legacy XML envelope. Runtime emitters now produce the structured banner.
  if (trimmed.startsWith(LEGACY_TASK_NOTIFICATION_OPEN_TAG)) {
    const legacySummary = extractLegacyTag(text, 'summary')
    if (!legacySummary) return null

    return {
      summary: legacySummary,
      status: extractLegacyTag(text, 'status') as TaskNotificationStatus | undefined,
      taskId: extractLegacyTag(text, 'task-id'),
      taskType: extractLegacyTag(text, 'task-type'),
      outputFile: extractLegacyTag(text, 'output-file'),
      toolUseId: extractLegacyTag(text, 'tool-use-id'),
      result: extractLegacyTag(text, 'result'),
      usage: undefined,
      worktreePath: extractLegacyTag(text, 'worktree-path'),
      worktreeBranch: extractLegacyTag(text, 'worktree-branch'),
    }
  }

  if (!isTaskNotificationText(trimmed)) return null

  const labeledSummary = extractLineValue(text, 'Summary')
  if (!labeledSummary) return null

  const totalTokens = parseOptionalNumber(extractBulletValue(text, 'Total tokens'))
  const toolUses = parseOptionalNumber(extractBulletValue(text, 'Tool uses'))
  const durationMs = parseOptionalNumber(extractBulletValue(text, 'Duration ms'))
  const usage =
    totalTokens !== undefined || toolUses !== undefined || durationMs !== undefined
      ? {
          totalTokens: totalTokens ?? 0,
          toolUses: toolUses ?? 0,
          durationMs: durationMs ?? 0,
        }
      : undefined

  return {
    summary: labeledSummary,
    status: extractLineValue(text, 'Status') as TaskNotificationStatus | undefined,
    taskId: extractLineValue(text, 'Task ID'),
    taskType: extractLineValue(text, 'Task type'),
    outputFile: extractLineValue(text, 'Output file'),
    toolUseId: extractLineValue(text, 'Tool use ID'),
    result: extractSection(text, 'Result'),
    usage,
    worktreePath: extractBulletValue(text, 'Path'),
    worktreeBranch: extractBulletValue(text, 'Branch'),
  }
}

export function toTaskNotificationOrigin(
  details: TaskNotificationDetails,
): Extract<MessageOrigin, { kind: 'task-notification' }> {
  return {
    kind: 'task-notification',
    ...details,
  }
}

export function taskNotificationOriginFromText(
  text: string,
): Extract<MessageOrigin, { kind: 'task-notification' }> | undefined {
  const details = parseTaskNotificationDetails(text)
  return details ? toTaskNotificationOrigin(details) : undefined
}

/**
 * Resolve the provenance of a drained `queued_command`: the explicit origin the
 * queue carried, else the structured banner parsed out of a task-notification's
 * text (older queued commands predate the enqueue-time inference in
 * messageQueueManager.ts), else a bare `task-notification` marker so a
 * mode-tagged notification is never attributed to the user.
 *
 * Single definition on purpose — both consumers of a `queued_command`
 * attachment (the internal message builder in messages.ts and the SDK user-frame
 * yield in QueryEngine.ts) must agree, or the same notification is provenanced
 * one way for the TUI and another way for an SDK/app consumer.
 *
 * Takes `unknown` because `AttachmentMessage.attachment` is declared `unknown`
 * (`src/types/message.ts:115`) — the attachment is narrowed here rather than at
 * each call site, and a shape this does not recognize yields `undefined` (the
 * pre-existing "no provenance" reading) instead of throwing.
 */
function isQueuedCommandAttachment(value: unknown): value is {
  origin?: MessageOrigin
  commandMode?: string
  prompt?: unknown
} {
  return typeof value === 'object' && value !== null
}

export function queuedCommandOrigin(command: unknown): MessageOrigin | undefined {
  if (!isQueuedCommandAttachment(command)) return undefined
  // An explicit origin from the queue wins, but only if it is actually a
  // discriminated origin — a malformed value must not become provenance.
  const explicit = command.origin
  if (typeof explicit === 'object' && explicit !== null && 'kind' in explicit) {
    return explicit
  }
  if (
    command.commandMode !== 'task-notification' ||
    typeof command.prompt !== 'string'
  ) {
    return undefined
  }
  return (
    taskNotificationOriginFromText(command.prompt) ?? {
      kind: 'task-notification',
    }
  )
}
