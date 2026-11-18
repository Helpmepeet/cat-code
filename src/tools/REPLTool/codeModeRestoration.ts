import type { Message, UserMessage } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import { createUserMessage } from '../../utils/messages.js'
import { toTaskNotificationOrigin } from '../../utils/taskNotification.js'
import { codeModeChangedFilePaths } from './codeModeChangedFiles.js'
import type { CodeModeResult } from './codeModeHost.js'

const UNKNOWN_OUTCOME = 'This runtime incarnation does not own or continue the prior background execution, which has no terminal receipt here. Its final outcome is unknown; recorded completed effects remain valid. No continuation was resumed or replayed.'

function unknownOutcomeOrigin(result: CodeModeResult) {
  return toTaskNotificationOrigin({
    summary: 'Background Script outcome unknown',
    status: 'failed',
    taskType: 'code_mode',
    taskId: result.taskId,
    toolUseId: result.cellId,
  })
}

/** Reconstructs outcome evidence, never interpreter state or executable continuations. */
export function restoreCodeModeHistory(
  messages: Message[],
  tasks: ReturnType<ToolUseContext['getAppState']>['tasks'],
  { includeRuntimeReset = true }: { includeRuntimeReset?: boolean } = {},
): Message[] {
  const calls = new Map<string, { uuid: string; name: string }>()
  for (const message of messages) if (message.type === 'assistant') {
    for (const block of message.message.content) if (block.type === 'tool_use') calls.set(block.id, { uuid: message.uuid, name: block.name })
  }
  const latest = new Map<string, { result: CodeModeResult; source: string }>()
  const converted = new Map<Message, UserMessage>()
  for (const message of messages) {
    if (message.type !== 'user' || message.isVirtual || !message.sourceToolAssistantUUID) continue
    const data = message.toolUseResult
    if (!data || typeof data !== 'object' || !('kind' in data) || data.kind !== 'code-mode' || !('cellId' in data) || typeof data.cellId !== 'string') continue
    if (!('generation' in data) || typeof data.generation !== 'string' ||
        !('calls' in data) || !Array.isArray(data.calls) ||
        !('changedFiles' in data) || !Array.isArray(data.changedFiles)) continue
    const parent = calls.get(data.cellId)
    if (parent?.name !== 'REPL' || parent.uuid !== message.sourceToolAssistantUUID) continue
    const result = data as CodeModeResult
    latest.set(JSON.stringify([result.cellId, result.generation, result.taskId ?? null]), { result, source: parent.uuid })
    // A previous incarnation may have persisted its recovery before it carried
    // structured task provenance. Preserve the old message identity.
    if (result.taskId && result.status === 'failed' && result.error === UNKNOWN_OUTCOME &&
        message.isMeta && message.origin === undefined && message.message.content === result.output) {
      converted.set(message, { ...message, origin: unknownOutcomeOrigin(result) })
    }
  }
  if (!latest.size) return messages
  const additions: Message[] = []
  for (const { result, source } of latest.values()) {
    if (result.status !== 'running') continue
    const live = Object.values(tasks).some(task => task && typeof task === 'object' &&
      'type' in task && task.type === 'code_mode' &&
      'cellId' in task && task.cellId === result.cellId &&
      'generation' in task && task.generation === result.generation &&
      (!result.taskId || ('id' in task && task.id === result.taskId)) &&
      'delivery' in task && task.delivery !== 'delivered')
    if (live) continue
    const auditCalls = new Map(result.calls.map(call => [call.toolUseId, { ...call }]))
    const changedFiles = new Map(result.changedFiles.map(file => [file.path, file]))
    for (const message of messages) {
      if (message.type !== 'assistant' && message.type !== 'user') continue
      if (message.codeMode?.cellId !== result.cellId || message.codeMode.generation !== result.generation) continue
      if (message.type === 'assistant') for (const block of message.message.content) {
        if (block.type === 'tool_use') auditCalls.set(block.id, { toolUseId: block.id, name: block.name, input: block.input, status: 'running', ...(message.codeMode.line ? { line: message.codeMode.line } : {}) })
      }
      if (message.type === 'user' && Array.isArray(message.message.content)) for (const block of message.message.content) {
        if (block.type !== 'tool_result') continue
        const call = auditCalls.get(block.tool_use_id)
        if (!call || calls.get(block.tool_use_id)?.uuid !== message.sourceToolAssistantUUID) continue
        call.status = block.is_error ? 'failed' : 'completed'
        if (!block.is_error) {
          for (const path of codeModeChangedFilePaths(call.name, message.toolUseResult)) {
            changedFiles.set(path, { path })
          }
        }
      }
    }
    const restored: CodeModeResult = {
      ...result, status: 'failed', error: UNKNOWN_OUTCOME,
      output: `[Code Mode] Prior background execution is no longer owned. ${UNKNOWN_OUTCOME}`,
      calls: [...auditCalls.values()].map(call => call.status === 'running' ? { ...call, status: 'failed', error: 'Outcome unknown in this runtime incarnation; effects may have occurred' } : call),
      changedFiles: [...changedFiles.values()],
    }
    additions.push(createUserMessage({
      content: restored.output, isMeta: true, toolUseResult: restored,
      ...(restored.taskId ? { origin: unknownOutcomeOrigin(restored) } : {}),
      sourceToolAssistantUUID: source as `${string}-${string}-${string}-${string}-${string}`,
    }))
  }
  if (includeRuntimeReset) additions.push(createUserMessage({
    content: '[Code Mode] A new runtime incarnation has empty interpreter variables and functions. Prior scripts were not replayed, and no prior background continuation was resumed. Retained audit and file-change receipts are historical evidence, not live interpreter state.',
    isMeta: true,
  }))
  if (!converted.size && !additions.length) return messages
  return [...(converted.size ? messages.map(message => converted.get(message) ?? message) : messages), ...additions]
}
