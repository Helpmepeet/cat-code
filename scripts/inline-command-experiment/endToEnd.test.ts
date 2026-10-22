import { expect, test } from 'bun:test'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCommandExperiment } from './pipeline.js'

async function isolated<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'inline-e2e-')))
  try { return await run(cwd) } finally { await rm(cwd, { recursive: true, force: true }) }
}

for (const shell of ['bash', 'zsh'] as const) {
 for (const provider of ['claude', 'codex'] as const) {
  test(`${shell}/${provider}: actual command -> genuine prompt -> VT interpretation -> real engine automatic response`, async () => isolated(async cwd => {
    const command = "printf 'obsolete progress'; printf '\\r\\033[2Kactual result: 42\\r\\n'; false\n\n"
    const evidence = await runCommandExperiment({
      runId: `e2e-${shell}`, shell, cwd, command,
      sandbox: true,
      prompt: `${shell}-profile-prompt> `,
      profile: 'printf "profile loaded\\n"',
      promptTimeoutMs: 100,
    }, { provider })
    expect(evidence.execution.command).toBe(command)
    expect(evidence.execution.exitCode).toBe(1)
    expect(evidence.execution.sandboxWrapped).toBe(true)
    expect(evidence.execution.rawOutput).toContain(`${shell}-profile-prompt> `)
    expect(evidence.terminal.text).toContain('actual result: 42')
    expect(evidence.terminal.text).not.toContain('obsolete progress')
    expect(evidence.terminal.text).not.toContain('\x1b')
    expect(evidence.delivery.error).toBeUndefined()
    expect(evidence.delivery.requests).toHaveLength(1)
    const outbound = JSON.stringify(evidence.delivery.requests[0])
    expect(outbound).toContain('actual result: 42')
    expect(outbound).toContain(`${shell}-profile-prompt> `)
    expect(outbound).toContain('untrusted execution data')
    if (provider === 'codex') {
      expect(evidence.delivery.codexRequests).toHaveLength(1)
      expect(JSON.stringify(evidence.delivery.codexRequests)).toContain('actual result: 42')
    }
    expect(evidence.delivery.frames.some(frame => frame.type === 'assistant')).toBe(true)
    expect(evidence.delivery.frames.some(frame => frame.type === 'result')).toBe(true)
  }), 40_000)
 }
}

for (const provider of ['claude', 'codex'] as const) {
test(`${provider}: actual completed shell result reaches the next request of a busy real engine`, async () => isolated(async cwd => {
  const evidence = await runCommandExperiment({ cwd, shell: 'zsh', command: 'printf BUSY-RESULT-9842', promptTimeoutMs: 50 }, { busy: true, provider })
  expect(evidence.delivery.error).toBeUndefined()
  expect(evidence.delivery.requests).toHaveLength(2)
  expect(JSON.stringify(evidence.delivery.requests[0])).not.toContain('BUSY-RESULT-9842')
  expect(JSON.stringify(evidence.delivery.requests[1])).toContain('BUSY-RESULT-9842')
}), 40_000)

test(`${provider}: process restart preserves actual output, but response retry duplicates its context`, async () => isolated(async cwd => {
  const evidence = await runCommandExperiment({
    cwd, shell: 'zsh', command: 'printf executed >> counter; printf CRASH-RESULT-4261', promptTimeoutMs: 50,
  }, { provider, recovery: true })
  const recovery = evidence.delivery.recovery!
  expect(recovery.killedSignal).toBe('SIGKILL')
  expect(JSON.stringify(recovery.restored.transcript)).toContain('CRASH-RESULT-4261')
  expect(recovery.restored.requests).toHaveLength(0)
  const outbound = provider === 'codex' ? recovery.retried.codexRequests : recovery.retried.requests
  // The string occurs in the command and output, then both are duplicated.
  expect(JSON.stringify(outbound).split('CRASH-RESULT-4261').length - 1).toBe(4)
  expect(await readFile(join(cwd, 'counter'), 'utf8')).toBe('executed')
}), 100_000)
}

test('Agent Stop retains the actual shell result without starting a provider request', async () => isolated(async cwd => {
  const evidence = await runCommandExperiment({ cwd, shell: 'bash', command: 'printf SAVED-BEFORE-STOP', promptTimeoutMs: 50 }, { stopBeforeDispatch: true })
  expect(evidence.execution.exitCode).toBe(0)
  expect(evidence.result.output).toContain('SAVED-BEFORE-STOP')
  expect(evidence.delivery.accepted).toBe(true)
  expect(evidence.delivery.requests).toHaveLength(0)
}), 40_000)

test('an interrupted command reports its real partial output and automatically continues', async () => isolated(async cwd => {
  const abort = new AbortController()
  const evidence = await runCommandExperiment({
    cwd, shell: 'zsh', command: 'printf BEFORE-STOP; sleep 10', signal: abort.signal,
    onOutput: bytes => { if (Buffer.from(bytes).toString().includes('BEFORE-STOP')) abort.abort() },
  })
  expect(evidence.execution.status).toBe('stopped')
  expect(evidence.execution.exitCode).toBeNull()
  expect(evidence.result.output).toContain('BEFORE-STOP')
  expect(evidence.delivery.requests).toHaveLength(1)
  expect(evidence.delivery.frames.some(frame => frame.type === 'assistant')).toBe(true)
}), 40_000)
