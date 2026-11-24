import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type RequestEvidence = { modelRound: number; prefix: string; cwd: string }
type Evidence = { models: RequestEvidence[]; reviews: RequestEvidence[]; failures: string[]; approvals: string[]; gitApprovals: string[]; workerRound: number; workerResumeRefusal: string; cwd: string; unmergedBeforeCommit: string }

async function runPhase(root: string, phase: string): Promise<Evidence> {
  const result = Bun.spawnSync([
    process.execPath, '--feature=TRANSCRIPT_CLASSIFIER', '--feature=AUTO_MODE_UPSTREAM_PORT',
    new URL('./worktreeInstructions.fixture.ts', import.meta.url).pathname,
  ], {
    cwd: join(root, 'workspace'), stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
    env: {
      PATH: process.env.PATH, HOME: root, TMPDIR: root,
      CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
      ANTHROPIC_API_KEY: 'isolated-fixture-not-a-credential', CLAUDE_CODE_USE_OPENAI: '0',
      CLAUDE_CODE_AUTO_MODE_MODEL: 'sonnet', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', WORKTREE_INSTRUCTIONS_TEST_ROOT: root,
      WORKTREE_CWD_PHASE: phase,
    },
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return JSON.parse(await readFile(join(root, 'evidence.json'), 'utf8'))
}

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
    const rules = join(workspace, '.cat-code', 'rules')
    await mkdir(rules, { recursive: true })
    const scopedRule = join(rules, 'package.md')
    await writeFile(scopedRule, '---\npaths:\n  - packages/**\n---\nWORKTREE_SCOPED_POLICY\n')
    git('add', 'CLAUDE.md', '.cat-code/rules/package.md')
    git('commit', '-q', '-m', 'synthetic fixture')
    await writeFile(join(workspace, 'CLAUDE.md'), 'ROOT_POLICY: Ask before deleting the synthetic package.\n')
    await writeFile(scopedRule, '---\npaths:\n  - packages/**\n---\nROOT_SCOPED_POLICY\n')
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
    expect(evidence.failures).toHaveLength(2)
    for (const failure of evidence.failures) expect(failure).toContain('New instructions')
    expect(evidence.models.map(request => request.modelRound)).toEqual([1, 2, 3, 4, 5])
    for (const request of [...evidence.models, ...evidence.reviews]) {
      const expected = request.modelRound === 2 || request.modelRound === 3 ? 'WORKTREE_POLICY' : 'ROOT_POLICY'
      const absent = expected === 'WORKTREE_POLICY' ? 'ROOT_POLICY' : 'WORKTREE_POLICY'
      expect(request.prefix).toContain(expected)
      expect(request.prefix).not.toContain(absent)
      expect(request.prefix).toContain('CLAUDE.md')
      expect(request.prefix).toContain(expected.replace('_POLICY', '_SCOPED_POLICY'))
      expect(request.prefix).not.toContain(absent.replace('_POLICY', '_SCOPED_POLICY'))
      expect(request.prefix).toContain('packages')
    }
    const worktree = evidence.models[1]!.cwd
    expect(worktree).not.toBe(workspace)
    expect(evidence.models[3]!.cwd).toBe(workspace)
    expect(evidence.reviews.some(request => request.modelRound === 1 && request.cwd === worktree)).toBe(false)
    expect(evidence.reviews.some(request => request.modelRound === 3 && request.cwd === workspace)).toBe(false)
    expect(evidence.reviews.some(request => request.modelRound === 2 && request.cwd === worktree)).toBe(true)
    expect(evidence.reviews.some(request => request.modelRound === 4 && request.cwd === workspace)).toBe(true)
    expect(await readFile(join(worktree, 'fresh-first.txt'), 'utf8')).toBe('fixture')
    expect(await readFile(join(workspace, 'fresh-second.txt'), 'utf8')).toBe('fixture')
    await expect(readFile(join(worktree, 'stale-first.txt'), 'utf8')).rejects.toThrow('ENOENT')
    await expect(readFile(join(workspace, 'stale-second.txt'), 'utf8')).rejects.toThrow('ENOENT')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

test('relative tools keep their checkout on a new turn and return after a cold reopen', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'worktree-cwd-')))
  const primary = join(root, 'workspace')
  try {
    await mkdir(join(root, 'config'))
    await mkdir(primary)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: primary, stdio: 'pipe' })
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'fixture@example.invalid')
    git('config', 'user.name', 'Fixture')
    git('commit', '-q', '--allow-empty', '-m', 'fixture')
    expect((await runPhase(root, 'enter')).failures).toEqual([])
    const { worktreePath } = JSON.parse(await readFile(join(root, 'checkout.json'), 'utf8'))
    for (const name of ['next-shell.txt', 'next-file.txt', 'next-inline.txt']) {
      expect(await readFile(join(worktreePath, name), 'utf8')).toBe('fixture')
      await expect(readFile(join(primary, name))).rejects.toThrow('ENOENT')
    }
    expect((await runPhase(root, 'reopen')).failures).toEqual([])
    for (const name of ['return-shell.txt', 'return-file.txt', 'return-inline.txt']) {
      expect(await readFile(join(primary, name), 'utf8')).toBe('fixture')
      await expect(readFile(join(worktreePath, name))).rejects.toThrow('ENOENT')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

for (const phase of ['borrow', 'borrow-denied', 'borrow-replaced', 'borrow-keep', ...(process.platform === 'darwin' ? ['borrow-sandbox'] : [])]) {
  test('existing worktree transition: ' + phase, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'borrowed-worktree-')))
    const primary = join(root, 'workspace')
    const sibling = join(root, 'sibling')
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim()
    try {
      await mkdir(join(root, 'config'))
      await mkdir(primary)
      git(primary, 'init', '-q', '-b', 'main')
      git(primary, 'config', 'user.email', 'fixture@example.invalid')
      git(primary, 'config', 'user.name', 'Fixture')
      const commit = async (cwd: string, text: string) => {
        await writeFile(join(cwd, 'conflict.txt'), text + '\n')
        git(cwd, 'add', '--', 'conflict.txt')
        git(cwd, 'commit', '-qm', text)
      }
      await commit(primary, 'base')
      git(primary, 'worktree', 'add', '-qb', 'integration', sibling)
      await commit(primary, 'primary')
      await commit(sibling, 'integration')
      expect(() => git(sibling, 'merge', 'main')).toThrow()
      const oldPrimary = git(primary, 'rev-parse', 'HEAD')
      const oldSibling = git(sibling, 'rev-parse', 'HEAD')
      const conflict = await readFile(join(sibling, 'conflict.txt'), 'utf8')
      if (phase === 'borrow-sandbox') {
        await writeFile(join(root, 'config', 'settings.json'), JSON.stringify({ sandbox: { enabled: true } }))
        await writeFile(join(primary, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nprintf forbidden > ../workspace/hook-denied || printf isolated > hook-sandbox\n', { mode: 0o755 })
      }
      const evidence = await runPhase(root, phase)
      expect(evidence.approvals).toHaveLength(1)
      expect(evidence.approvals[0]).toContain(sibling)
      if (phase === 'borrow') {
        expect(evidence.failures).toEqual([])
        expect(evidence.workerRound).toBeGreaterThan(0)
        expect(evidence.workerResumeRefusal).toContain('Resume the worker from the worktree where it started.')
        expect(evidence.unmergedBeforeCommit).toContain('conflict.txt')
        expect(git(sibling, 'show', '-s', '--format=%P')).toBe(oldSibling + ' ' + oldPrimary)
        expect(await readFile(join(sibling, 'conflict.txt'), 'utf8')).toBe('resolved by worker\n')
      } else if (phase === 'borrow-keep') {
        expect(evidence.failures).toEqual([])
        const config = join(root, 'config', 'settings.json')
        await writeFile(config, JSON.stringify({ hooks: { SessionStart: [{ matcher: 'resume', hooks: [{ type: 'command', command: 'printf hook > resume-hook.txt' }] }] } }))
        const reopened = await runPhase(root, 'borrow-reopen')
        expect(reopened.failures).toEqual(['Error: Cat Code did not create this worktree and cannot remove it.'])
        expect(reopened.cwd).toBe(primary)
        expect(await readFile(join(sibling, 'resume-hook.txt'), 'utf8')).toBe('hook')
        await expect(readFile(join(primary, 'resume-hook.txt'))).rejects.toThrow('ENOENT')
        expect(git(sibling, 'rev-parse', 'MERGE_HEAD')).toBe(oldPrimary)
        expect(await readFile(join(sibling, 'conflict.txt'), 'utf8')).toBe(conflict)
        await rename(sibling, sibling + '-moved')
        const rejected = await runPhase(root, 'borrow-reopen-missing')
        expect(rejected.cwd).toBe(primary)
        expect(rejected.failures[0]).toContain('changed or is unavailable')
        await expect(readFile(join(primary, 'resume-hook.txt'))).rejects.toThrow('ENOENT')
      } else if (phase === 'borrow-sandbox') {
        expect(evidence.failures).toEqual([])
        expect(evidence.gitApprovals).toEqual(['git add -- conflict.txt', 'git commit -m resolved'])
        expect(evidence.unmergedBeforeCommit).toContain('conflict.txt')
        expect(git(sibling, 'show', '-s', '--format=%P')).toBe(oldSibling + ' ' + oldPrimary)
        expect(await readFile(join(sibling, 'conflict.txt'), 'utf8')).toBe('resolved by worker\n')
        expect((await runPhase(root, 'borrow-sandbox-reopen')).failures).toEqual([])
        expect(await readFile(join(sibling, 'hook-sandbox'), 'utf8')).toBe('isolated')
        await expect(readFile(join(primary, 'hook-denied'))).rejects.toThrow('ENOENT')
        for (const step of ['warm', 'cold']) {
          expect(await readFile(join(sibling, step + '-allowed'), 'utf8')).toBe('allowed')
          await expect(readFile(join(primary, step + '-denied'))).rejects.toThrow('ENOENT')
        }
      } else {
        expect(evidence.cwd).toBe(primary)
        expect(evidence.failures).toHaveLength(1)
        const untouched = phase === 'borrow-replaced' ? sibling + '-moved' : sibling
        expect(await readFile(join(untouched, 'conflict.txt'), 'utf8')).toBe(conflict)
      }
      expect(git(primary, 'rev-parse', 'HEAD')).toBe(oldPrimary)
      expect(git(primary, 'status', '--porcelain')).toBe('')
      expect(await readFile(join(primary, 'conflict.txt'), 'utf8')).toBe('primary\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
}
