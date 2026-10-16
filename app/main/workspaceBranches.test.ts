import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSessionBranchReader, listWorkspaceBranches, readWorkspaceBranch, switchWorkspaceBranch } from './workspaceBranches.js'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' })
}

function fixture(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'cat-code-branch-'))
  git(cwd, 'init', '-b', 'main')
  git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial')
  git(cwd, 'branch', 'feature/login')
  return cwd
}

test('readouts share a HEAD read without scanning a broken index or enumerating picker state', async () => {
  const cwd = fixture()
  try {
    writeFileSync(join(cwd, '.git', 'index'), 'not a Git index')
    const first = readWorkspaceBranch(cwd)
    const second = readWorkspaceBranch(cwd)
    expect(first === second).toBe(true)
    expect(await first).toEqual({ ok: true, value: { current: 'main' } })
    expect((await listWorkspaceBranches(cwd)).ok).toBe(false)
    git(cwd, 'symbolic-ref', 'HEAD', 'refs/heads/feature/login')
    expect(await readWorkspaceBranch(cwd)).toEqual({ ok: true, value: { current: 'feature/login' } })
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('readout addressing refuses unknown or live-but-unobserved sessions before reading saved paths', async () => {
  let savedReads = 0
  let live = true
  const reader = createSessionBranchReader({
    host: () => ({
      getSessionDescriptor: id => id === 'known' ? { appSessionId: 'known' } as never : undefined,
      getWorkspaceObservation: () => undefined,
      canPreview: () => false,
    }),
    isLive: () => live,
    readSaved: async () => { savedReads++; return { cwd: '/should-not-be-read' } },
  })
  expect((await reader('unknown')).ok).toBe(false)
  expect((await reader('known')).ok).toBe(false)
  live = false
  expect((await reader('known')).ok).toBe(false)
  expect(savedReads).toBe(0)
})

test('preserves Git-valid Unicode whitespace and punctuation in branch names', async () => {
  const cwd = fixture()
  const branch = 'feature/日本語(v2)\u00a0'
  try {
    git(cwd, 'branch', branch)
    const before = await listWorkspaceBranches(cwd)
    expect(before.ok && before.value.branches.includes(branch)).toBe(true)
    expect((await switchWorkspaceBranch(cwd, branch, [])).ok).toBe(true)
    const after = await listWorkspaceBranches(cwd)
    expect(after.ok && after.value.current).toBe(branch)
    expect(after.ok && after.value.branches[0]).toBe(branch)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('a Git lock failure is not reported as worktree occupancy', async () => {
  const cwd = fixture()
  try {
    writeFileSync(join(cwd, '.git', 'index.lock'), '')
    const result = await switchWorkspaceBranch(cwd, 'feature/login', [])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toBe('Git could not switch to that branch. Check Git and try again.')
    const after = await listWorkspaceBranches(cwd)
    expect(after.ok && after.value.current).toBe('main')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('lists local branches and switches a clean checkout', async () => {
  const cwd = fixture()
  try {
    const before = await listWorkspaceBranches(cwd)
    expect(before).toEqual({ ok: true, value: { current: 'main', branches: ['main', 'feature/login'], dirty: false, occupied: {} } })
    const switched = await switchWorkspaceBranch(cwd, 'feature/login', [])
    expect(switched.ok).toBe(true)
    const after = await listWorkspaceBranches(cwd)
    expect(after.ok && after.value.current).toBe('feature/login')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('refuses unlisted branches, dirty work, and another live session in the same repository', async () => {
  const cwd = fixture()
  try {
    const missing = await switchWorkspaceBranch(cwd, '--create', [])
    expect(missing.ok).toBe(false)
    mkdirSync(join(cwd, 'nested'))
    const shared = await switchWorkspaceBranch(cwd, 'feature/login', [join(cwd, 'nested')])
    expect(shared.ok).toBe(false)
    if (!shared.ok) expect(shared.error.message).toContain('other live sessions')
    writeFileSync(join(cwd, 'draft.txt'), 'keep this')
    const listedDirty = await listWorkspaceBranches(cwd)
    expect(listedDirty.ok && listedDirty.value.dirty).toBe(true)
    const dirty = await switchWorkspaceBranch(cwd, 'feature/login', [])
    expect(dirty.ok).toBe(false)
    if (!dirty.ok) expect(dirty.error.message).toContain('Commit or stash')
    const current = await listWorkspaceBranches(cwd)
    expect(current.ok && current.value.current).toBe('main')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('reports a non-Git folder without switching', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cat-code-branch-'))
  try {
    const result = await listWorkspaceBranches(cwd)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('not a Git repository')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('reports detached HEAD and names occupied worktrees before attempting a switch', async () => {
  const cwd = fixture()
  const worktree = mkdtempSync(join(tmpdir(), 'cat-code-occupied-'))
  try {
    git(cwd, 'worktree', 'add', worktree, 'feature/login')
    const before = await listWorkspaceBranches(cwd)
    expect(before.ok && before.value.occupied?.['feature/login']).toBe(worktree.split('/').at(-1))
    const result = await switchWorkspaceBranch(cwd, 'feature/login', [])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain(`open in ${worktree.split('/').at(-1)}`)
    git(cwd, 'switch', '--detach')
    const detached = await listWorkspaceBranches(cwd)
    expect(detached.ok && detached.value.current).toBeNull()
    expect(detached.ok && detached.value.detached).toMatch(/^[a-f0-9]{7,}$/)
  } finally {
    rmSync(worktree, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('orders current first and other branches by most recent commit', async () => {
  const cwd = fixture()
  try {
    const tree = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim()
    const commit = execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit-tree', tree, '-m', 'newer'], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: '2099-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2099-01-01T00:00:00Z' },
    }).trim()
    git(cwd, 'branch', 'z-newest', commit)
    const result = await listWorkspaceBranches(cwd)
    expect(result.ok && result.value.branches).toEqual(['main', 'z-newest', 'feature/login'])
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('does not overwrite an ignored local file tracked by the target branch', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cat-code-branch-'))
  try {
    git(cwd, 'init', '-b', 'main')
    writeFileSync(join(cwd, '.gitignore'), 'draft.tmp\n')
    git(cwd, 'add', '.gitignore')
    git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'ignore draft')
    git(cwd, 'switch', '-c', 'feature/login')
    writeFileSync(join(cwd, 'draft.tmp'), 'branch content')
    git(cwd, 'add', '-f', 'draft.tmp')
    git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'track draft')
    git(cwd, 'switch', 'main')
    writeFileSync(join(cwd, 'draft.tmp'), 'local work')
    const before = await listWorkspaceBranches(cwd)
    expect(before.ok && before.value.dirty).toBe(false)
    const result = await switchWorkspaceBranch(cwd, 'feature/login', [])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('local file would be overwritten')
    expect(readFileSync(join(cwd, 'draft.tmp'), 'utf8')).toBe('local work')
    const after = await listWorkspaceBranches(cwd)
    expect(after.ok && after.value.current).toBe('main')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('confirms a checkout from the Git root when the target removes the session subdirectory', async () => {
  const cwd = fixture()
  try {
    mkdirSync(join(cwd, 'nested'))
    writeFileSync(join(cwd, 'nested', 'tracked.txt'), 'main only')
    git(cwd, 'add', 'nested/tracked.txt')
    git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'add nested folder')
    const result = await switchWorkspaceBranch(join(cwd, 'nested'), 'feature/login', [])
    expect(result.ok).toBe(true)
    expect(existsSync(join(cwd, 'nested'))).toBe(false)
    const after = await listWorkspaceBranches(cwd)
    expect(after.ok && after.value.current).toBe('feature/login')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('reports that checkout moved when a post-checkout hook makes Git inspection fail', async () => {
  const cwd = fixture()
  try {
    const hook = join(cwd, '.git', 'hooks', 'post-checkout')
    writeFileSync(hook, '#!/bin/sh\nmv .git .git-hidden\n')
    chmodSync(hook, 0o755)
    const result = await switchWorkspaceBranch(cwd, 'feature/login', [])
    expect(result.ok).toBe(false)
    if (!result.ok) expect('branchChanged' in result && result.branchChanged).toBe(true)
    const head = execFileSync('git', ['--git-dir', join(cwd, '.git-hidden'), 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' })
    expect(head.trim()).toBe('feature/login')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
