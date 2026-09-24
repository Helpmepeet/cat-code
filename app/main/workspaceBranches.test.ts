import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
