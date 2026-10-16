import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

test('cold resume restores the engine worktree cwd without adopting an external checkout branch', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-provenance-')))
  const cwd = join(root, 'project')
  const worktree = join(root, 'entered-worktree')
  const config = join(root, 'config')
  const home = join(root, 'home')
  mkdirSync(cwd); mkdirSync(config); mkdirSync(home)
  const blocker = join(root, 'block-network.ts')
  writeFileSync(blocker, 'globalThis.fetch = async () => { throw new Error("Network disabled in workspace fixture") }\n')
  const git = (at: string, ...args: string[]) => execFileSync('git', ['-C', at, ...args], { stdio: 'pipe' })
  const children: Array<ReturnType<typeof Bun.spawn>> = []
  try {
    git(cwd, 'init', '-b', 'main')
    git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial')
    git(cwd, 'worktree', 'add', '-b', 'entered', worktree)
    const sessionId = randomUUID()
    const run = async (mode: string) => {
      const child = Bun.spawn(['bun', `--preload=${blocker}`, resolve('app/sidecar/workspaceObservation.fixture.ts'), mode, sessionId, worktree], {
        cwd,
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: config,
          CLAUDE_CONFIG_DIR: config,
          ANTHROPIC_API_KEY: 'sk-ant-isolated-test',
          CLAUDE_CODE_SIMPLE: '1',
          TEST_ENABLE_SESSION_PERSISTENCE: '1',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      children.push(child)
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      expect(code, `${mode} failed: ${stderr}`).toBe(0)
      return stdout
    }
    await run('mint')
    git(worktree, 'switch', '-c', 'external')
    const stdout = await run('resume')
    const line = stdout.split('\n').find(row => row.startsWith('OBSERVATION='))
    expect(line, stdout).toBeDefined()
    const result = JSON.parse(line!.slice('OBSERVATION='.length))
    expect(result).toEqual({
      actualCwd: worktree,
      recordedBranch: 'entered',
      restored: { cwd: worktree, lastWorkingBranch: 'entered' },
      observedAgain: { cwd: worktree, lastWorkingBranch: 'entered' },
      continued: { cwd: worktree, lastWorkingBranch: 'external' },
    })
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
    await Promise.all(children.map(child => child.exited))
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
