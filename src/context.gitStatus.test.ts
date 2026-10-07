import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const git = Bun.which('git')!
const contextPath = join(import.meta.dir, 'context.ts')
const cwdPath = join(import.meta.dir, 'utils/cwd.ts')

async function probe(mode: string, dirty = false) {
  const root = mkdtempSync(join(tmpdir(), 'git-prompt-context-'))
  const project = join(root, 'project')
  const bin = join(root, 'bin')
  const pidsPath = join(root, 'pids')
  const monitorPath = join(root, 'monitor-called')
  mkdirSync(project)
  mkdirSync(bin)
  const env = {
    PATH: process.env.PATH ?? '',
    NODE_ENV: 'development',
    DISABLE_TELEMETRY: '1',
    CLAUDE_CONFIG_DIR: join(root, 'config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(root, 'empty-config'),
    GIT_AUTHOR_NAME: 'Prompt Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Prompt Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.test',
  }
  const runGit = (...args: string[]) => {
    const result = Bun.spawnSync([git, ...args], { cwd: project, env })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  }
  runGit('init', '--initial-branch=feature')
  writeFileSync(join(project, 'tracked.txt'), 'initial\n')
  runGit('add', 'tracked.txt')
  runGit('commit', '-m', 'fixture commit')
  if (dirty) writeFileSync(join(project, 'tracked.txt'), 'modified\n')

  // Each shim is a real child; the hanging one resists a graceful timeout.
  writeFileSync(join(bin, 'git'), `#!${process.execPath}\n
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.PROBE_PIDS, process.pid + '\\n');
const args = process.argv.slice(2);
const command = args.includes('status') ? 'status' : args.includes('log') ? 'log' : 'user';
if (process.env.PROBE_MODE === 'hang-' + command) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (process.env.PROBE_MODE === 'fail-' + command) {
  process.exit(1);
} else {
  const child = Bun.spawn([process.env.PROBE_GIT, ...args], { stdout: 'inherit', stderr: 'inherit' });
  appendFileSync(process.env.PROBE_PIDS, child.pid + '\\n');
  process.exit(await child.exited);
}
`)
  chmodSync(join(bin, 'git'), 0o755)
  const hook = join(root, 'fsmonitor-hook')
  writeFileSync(hook, `#!${process.execPath}\n
import { appendFileSync, writeFileSync } from 'node:fs';
appendFileSync(process.env.PROBE_PIDS, process.pid + '\\n');
writeFileSync(process.env.PROBE_MONITOR, 'called');
setTimeout(() => process.exit(1), 100);
`)
  chmodSync(hook, 0o755)

  let runner: ReturnType<typeof Bun.spawn> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    runner = Bun.spawn([process.execPath, '--eval', `
      const { getGitStatus } = await import(${JSON.stringify(contextPath)});
      const { runWithCwdOverride } = await import(${JSON.stringify(cwdPath)});
      const start = performance.now();
      const context = await runWithCwdOverride(process.env.PROBE_PROJECT, () => getGitStatus());
      console.log('RESULT:' + JSON.stringify({context, elapsed: performance.now() - start}));
      process.exit(0);
    `], {
      cwd: project,
      env: {
        ...env,
        PATH: bin + ':' + env.PATH,
        PROBE_GIT: git,
        PROBE_MODE: mode,
        PROBE_PROJECT: project,
        PROBE_PIDS: pidsPath,
        PROBE_MONITOR: monitorPath,
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'user.name',
        GIT_CONFIG_VALUE_0: 'Prompt Fixture',
        GIT_CONFIG_KEY_1: 'core.fsmonitor',
        GIT_CONFIG_VALUE_1: hook,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    deadline = setTimeout(() => runner?.kill('SIGKILL'), 4000)
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(runner.stdout).text(),
      new Response(runner.stderr).text(),
      runner.exited,
    ])
    if (exitCode !== 0) throw new Error(`Optional Git context exceeded probe deadline: ${stderr}`)
    const resultLine = stdout.split('\n').find(line => line.startsWith('RESULT:'))
    if (!resultLine) throw new Error(`No Git context result: ${stderr}`)
    const result = JSON.parse(resultLine.slice('RESULT:'.length)) as {
      context: string | null
      elapsed: number
    }
    const pids = existsSync(pidsPath)
      ? readFileSync(pidsPath, 'utf8').trim().split('\n').map(Number)
      : []
    return {
      ...result,
      monitorCalled: existsSync(monitorPath),
      childAlive: pids.some(pid => {
        try { process.kill(pid, 0); return true } catch { return false }
      }),
    }
  } finally {
    if (deadline) clearTimeout(deadline)
    runner?.kill('SIGKILL')
    if (runner) await runner.exited
    if (existsSync(pidsPath)) {
      for (const pid of readFileSync(pidsPath, 'utf8').trim().split('\n').map(Number)) {
        try { process.kill(pid, 'SIGKILL') } catch { /* Already reaped by the owner. */ }
      }
    }
    rmSync(root, { recursive: true, force: true })
  }
}

test('successful prompt snapshots bypass the configured fsmonitor and preserve Git metadata', async () => {
  const result = await probe('success', true)
  expect(result.monitorCalled).toBe(false)
  expect(result.elapsed).toBeLessThan(2500)
  expect(result.context).toContain('Current branch: feature')
  expect(result.context).toContain('Git user: Prompt Fixture')
  expect(result.context).toContain('Status:\nM tracked.txt')
  expect(result.context).toContain('fixture commit')
}, 6000)

test('successful empty status is still reported as clean', async () => {
  expect((await probe('success')).context).toContain('Status:\n(clean)')
}, 6000)

for (const command of ['status', 'log', 'user']) {
  test(`nonzero ${command} omits unavailable optional Git context`, async () => {
    expect((await probe('fail-' + command)).context).toBeNull()
  }, 6000)

  test(`hung ${command} is killed before optional Git context falls back`, async () => {
    const result = await probe('hang-' + command)
    expect(result.context).toBeNull()
    expect(result.elapsed).toBeLessThan(2500)
    expect(result.childAlive).toBe(false)
  }, 6000)
}
