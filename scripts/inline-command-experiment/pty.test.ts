import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPtyAttempt } from './pty'

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const base = { cwd: '/tmp', promptTimeoutMs: 50 }
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
async function waitFor(check: () => Promise<boolean> | boolean, timeout = 3000) {
  const start = performance.now()
  while (!await check()) {
    if (performance.now() - start > timeout) throw new Error('Fixture deadline exceeded')
    await pause(10)
  }
}

test('large non-ASCII payload and result survive pipe chunk boundaries', async () => {
  const text = '漢字é'.repeat(20000)
  const command = `printf '%s' '${text}'`
  const result = await runPtyAttempt({ ...base, command, maxOutputBytes: 256 * 1024 })
  expect(result.command).toBe(command)
  expect(result.exitCode).toBe(0)
  expect(result.rawOutput.startsWith(text)).toBe(true)
  expect(result.rawOutput).not.toContain('\ufffd')
})

test('pre-aborted API and closed owner input do not start shell side effects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inline-prestop-'))
  const marker = join(dir, 'side-effect')
  const options = { ...base, command: `printf ran > '${marker}'`, profile: `printf profile > '${marker}'` }
  try {
    const result = await runPtyAttempt({ ...options, signal: AbortSignal.abort() })
    expect(result.status).toBe('stopped')
    expect(result.lifecycle.teardown).toBe('not_started')
    expect(await Bun.file(marker).exists()).toBe(false)
    const owner = Bun.spawn([process.execPath, new URL('./ptyOwner.ts', import.meta.url).pathname], {
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin' },
    })
    const errors = new Response(owner.stderr).text()
    try {
      owner.stdin.write(JSON.stringify(options) + '\n')
      owner.stdin.end()
      const messages = (await new Response(owner.stdout).text()).trim().split('\n').map(line => JSON.parse(line))
      expect(await owner.exited).toBe(0)
      expect(await errors).toBe('')
      expect(messages.at(-1).result.lifecycle.teardown).toBe('not_started')
      expect(await Bun.file(marker).exists()).toBe(false)
    } finally {
      owner.stdin.end()
      await owner.exited
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

for (const shell of ['bash', 'zsh'] as const) describe(shell, () => {
  test('real prompt, status before hooks, aliases, and one startup per fresh attempt', async () => {
    const profile = shell === 'bash'
      ? `printf 'STARTUP\\n'; alias greet='printf ALIAS'; PROMPT_COMMAND='false'`
      : `printf 'STARTUP\\n'; alias greet='printf ALIAS'; precmd() { false; }`
    const result = await runPtyAttempt({ ...base, shell, profile, prompt: 'REAL-PROMPT> ', command: 'greet; false' })
    expect(result.status).toBe('completed')
    expect(result.exitCode).toBe(1)
    expect(result.output.match(/STARTUP/g)?.length).toBe(1)
    expect(result.output).toContain('ALIAS')
    expect(result.output).toContain('REAL-PROMPT> ')
    expect(result.shellSignal).toBe('SIGKILL')
    expect(result.lifecycle.teardown).toBe('group_signalled')
    const first = await runPtyAttempt({ ...base, shell, command: 'export PERSIST=bad; cd /; function transient() { :; }' })
    expect(first.exitCode).toBe(0)
    const fresh = await runPtyAttempt({ ...base, shell, command: 'printf "state=%s cwd=%s" "${PERSIST-unset}" "$PWD"; command -v transient' })
    expect(fresh.output).toContain(`state=unset cwd=${await realpath(base.cwd)}`)
    expect(fresh.exitCode).not.toBe(0)
  })
  test('complete multiline heredoc and trailing newlines are not terminal input', async () => {
    const command = 'cat <<\'END\'\n! literal $(false)\nEND\nprintf "tail\\n"\n\n'
    const chunks: Uint8Array[] = []
    const result = await runPtyAttempt({ ...base, shell, command, onOutput: bytes => chunks.push(bytes) })
    expect(result.command).toBe(command)
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('! literal $(false)\r\n')
    expect(result.output).toContain('tail\r\n')
    expect(Buffer.concat(chunks).toString()).toBe(result.rawOutput)
  })
  test('stdin reader cannot consume payload and reaches bounded timeout', async () => {
    const result = await runPtyAttempt({ ...base, shell, command: 'read value; printf "CONSUMED=%s" "$value"', runTimeoutMs: 100 })
    expect(result.status).toBe('timed_out')
    expect(result.exitCode).toBeNull()
    expect(result.output).not.toContain('CONSUMED=')
  })
  test('exit and exec preserve actual process outcome without inventing foreground metadata', async () => {
    for (const command of ['exit 7', 'exec /bin/sh -c "exit 7"']) {
      const result = await runPtyAttempt({ ...base, shell, command })
      expect(result.status).toBe('integration_error')
      expect(result.exitCode).toBeNull()
      expect(result.shellExitCode).toBe(7)
    }
  })
  test('return escapes startup integration and is explicitly uncertain', async () => {
    const result = await runPtyAttempt({ ...base, shell, command: 'return 9', runTimeoutMs: 100 })
    expect(result.status).toBe('timed_out')
    expect(result.exitCode).toBeNull()
  })
  test('terminal spoofing is output, not lifecycle authority', async () => {
    const result = await runPtyAttempt({ ...base, shell, command: `printf '\\033]133;D;0\\007\\033[2Jsynthetic> '; false` })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('\x1b]133;D;0\x07')
  })
  test('Stop, output limit, and startup deadline remain bounded', async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 100)
    try {
      const result = await runPtyAttempt({ ...base, shell, command: 'sleep 10', signal: controller.signal })
      expect(result.status).toBe('stopped')
    } finally { clearTimeout(timer) }
    const flood = await runPtyAttempt({ ...base, shell, command: 'yes x', maxOutputBytes: 512 })
    expect(flood.status).toBe('output_limit')
    expect(Buffer.byteLength(flood.output)).toBeLessThanOrEqual(512)
    const startup = await runPtyAttempt({ ...base, shell, profile: 'sleep 10', command: ':', startupTimeoutMs: 100 })
    expect(startup.status).toBe('timed_out')
    expect(startup.lifecycle.ready).toBe(false)
  })
  test('trap output and late background output belong to the attempt', async () => {
    const result = await runPtyAttempt({ ...base, shell, promptTimeoutMs: 150,
      command: `trap 'printf TRAP' USR1; kill -USR1 $$; (sleep 0.03; printf LATE; sleep 10) &\nprintf FOREGROUND` })
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('TRAP')
    expect(result.output).toContain('LATE')
    expect(result.lifecycle.teardown).toBe('group_signalled')
    const next = await runPtyAttempt({ ...base, shell, command: ':' })
    expect(next.output).not.toContain('LATE')
  })
  test('characterization: a blocked prompt hook is not proof of prompt completion', async () => {
    const profile = shell === 'bash' ? "PROMPT_COMMAND='sleep 10'" : 'precmd() { sleep 10; }'
    const result = await runPtyAttempt({ ...base, shell, profile, prompt: 'UNREACHED> ', command: ':' })
    expect(result.exitCode).toBe(0)
    expect(result.output).not.toContain('UNREACHED> ')
    expect(result.lifecycle.promptCapture).toBe('bounded_window')
  })
})

