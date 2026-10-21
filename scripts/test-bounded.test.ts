import { afterAll, beforeAll, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultAppState } from '../src/state/AppStateStore.js'
import type { ToolUseContext } from '../src/Tool.js'
import { asAgentId } from '../src/types/ids.js'
import { ShellError } from '../src/utils/errors.js'
import { isLocalShellTask } from '../src/tasks/LocalShellTask/guards.js'
import { BashTool } from '../src/tools/BashTool/BashTool.js'

let work: string
const previous = process.env.CLAUDE_CONFIG_DIR
const runner = fileURLToPath(new URL('./test-bounded.ts', import.meta.url))
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'bash-test-limits-'))
  process.env.CLAUDE_CONFIG_DIR = work
})
afterAll(() => {
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previous
  rmSync(work, { recursive: true, force: true })
})

function context() {
  let state = getDefaultAppState()
  return {
    abortController: new AbortController(),
    getAppState: () => state,
    setAppState: (update: (prev: typeof state) => typeof state) => { state = update(state) },
    agentId: asAgentId('test-resource-limits'), toolUseId: 'test-resource-limits',
  } as unknown as ToolUseContext
}

function fixture(name: string, body: string): string {
  const path = join(work, `${name}.test.ts`)
  writeFileSync(path, `import { test } from 'bun:test'; test('fixture', async () => { ${body} });`)
  return `${JSON.stringify(process.execPath)} test ${JSON.stringify(path)}`
}

function bounded(command: string, timeoutMs: number, memoryMb: number): string {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(runner)} --timeout-ms ${timeoutMs} --memory-mb ${memoryMb} -- ${command}`
}

async function waitForTask(context: ToolUseContext, taskId: string) {
  for (let i = 0; i < 200; i++) {
    const task = context.getAppState().tasks[taskId]
    if (isLocalShellTask(task) && task.status !== 'running') return task
    await Bun.sleep(20)
  }
  throw new Error('task did not terminate')
}

test.skipIf(process.platform !== 'darwin')('the explicit runner caps a blocked detached child and reaps it', async () => {
  // Self-bounded to 256 MiB even on the broken implementation. The busy loop
  // blocks the test runner's own timer, but not the supervisor.
  const pidFile = join(work, 'allocation.pid')
  const workerFile = join(work, 'allocation-worker.ts')
  writeFileSync(workerFile, `
    import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    const allocations = [];
    for (let i = 0; i < 16; i++) {
      allocations.push(new Uint8Array(16 * 1024 * 1024).fill(7));
      const until = Date.now() + 50; while (Date.now() < until) {}
    }
    console.log('allocation fixture completed', allocations.length);
  `)
  const command = fixture('allocation', `
    const { spawn } = await import('node:child_process');
    const { once } = await import('node:events');
    const child = spawn(process.execPath, [${JSON.stringify(workerFile)}], {
      detached: true, stdio: 'ignore',
    });
    await once(child, 'exit');
  `)
  let error: unknown
  try { await BashTool.call({ command: bounded(command, 10000, 192) }, context()) } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(ShellError)
  expect((error as ShellError).stderr).toContain('memory limit')
  const pid = Number(readFileSync(pidFile, 'utf8'))
  let alive = true
  for (let i = 0; i < 50 && alive; i++) {
    try { process.kill(pid, 0); await Bun.sleep(20) } catch { alive = false }
  }
  expect(alive).toBe(false)
})

test.skipIf(process.platform !== 'darwin')('the test deadline survives explicit and timeout-driven backgrounding', async () => {
  for (const explicit of [true, false]) {
    const ctx = context()
    const command = fixture(`deadline-${explicit}`, 'await Bun.sleep(1800);')
    try {
      const { data } = await BashTool.call({ command: bounded(command, 800, 512), timeout: 100,
        ...(explicit ? { run_in_background: true } : {}),
      }, ctx)
      expect(data.backgroundTaskId).toBeDefined()
      const task = await waitForTask(ctx, data.backgroundTaskId!)
      expect(task.status).toBe('failed')
      expect(task.result?.code).toBe(137)
    } finally {
      for (const task of Object.values(ctx.getAppState().tasks)) {
        if (isLocalShellTask(task) && task.status === 'running') task.shellCommand?.kill()
      }
    }
  }
})

test.skipIf(process.platform !== 'darwin')('the runner preserves argv, output and exit codes', async () => {
  for (const code of [0, 7]) {
    const child = spawn(process.execPath, [runner, '--', process.execPath, '-e',
      'console.log(process.argv[1]); process.exit(Number(process.argv[2]))',
      'one argument; not shell code', String(code),
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout!.on('data', chunk => { stdout += chunk.toString() })
    child.stderr!.on('data', chunk => { stderr += chunk.toString() })
    const exitCode = await new Promise(resolve => child.once('close', resolve))
    expect(exitCode).toBe(code)
    expect(stdout.trim()).toBe('one argument; not shell code')
    expect(stderr).toBe('')
  }
})
