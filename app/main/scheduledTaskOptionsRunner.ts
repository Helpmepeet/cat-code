import { runNdjsonWorker } from './ndjsonWorker.js'
import { MAX_SCHEDULED_OPTIONS_BYTES, parseScheduledTaskOptionsResult, type ScheduledTaskOptionsResult } from '../shared/scheduledTaskOptions.js'

export async function runScheduledTaskOptionsWorker(options: {
  command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; log?: (line: string) => void
}): Promise<ScheduledTaskOptionsResult> {
  let result: ScheduledTaskOptionsResult | null = null
  let invalid = false
  const terminal = await runNdjsonWorker({ ...options, input: '{"type":"scheduled-options","version":1}\n',
    timeoutMs: 15_000, escalateKillAfterMs: 1_000, maxRecordBytes: MAX_SCHEDULED_OPTIONS_BYTES,
    onOversizeRecord: () => { invalid = true },
    onRecord: line => {
      try {
        const parsed = parseScheduledTaskOptionsResult(JSON.parse(line.toString('utf8')))
        if (result !== null || !parsed) invalid = true
        else result = parsed
      } catch { invalid = true }
      return invalid ? 'stop' : 'continue'
    },
  })
  if (!result || invalid || terminal.code !== 0 || terminal.signal !== null || terminal.timedOut || terminal.aborted || terminal.stdinError || terminal.trailingBytes !== 0) {
    throw new Error('Scheduled task options could not be read')
  }
  return result
}