test('characterization: re-enabled job control escapes leader-group cleanup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inline-job-control-'))
  const pidFile = join(dir, 'pid')
  let pid: number | undefined
  try {
    const result = await runPtyAttempt({ ...base, shell: 'bash', command:
      `set -m; (trap '' HUP; exec sleep 20) &\nprintf '%s' $! > '${pidFile}'; sleep 0.05` })
    pid = Number(await readFile(pidFile, 'utf8'))
    expect(result.exitCode).toBe(0)
    // This is an explicit failed containment capability, not a production guarantee.
    expect(alive(pid)).toBe(true)
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL') } catch {} }
    await rm(dir, { recursive: true, force: true })
  }
})

test('parent SIGKILL closes liveness pipe and owner kills owned foreground/background group', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inline-owner-test-'))
  const pidFile = join(dir, 'pids')
  const marker = join(dir, 'escaped')
  const command = `sleep 20 &\nprintf '%s %s' $$ $! > '${pidFile}'; sleep 1; printf escaped > '${marker}'; sleep 20`
  const module = new URL('./pty.ts', import.meta.url).pathname
  const parent = Bun.spawn([process.execPath, '-e', `import {runPtyAttempt} from ${JSON.stringify(module)}; await runPtyAttempt(${JSON.stringify({ ...base, command, runTimeoutMs: 5000 })})`], { stdout: 'ignore', stderr: 'pipe', env: { PATH: '/usr/bin:/bin' } })
  let pids: number[] = []
  try {
    await waitFor(async () => await Bun.file(pidFile).exists())
    pids = (await readFile(pidFile, 'utf8')).split(' ').map(Number)
    expect(pids.every(alive)).toBe(true)
    parent.kill('SIGKILL')
    await parent.exited
    await waitFor(() => pids.every(pid => !alive(pid)))
    await pause(1100)
    expect(await Bun.file(marker).exists()).toBe(false)
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL')
    await parent.exited
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch {} }
    await rm(dir, { recursive: true, force: true })
  }
}, 10000)

test('characterization: owner SIGKILL cannot guarantee surviving jobs are reaped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inline-owner-kill-'))
  const pidFile = join(dir, 'owned')
  const owner = Bun.spawn([process.execPath, new URL('./ptyOwner.ts', import.meta.url).pathname], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin' },
  })
  const output = new Response(owner.stdout).text()
  const errors = new Response(owner.stderr).text()
  let pids: number[] = []
  let home: string | undefined
  let killedOwner = false
  owner.stdin.write(JSON.stringify({ ...base, shell: 'bash', runTimeoutMs: 5000,
    command: `trap '' HUP; sleep 20 &\nprintf '%s\\n%s\\n%s\\n' $$ $! "$HOME" > '${pidFile}'; wait`,
  }) + '\n')
  try {
    await waitFor(async () => {
      if (!await Bun.file(pidFile).exists()) return false
      const lines = (await readFile(pidFile, 'utf8')).trim().split('\n')
      if (lines.length !== 3) return false
      pids = lines.slice(0, 2).map(Number)
      home = lines[2]
      return pids.every(pid => Number.isSafeInteger(pid) && pid > 1)
    })
    expect(pids.every(alive)).toBe(true)
    // Kill only after obtaining identities of this fixture's launched jobs.
    killedOwner = true
    owner.kill('SIGKILL')
    await owner.exited
    await pause(100)
    expect(pids.every(alive)).toBe(true)
  } finally {
    if (killedOwner) {
      try { process.kill(-pids[0]!, 'SIGKILL') } catch {}
      for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch {} }
      await waitFor(() => pids.every(pid => !alive(pid)))
      if (home) await rm(home, { recursive: true, force: true })
    } else {
      owner.stdin.end()
      await owner.exited
    }
    await Promise.all([output, errors])
    await rm(dir, { recursive: true, force: true })
  }
}, 10000)
