import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type RequestEvidence = { modelRound: number; prefix: string; cwd: string }
type Evidence = { models: RequestEvidence[]; reviews: RequestEvidence[]; failures: string[] }

test('worktree transitions change main and reviewer instructions at the next model request', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'worktree-instructions-')))
  const workspace = join(root, 'workspace')
  try {
    await mkdir(join(root, 'config'))
    await mkdir(workspace)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' })
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'fixture@example.invalid')
    git('config', 'user.name', 'Fixture')
    await writeFile(join(workspace, 'CLAUDE.md'), 'WORKTREE_POLICY: Ask before publishing the synthetic package.\n')
    git('add', 'CLAUDE.md')
    git('commit', '-q', '-m', 'synthetic fixture')
    await writeFile(join(workspace, 'CLAUDE.md'), 'ROOT_POLICY: Ask before deleting the synthetic package.\n')
    const child = Bun.spawn([
      process.execPath, '--feature=TRANSCRIPT_CLASSIFIER', '--feature=AUTO_MODE_UPSTREAM_PORT',
      new URL('./worktreeInstructions.fixture.ts', import.meta.url).pathname,
    ], {
      cwd: workspace, stdout: 'pipe', stderr: 'pipe',
      env: {
        PATH: process.env.PATH, HOME: root, TMPDIR: root,
        CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
        ANTHROPIC_API_KEY: 'isolated-fixture-not-a-credential', CLAUDE_CODE_USE_OPENAI: '0',
        CLAUDE_CODE_AUTO_MODE_MODEL: 'sonnet',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
        WORKTREE_INSTRUCTIONS_TEST_ROOT: root,
      },
    })
    const timer = setTimeout(() => child.kill(), 40_000)
    const [exit, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    clearTimeout(timer)
    if (exit !== 0) throw new Error(`Worktree fixture failed (${exit}): ${stderr}\n${stdout}`)
    const evidence = JSON.parse(await readFile(join(root, 'evidence.json'), 'utf8')) as Evidence
    expect(evidence.failures).toEqual([])
    expect(evidence.models.map(request => request.modelRound)).toEqual([1, 2, 3])
    for (const request of [...evidence.models, ...evidence.reviews]) {
      const expected = request.modelRound === 2 ? 'WORKTREE_POLICY' : 'ROOT_POLICY'
      const absent = request.modelRound === 2 ? 'ROOT_POLICY' : 'WORKTREE_POLICY'
      expect(request.prefix).toContain(expected)
      expect(request.prefix).not.toContain(absent)
      expect(request.prefix).toContain('CLAUDE.md')
    }
    // Both post-transition shell calls were emitted in the same response as
    // the transition. Their reviews must use the prefix that model saw.
    expect(evidence.models[1]!.cwd).not.toBe(workspace)
    expect(evidence.models[2]!.cwd).toBe(workspace)
    expect(evidence.reviews.some(request => request.modelRound === 1 && request.cwd !== workspace)).toBe(true)
    expect(evidence.reviews.some(request => request.modelRound === 2 && request.cwd === workspace)).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
