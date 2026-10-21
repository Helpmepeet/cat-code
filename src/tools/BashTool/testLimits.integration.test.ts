import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../Tool.js'
import { asAgentId } from '../../types/ids.js'
import { ShellError } from '../../utils/errors.js'
import { isLocalShellTask } from '../../tasks/LocalShellTask/guards.js'
import { BashTool } from './BashTool.js'

let work: string
const names = ['CLAUDE_CONFIG_DIR', 'CAT_CODE_TEST_TIMEOUT_MS', 'CAT_CODE_TEST_MAX_MEMORY_MB'] as const
const previous = names.map(name => process.env[name])
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'bash-test-limits-'))
  process.env.CLAUDE_CONFIG_DIR = work
})
afterAll(() => {
  names.forEach((name, i) => {
    if (previous[i] === undefined) delete process.env[name]
    else process.env[name] = previous[i]
  })
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

async function waitForTask(context: ToolUseContext, taskId: string) {
  for (let i = 0; i < 200; i++) {
    const task = context.getAppState().tasks[taskId]
    if (isLocalShellTask(task) && task.status !== 'running') return task
    await Bun.sleep(20)
  }
  throw new Error('task did not terminate')
}

test.skipIf(process.platform === 'win32')('finite test memory is bounded outside its blocked event loop', async () => {
  process.env.CAT_CODE_TEST_TIMEOUT_MS = '10000'
  process.env.CAT_CODE_TEST_MAX_MEMORY_MB = '192'
  // Self-bounded to 256 MiB even on the broken implementation. The busy loop
  // blocks the test runner's own timer, but not the engine's resource monitor.
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
  try { await BashTool.call({ command }, context()) } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(ShellError)
  expect((error as ShellError).stderr).toContain('memory limit')
  const pid = Number(readFileSync(pidFile, 'utf8'))
  let alive = true
  for (let i = 0; i < 50 && alive; i++) {
    try { process.kill(pid, 0); await Bun.sleep(20) } catch { alive = false }
  }
  expect(alive).toBe(false)
})

test.skipIf(process.platform === 'win32')('the test deadline survives explicit and timeout-driven backgrounding', async () => {
  process.env.CAT_CODE_TEST_TIMEOUT_MS = '800'
  process.env.CAT_CODE_TEST_MAX_MEMORY_MB = '512'
  for (const explicit of [true, false]) {
    const ctx = context()
    const command = fixture(`deadline-${explicit}`, 'await Bun.sleep(1800);')
    try {
      const { data } = await BashTool.call({ command, timeout: 100,
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

test('ordinary background commands keep running beyond the configured test deadline', async () => {
  process.env.CAT_CODE_TEST_TIMEOUT_MS = '100'
  process.env.CAT_CODE_TEST_MAX_MEMORY_MB = '1'
  for (const input of [
    { command: `${JSON.stringify(process.execPath)} -e 'setTimeout(() => console.log("ordinary done"), 600)'` },
    { command: fixture('service', 'await Bun.sleep(600);'), work_lifetime: 'service' as const },
  ]) {
    const ctx = context()
    try {
      const { data } = await BashTool.call({ ...input, timeout: 100, run_in_background: true }, ctx)
      expect(data.backgroundTaskId).toBeDefined()
      const task = await waitForTask(ctx, data.backgroundTaskId!)
      expect(task.status).toBe('completed')
      expect(task.result?.code).toBe(0)
    } finally {
      for (const task of Object.values(ctx.getAppState().tasks)) {
        if (isLocalShellTask(task) && task.status === 'running') task.shellCommand?.kill()
      }
    }
  }
})
