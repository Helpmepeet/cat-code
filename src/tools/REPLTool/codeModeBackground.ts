import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { registerCodeModeTask, type CodeModeOwner } from '../../tasks/CodeModeTask.js'
import type { CodeModeResult } from './codeModeHost.js'

export { closeCodeModeOwner, drainCodeModeTasks, sameCodeModeOwner } from '../../tasks/CodeModeTask.js'
export type { CodeModeOwner, CodeModeTaskState } from '../../tasks/CodeModeTask.js'
export type CodeModeHostCompletion = {
  result: CodeModeResult
  messages: Message[]
  contextModifier?: (context: ToolUseContext) => ToolUseContext
}

/** The promise must include host effect settlement, not just VM evaluation. The caller retains
 * worker resources until drain resolves and uses its existing interrupted-effect fence only
 * for interrupted unsettled effects. A delivery callback must durably accept messages/context.
 * This adapter never executes source, retries tools, or installs an interruption fence.
 */
export function backgroundCodeModeCell(options: {
  owner: CodeModeOwner
  cellId: string
  generation: string
  description: string
  toolUseId?: string
  context: ToolUseContext
  completion: Promise<CodeModeHostCompletion>
  cancel: () => void | Promise<void>
}) {
  const { context, completion, ...identity } = options
  const handle = registerCodeModeTask({
    ...identity,
    setAppState: context.setAppState,
    completion: completion.then(value => ({ result: value.result, value })),
  })
  return {
    ...handle,
    receipt: { taskId: handle.taskId, cellId: options.cellId, generation: options.generation, status: 'running' as const },
    deliver: (sink: (completion: CodeModeHostCompletion) => Promise<void>, failureSink?: (error: unknown) => Promise<void>) => handle.deliver(outcome => sink({ ...outcome.value, result: outcome.result }), failureSink),
  }
}
