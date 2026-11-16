import type { Message } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import { createUserMessage } from '../../utils/messages.js'
import type { CodeModeResult } from './codeModeHost.js'

/** Reconstructs outcome evidence, never interpreter state or executable continuations. */
export function restoreCodeModeHistory(messages: Message[], tasks: ReturnType<ToolUseContext['getAppState']>['tasks']): Message[] {
  const calls = new Map<string, { uuid: string; name: string }>()
  for (const message of messages) if (message.type === 'assistant') {
    for (const block of message.message.content) if (block.type === 'tool_use') calls.set(block.id, { uuid: message.uuid, name: block.name })
  }
  const latest = new Map<string, { result: CodeModeResult; source: string }>()
  for (const message of messages) {
    if (message.type !== 'user' || message.isVirtual || !message.sourceToolAssistantUUID) continue
    const data = message.toolUseResult
    if (!data || typeof data !== 'object' || !('kind' in data) || data.kind !== 'code-mode' || !('cellId' in data) || typeof data.cellId !== 'string') continue
    if (!('generation' in data) || typeof data.generation !== 'string' ||
        !('calls' in data) || !Array.isArray(data.calls) ||
        !('changedFiles' in data) || !Array.isArray(data.changedFiles)) continue
    const parent = calls.get(data.cellId)
    if (parent?.name !== 'REPL' || parent.uuid !== message.sourceToolAssistantUUID) continue
    latest.set(data.cellId, { result: data as CodeModeResult, source: parent.uuid })
  }
  if (!latest.size) return messages
  const additions: Message[] = []
  for (const { result, source } of latest.values()) {
    if (result.status !== 'running') continue
    const live = Object.values(tasks).some(task => task && typeof task === 'object' &&
      'type' in task && task.type === 'code_mode' &&
      'cellId' in task && task.cellId === result.cellId &&
      'generation' in task && task.generation === result.generation &&
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
        const data = message.toolUseResult
        if (!block.is_error && ['Edit', 'Write', 'NotebookEdit', 'apply_patch'].includes(call.name) && data && typeof data === 'object') {
          if ('filePath' in data && typeof data.filePath === 'string') changedFiles.set(data.filePath, { path: data.filePath })
          if ('files' in data && Array.isArray(data.files)) for (const file of data.files) if (file && typeof file.path === 'string') changedFiles.set(file.path, { path: file.path })
        }
      }
    }
    const error = 'This runtime incarnation does not own or continue the prior background execution, which has no terminal receipt here. Its final outcome is unknown; recorded completed effects remain valid. No continuation was resumed or replayed.'
    const restored: CodeModeResult = {
      ...result, status: 'failed', error,
      output: `[Code Mode] Prior background execution is no longer owned. ${error}`,
      calls: [...auditCalls.values()].map(call => call.status === 'running' ? { ...call, status: 'failed', error: 'Outcome unknown in this runtime incarnation; effects may have occurred' } : call),
      changedFiles: [...changedFiles.values()],
    }
    additions.push(createUserMessage({ content: restored.output, isMeta: true, toolUseResult: restored, sourceToolAssistantUUID: source as `${string}-${string}-${string}-${string}-${string}` }))
  }
  additions.push(createUserMessage({
    content: '[Code Mode] A new runtime incarnation has empty interpreter variables and functions. Prior scripts were not replayed, and no prior background continuation was resumed. Retained audit and file-change receipts are historical evidence, not live interpreter state.',
    isMeta: true,
  }))
  return [...messages, ...additions]
}
