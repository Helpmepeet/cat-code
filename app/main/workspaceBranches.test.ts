import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listWorkspaceBranches, switchWorkspaceBranch } from './workspaceBranches.js'

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

test('lists local branches and switches a clean checkout', async () => {
  const cwd = fixture()
  try {
    const before = await listWorkspaceBranches(cwd)
    expect(before).toEqual({ ok: true, value: { current: 'main', branches: ['feature/login', 'main'], dirty: false } })
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
