import type { InlineCommandRun, InlineCommandSource } from '../../app/shared/inlineCommand.js'
import { extractInlineCommandFences } from '../../app/shared/inlineCommand.js'
import type { AttachmentMessage, Message } from '../types/message.js'
import type { ToolUseContext } from '../Tool.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import { createAssistantMessage } from '../utils/messages.js'
import { runToolUse } from '../services/tools/toolExecution.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'

export type InlineCommandOperation = {
  source: InlineCommandSource
  runId: string
  signal: AbortSignal
  onProgress: (run: InlineCommandRun) => void
}

export const INLINE_COMMAND_OUTPUT_LIMIT = 24_000
const bounded = (text: string) => text.length <= INLINE_COMMAND_OUTPUT_LIMIT
  && JSON.stringify(text).length <= INLINE_COMMAND_OUTPUT_LIMIT
  ? text : '[Earlier output omitted]\n' + text.slice(-Math.floor(INLINE_COMMAND_OUTPUT_LIMIT / 6))

export function resolveInlineCommandSource(messages: readonly Message[], sessionId: string, source: InlineCommandSource): string {
  if (source.engineSessionId !== sessionId) throw new Error('The command belongs to another conversation')
  if (!Number.isSafeInteger(source.contentBlockIndex) || source.contentBlockIndex < 0 ||
    !Number.isSafeInteger(source.fenceOrdinal) || source.fenceOrdinal < 0) throw new Error('Invalid command source')
  const index = messages.findIndex(message => message.uuid === source.messageUuid)
  const message = messages[index]
  let complete = false
  if (message?.type === 'assistant' && !message.error) {
    // The provider emits one UUID per block, but writes the response stop reason
    // only to its final block. Do not borrow completion across response boundaries.
    for (let cursor = index; cursor < messages.length; cursor++) {
      const sibling = messages[cursor]
      if (sibling?.type !== 'assistant' || sibling.message.id !== message.message.id ||
        sibling.requestId !== message.requestId || sibling.error) break
      if (sibling.message.stop_reason) {
        complete = true
        break
      }
    }
  }
  if (!message || message.type !== 'assistant' || !complete) {
    throw new Error('The command source is no longer available or is incomplete')
  }
  const block = message.message.content[source.contentBlockIndex]
  if (!block || block.type !== 'text') throw new Error('The command source is not assistant text')
  const fence = extractInlineCommandFences(block.text).find(fence => fence.ordinal === source.fenceOrdinal)
  if (!fence || fence.command.length > 32_000) throw new Error('The shell command source is unavailable or too large')
  return fence.command
}

/** Keep genuine attachments, but never persist the internal synthetic tool pair. */
export async function runInlineCommand(
  operation: InlineCommandOperation,
  command: string,
  cwd: string,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
): Promise<{ run: InlineCommandRun; attachments: AttachmentMessage[]; shouldQuery: boolean; context?: ToolUseContext }> {
  const attachments: AttachmentMessage[] = []
  let shouldQuery = true
  let updatedContext = context
  let run: InlineCommandRun = { runId: operation.runId, source: operation.source, command, cwd,
    status: 'running', output: '', exitCode: null }
  const controller = new AbortController()
  const stop = () => controller.abort(operation.signal.reason ?? 'Inline command stopped')
  const abort = () => controller.abort(context.abortController.signal.reason ?? 'Session aborted')
  operation.signal.addEventListener('abort', stop, { once: true })
  context.abortController.signal.addEventListener('abort', abort, { once: true })
  if (operation.signal.aborted) stop()
  if (context.abortController.signal.aborted) abort()
  const toolUse = { type: 'tool_use' as const, caller: { type: 'direct' as const }, id: operation.runId, name: BASH_TOOL_NAME,
    input: { command, work_lifetime: 'finite', run_in_background: false } }
  const parent = createAssistantMessage({ content: [toolUse] })
  let observed = false
  try {
    operation.onProgress({ ...run })
    for await (const update of runToolUse(toolUse, parent, canUseTool, {
      ...context,
      abortController: controller,
      inlineCommand: { command, cwd, onResult(result) {
        observed = true
        run = { ...run, exitCode: result.code, output: bounded(result.stdout),
          status: result.interrupted ? 'interrupted' : result.code === 0 ? 'success' : 'failed' }
      } },
    })) {
      if (update.contextModifier) {
        updatedContext = update.contextModifier.modifyContext(updatedContext)
      }
      const message = update.message
      if (message.type === 'attachment') {
        attachments.push(message)
        const attachment = message.attachment
        if (typeof attachment === 'object' && attachment !== null &&
          'type' in attachment && attachment.type === 'hook_stopped_continuation' &&
          'message' in attachment && typeof attachment.message === 'string') {
          shouldQuery = false
          run = { ...run, error: bounded(attachment.message) }
        }
      } else if (message.type === 'progress') {
        const data = message.data as { type?: string; fullOutput?: string } | undefined
        if (data?.type === 'bash_progress' && typeof data.fullOutput === 'string') {
          run = { ...run, output: bounded(data.fullOutput) }
          operation.onProgress({ ...run })
        }
      } else if (message.type === 'user') {
        const content = message.message.content
        if (Array.isArray(content)) {
          const result = content.find(block => block.type === 'tool_result')
          if (result?.type === 'tool_result' && typeof result.content === 'string') {
            // Keep the runner's bounded preview and large-output artifact reference.
            run = { ...run, output: bounded(result.content) }
            if (result.is_error && !observed) run = { ...run, error: bounded(result.content) }
          }
        }
        const data = message.toolUseResult
        if (data && typeof data === 'object' && 'persistedOutputPath' in data &&
          typeof data.persistedOutputPath === 'string') {
          run = { ...run, output: bounded(run.output + `\nFull output: ${data.persistedOutputPath}`) }
        }
      }
    }
    if (!observed) run = { ...run, status: 'failed' }
  } catch (error) {
    run = { ...run, status: 'failed', error: bounded(error instanceof Error ? error.message : String(error)) }
  } finally {
    operation.signal.removeEventListener('abort', stop)
    context.abortController.signal.removeEventListener('abort', abort)
  }
  if (operation.signal.aborted) run = { ...run, status: 'stopped' }
  else if (context.abortController.signal.aborted) run = { ...run, status: 'interrupted' }
  operation.onProgress({ ...run })
  return { run, attachments, shouldQuery, context: updatedContext === context ? undefined : updatedContext }
}
