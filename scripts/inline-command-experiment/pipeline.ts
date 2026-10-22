import type { CompletedCommandResult } from './contracts.js'
import { deliverCompletedCommand } from './delivery.js'
import type { EngineExperimentInput } from './engineProcess.js'
import { runPtyAttempt, type PtyAttemptOptions } from './pty.js'
import { interpretTerminal } from './terminalText.js'

/** Executable experiment only: no renderer IPC, permission bypass, or live provider. */
export async function runCommandExperiment(
  options: PtyAttemptOptions,
  deliveryOptions: Omit<EngineExperimentInput, 'context'> = {},
) {
  const execution = await runPtyAttempt(options)
  const terminal = await interpretTerminal([execution.rawOutput], {
    columns: 100,
    rows: 30,
    maxTextBytes: 32 * 1024 - 256,
  })
  const incomplete = terminal.rawTruncated || terminal.textTruncated || terminal.historyTruncated || execution.status === 'output_limit'
  const result: CompletedCommandResult = {
    runId: execution.runId,
    command: execution.command,
    cwd: execution.cwd,
    output: terminal.text + (incomplete ? '\n[Output is a bounded terminal snapshot; some captured output is omitted.]' : ''),
    exitCode: execution.exitCode,
    status: execution.status,
  }
  const delivery = await deliverCompletedCommand(result, deliveryOptions)
  return { execution, terminal, result, delivery }
}
