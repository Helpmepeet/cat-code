import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { resolveOutsideRepository } from './taskInventory.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('raw inventory output must resolve outside the repository including relative and parent paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'inventory-path-'))
  roots.push(root)
  const repo = join(root, 'repo')
  mkdirSync(repo)
  expect(() => resolveOutsideRepository(join(repo, 'prompts.json'), repo)).toThrow()
  expect(() => resolveOutsideRepository('prompts.json', repo)).toThrow()
  expect(() => resolveOutsideRepository(join(repo, '..', 'outside.json'), repo)).not.toThrow()
})

test('raw inventory output rejects paths that reach the repository through a symlink ancestor', () => {
  const root = mkdtempSync(join(tmpdir(), 'inventory-symlink-'))
  roots.push(root)
  const repo = join(root, 'repo')
  const alias = join(root, 'repo-link')
  mkdirSync(repo)
  symlinkSync(repo, alias)
  expect(() => resolveOutsideRepository(join(alias, 'raw.json'), repo)).toThrow()
})

test('default inventory boundary stays anchored to the script repository when cwd is elsewhere', () => {
  const outsideCwd = mkdtempSync(join(tmpdir(), 'inventory-cwd-'))
  roots.push(outsideCwd)
  const priorCwd = process.cwd()
  process.chdir(outsideCwd)
  try {
    expect(() => resolveOutsideRepository(resolve(import.meta.dir, 'taskInventory.ts'))).toThrow()
  } finally {
    process.chdir(priorCwd)
  }
})

test('inventory CLI rejects an in-repo output when invoked from another directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'inventory-cli-root-'))
  roots.push(root)
  const repo = join(root, 'cat-code')
  const outsideCwd = join(root, 'study')
  mkdirSync(repo)
  mkdirSync(outsideCwd)
  const out = join(repo, 'raw-prompts.json')
  const result = spawnSync('bun', [join(import.meta.dir, 'taskInventory.ts'), '--out', out, '--repo', repo], {
    cwd: outsideCwd,
    encoding: 'utf8',
  })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('refusing to write raw prompts inside the repository')
  expect(existsSync(out)).toBe(false)
})

test('inventory output rejects dangling symlinks into the repository and accepts a regular outside target', () => {
  const root = mkdtempSync(join(tmpdir(), 'inventory-dangling-link-'))
  roots.push(root)
  const repo = join(root, 'repo')
  const external = join(root, 'outside')
  mkdirSync(repo)
  mkdirSync(external)
  const targetInRepo = join(repo, 'not-created.json')
  const dangling = join(external, 'raw-prompts.json')
  symlinkSync(targetInRepo, dangling)
  expect(() => resolveOutsideRepository(dangling, repo)).toThrow(/symlink output path/)
  expect(existsSync(targetInRepo)).toBe(false)
  expect(resolveOutsideRepository(join(external, 'safe-output.json'), repo)).toBe(join(external, 'safe-output.json'))
})
