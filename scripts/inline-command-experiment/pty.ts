import type { CompletedCommandResult } from './contracts'
import type { ShellKind } from './shellFixtures'

export type PtyAttemptOptions = {
  runId?: string
  command: string
  cwd: string
  shell?: ShellKind
  /** Synthetic fixture code only. Never load an operator profile. */
  profile?: string
  prompt?: string
  /** Use the actual sandbox runtime with isolated, deny-network fixture config. */
  sandbox?: boolean
  startupTimeoutMs?: number
  runTimeoutMs?: number
  promptTimeoutMs?: number
  maxOutputBytes?: number
  signal?: AbortSignal
  onOutput?: (bytes: Uint8Array) => void
}
export type PtyAttemptResult = CompletedCommandResult & {
  rawOutput: string
  shellExitCode: number | null
  shellSignal: string | null
  sandboxWrapped: boolean
  lifecycle: {
    ready: boolean
    foregroundStatusReceived: boolean
    promptCapture: 'bounded_window' | 'unavailable'
    teardown: 'group_signalled' | 'group_missing' | 'not_started'
    containment: 'job_control_disabled_not_a_sandbox' | 'sandbox_envelope_not_job_ownership'
  }
}

export function stoppedBeforeSpawn(options: Pick<PtyAttemptOptions, 'runId' | 'command' | 'cwd'>): PtyAttemptResult {
  return {
    runId: options.runId ?? crypto.randomUUID(), command: options.command, cwd: options.cwd,
    output: '', rawOutput: '', exitCode: null, status: 'stopped',
    shellExitCode: null, shellSignal: null, sandboxWrapped: false,
    lifecycle: { ready: false, foregroundStatusReceived: false, promptCapture: 'unavailable',
      teardown: 'not_started', containment: 'job_control_disabled_not_a_sandbox' },
  }
}

export async function runPtyAttempt(options: PtyAttemptOptions): Promise<PtyAttemptResult> {
  if (options.command.includes('\0')) throw new Error('Shell payload cannot contain NUL')
  if (Buffer.byteLength(options.command) > 1024 * 1024) throw new Error('Payload exceeds experiment limit')
  const { signal, onOutput, ...input } = options
  if (signal?.aborted) return stoppedBeforeSpawn(options)
  const owner = Bun.spawn([process.execPath, new URL('./ptyOwner.ts', import.meta.url).pathname], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  })
  owner.stdin.write(JSON.stringify(input) + '\n')
  const stop = () => { owner.stdin.end() }
  signal?.addEventListener('abort', stop, { once: true })
  if (signal?.aborted) stop()
  let result: PtyAttemptResult | undefined
  let pending = ''
  const decoder = new TextDecoder()
  const stderr = new Response(owner.stderr).text()
  try {
    for await (const chunk of owner.stdout) {
      pending += decoder.decode(chunk, { stream: true })
      let end: number
      while ((end = pending.indexOf('\n')) >= 0) {
        const message = JSON.parse(pending.slice(0, end))
        pending = pending.slice(end + 1)
        if (message.type === 'output') onOutput?.(Buffer.from(message.data, 'base64'))
        if (message.type === 'result') result = message.result
        if (message.type === 'error') throw new Error(message.error)
      }
    }
    const code = await owner.exited
    if (!result || code !== 0) throw new Error(`PTY owner failed (${code}): ${await stderr}`)
    return result
  } finally {
    signal?.removeEventListener('abort', stop)
    stop()
    await owner.exited
  }
}
