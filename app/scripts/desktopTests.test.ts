import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { desktopTestArgs, slowDesktopTests } from './desktopTests.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('every deferred file exists and belongs to exactly one group', () => {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
  const files = Object.values(slowDesktopTests).flat()
  expect(new Set(files).size).toBe(files.length)
  for (const path of files) {
    expect(path.startsWith('app/')).toBe(true)
    expect(path).not.toMatch(/[?*{}]/)
    expect(existsSync(join(repoRoot, path)), path).toBe(true)
  }
})

test('unknown suites and groups fail closed rather than silently running a different set', () => {
  expect(() => desktopTestArgs('slo')).toThrow('Unknown desktop suite')
  expect(() => desktopTestArgs('slow', ['workspce'])).toThrow('Unknown slow desktop group')
})

test('area selection and Bun reporter arguments reach the intended test invocation', () => {
  const reporter = ['--reporter=junit', '--reporter-outfile=/tmp/desktop.xml']
  expect(desktopTestArgs('slow', ['workspace', ...reporter])).toEqual([
    'test', ...slowDesktopTests.workspace.map(path => `./${path}`), ...reporter,
  ])
  expect(desktopTestArgs('all', reporter)).toEqual(['test', './app', ...reporter])
})

test('real Bun discovery partitions fast and slow, full retains both, and copied tmp tests never run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-test-routing-'))
  roots.push(root)
  const fixture = (path: string, body: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), `import { test, expect } from 'bun:test'; test(${JSON.stringify(path)}, () => { ${body} });`)
  }
  fixture('app/routine.test.ts', 'expect(true).toBe(true)')
  // A future process test is not implicitly deferred by its suffix.
  fixture('app/new.process.test.ts', 'expect(true).toBe(true)')
  fixture('tmp/copied/app/stale.test.ts', 'throw new Error("STALE_COPY_RAN")')
  const slowFiles = Object.values(slowDesktopTests).flat()
  for (const path of slowFiles) fixture(path, 'expect(true).toBe(true)')
  const run = async (suite: string, args: string[] = []) => {
    const child = Bun.spawn([process.execPath, ...desktopTestArgs(suite, args)], {
      cwd: root, stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    return { code, output: stdout + stderr }
  }
  const fast = await run('fast')
  expect(fast.code, fast.output).toBe(0)
  expect(fast.output).toContain('2 pass')
  const slow = await run('slow')
  expect(slow.code, slow.output).toBe(0)
  expect(slow.output).toContain(`${slowFiles.length} pass`)
  const all = await run('all')
  expect(all.code, all.output).toBe(0)
  expect(all.output).toContain(`${slowFiles.length + 2} pass`)
  for (const result of [fast, slow, all]) expect(result.output).not.toContain('STALE_COPY_RAN')
  const workspace = await run('slow', ['workspace'])
  expect(workspace.code, workspace.output).toBe(0)
  expect(workspace.output).toContain(`${slowDesktopTests.workspace.length} pass`)
  fixture('app/routine.test.ts', 'throw new Error("ROUTINE_FAILURE")')
  expect((await run('fast')).code).not.toBe(0)
  fixture(slowFiles[0]!, 'throw new Error("SLOW_FAILURE")')
  expect((await run('slow')).code).not.toBe(0)
})
