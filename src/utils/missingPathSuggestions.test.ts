import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { renameSync, symlinkSync } from 'node:fs'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatMissingPathResult, suggestMissingPath } from './missingPathSuggestions'

let root: string
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'missing-path-'))) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
async function file(path: string, content = 'SECRET FILE CONTENT') {
  const absolute = join(root, path)
  await mkdir(join(absolute, '..'), { recursive: true })
  await writeFile(absolute, content)
  return absolute
}
const suggest = (path: string, canInspect = (_path: string) => true, signal?: AbortSignal) =>
  suggestMissingPath(path, { cwd: root, canInspect, signal })

describe('suggestMissingPath', () => {
  test('finds exact filenames across directories and retains ambiguity', async () => {
    await mkdir(join(root, 'app/main'), { recursive: true })
    const a = await file('app/shared/operationalLog.ts')
    const b = await file('lib/operationalLog.ts')
    expect((await suggest('app/main/operationalLog.ts')).sort()).toEqual([a, b].sort())
  })

  test('same-stem matches stay in the requested directory; only filenames are returned', async () => {
    const a = await file('src/example.tsx')
    await file('other/example.js')
    const results = await suggest('src/example.ts')
    expect(results).toEqual([a])
    expect(JSON.stringify(results)).not.toContain('SECRET FILE CONTENT')
    expect(results).not.toContain(join(root, 'src/example.ts'))
  })

  test('does not inspect denied directories or disclose denied candidates', async () => {
    await mkdir(join(root, 'requested'))
    const denied = await file('private/match.ts')
    const candidate = await file('public/match.ts')
    const seen: string[] = []
    expect(await suggest('requested/match.ts', path => {
      seen.push(path)
      return path !== join(root, 'private') && path !== candidate
    })).toEqual([])
    expect(seen).not.toContain(denied)
    expect(await suggest('requested/match.ts', path => path !== join(root, 'requested'))).toEqual([])
  })

  test('ignores symlink files, directories and symlink ancestors', async () => {
    await mkdir(join(root, 'workspace/requested'), { recursive: true })
    await file('outside/match.ts')
    await symlink(join(root, 'outside'), join(root, 'workspace/link'))
    await symlink(join(root, 'outside/match.ts'), join(root, 'workspace/match.ts'))
    const options = { cwd: join(root, 'workspace'), canInspect: () => true }
    expect(await suggestMissingPath('requested/match.ts', options)).toEqual([])
    expect(await suggestMissingPath('link/missing.ts', options)).toEqual([])
  })

  test('missing requested directories still allow workspace filename hints', async () => {
    const candidate = await file('elsewhere/match.ts')
    expect(await suggest('missing/nested/match.ts')).toEqual([candidate])
    expect(await suggest('missing/nested/absent.ts')).toEqual([])
  })

  test('a directory swapped to an outside symlink before listing is not traversed', async () => {
    await mkdir(join(root, 'workspace/requested'), { recursive: true })
    const target = join(root, 'workspace/nearby')
    await mkdir(target)
    await file('outside/match.ts')
    let checks = 0
    let swapped = false
    const results = await suggestMissingPath('requested/match.ts', {
      cwd: join(root, 'workspace'),
      canInspect(path) {
        if (path === target && ++checks === 3) {
          renameSync(target, `${target}-old`)
          symlinkSync(join(root, 'outside'), target)
          swapped = true
        }
        return true
      },
    })
    expect(swapped).toBe(true)
    expect(results).toEqual([])
  })

  test('nearby exact matches survive a subtree larger than the total entry budget', async () => {
    await mkdir(join(root, 'app/main'), { recursive: true })
    await mkdir(join(root, 'aaa-unrelated'))
    for (let batch = 0; batch < 13; batch++) {
      await Promise.all(Array.from({ length: 500 }, (_, i) =>
        writeFile(join(root, 'aaa-unrelated', `entry-${batch}-${i}.txt`), '')))
    }
    const a = await file('app/shared/match.ts')
    const b = await file('app/other/match.ts')
    expect((await suggest('app/main/match.ts')).sort()).toEqual([a, b].sort())
  })

  test('exact filename matches outrank five same-stem hints', async () => {
    const hints: string[] = []
    for (const extension of ['js', 'jsx', 'tsx', 'md', 'json']) {
      hints.push(await file(`app/main/match.${extension}`))
    }
    const exact = await file('app/shared/match.ts')
    const results = await suggest('app/main/match.ts')
    expect(results).toHaveLength(5)
    expect(results[0]).toBe(exact)
    expect(results.slice(1).every(path => hints.includes(path))).toBe(true)
  })

  test('outside-workspace requests inspect only their own directory', async () => {
    const candidate = await file('outside/match.js')
    await file('sibling/match.ts')
    await mkdir(join(root, 'workspace'))
    expect(await suggestMissingPath(join(root, 'outside/match.ts'), {
      cwd: join(root, 'workspace'), canInspect: () => true,
    })).toEqual([candidate])
  })

  test('skips hidden and dependency/build directories and bounds depth/results', async () => {
    await mkdir(join(root, 'requested'))
    for (const dir of ['.git', '.hidden', 'node_modules', 'dist', 'build', 'a/b/c/d/e/f']) {
      await file(`${dir}/match.ts`)
    }
    expect(await suggest('requested/match.ts')).toEqual([])
    for (let i = 0; i < 9; i++) await file(`visible${i}/match.ts`)
    expect(await suggest('requested/match.ts')).toHaveLength(5)
  })

  test('never probes UNC paths', async () => {
    const canInspect = () => { throw new Error('must not probe') }
    expect(await suggestMissingPath('\\\\server\\share\\file.ts', { cwd: root, canInspect })).toEqual([])
    expect(await suggestMissingPath('file.ts', { cwd: '//server/share', canInspect })).toEqual([])
  })

  test('preserves cancellation before and during traversal', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled')
    controller.abort(reason)
    await expect(suggest('missing.ts', undefined, controller.signal)).rejects.toBe(reason)
    const during = new AbortController()
    await file('found.ts')
    await expect(suggest('missing.ts', () => {
      during.abort(reason)
      return true
    }, during.signal)).rejects.toBe(reason)
  })
})

test('formatter identifies failure without implying substitution and escapes path text', () => {
  const message = formatMissingPathResult('missing\n.ts', ['/tmp/found\n.ts'], 'read')
  expect(message).toContain('Requested path "missing\\n.ts" was not found.')
  expect(message).toContain('No file was read.')
  expect(message).toContain('suggestions only, not substitutions')
  expect(message).toContain('"/tmp/found\\n.ts"')
  expect(formatMissingPathResult('missing', [], 'search')).toBe(
    'Requested path "missing" was not found. No search was performed.',
  )
})
