/** The experiment's execution-to-conversation boundary, not a desktop protocol. */
export type CompletedCommandResult = {
  runId: string
  command: string
  cwd: string
  output: string
  exitCode: number | null
  status: 'completed' | 'stopped' | 'timed_out' | 'output_limit' | 'integration_error'
}
