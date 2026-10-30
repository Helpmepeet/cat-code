import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore } from './projectStore.js'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'projects-test-'))); roots.push(root)
  const cwd = join(root, 'folder'); mkdirSync(cwd)
  return { root, cwd, store: new ProjectStore(join(root, 'registry')) }
}
test('stores zero-session projects durably, trims names and refreshes other writers', async () => {
  const { root, cwd, store } = setup()
  const other = new ProjectStore(join(root, 'registry'))
  const project = await store.create({ cwd, name: '  First  ' })
  expect(other.list()).toEqual([{ ...project, name: 'First' }])
  expect(other.get(project.id)).toEqual(project)
  await expect(other.create({ cwd, name: 'Duplicate' })).rejects.toThrow('First')
})
test('concurrent store instances merge and cwd duplicates are rejected', async () => {
  const { root, cwd, store } = setup(); const cwd2 = join(root, 'second'); mkdirSync(cwd2)
  const other = new ProjectStore(join(root, 'registry'))
  await Promise.all([store.create({ cwd, name: 'One' }), other.create({ cwd: cwd2, name: 'Two' })])
  expect(store.list()).toHaveLength(2)
  await expect(store.create({ cwd: root, name: 'Legacy' }, () => [{ cwd: root, name: 'Existing session project' }])).rejects.toThrow('Existing session project')
})
test('malformed and unknown documents remain untouched', async () => {
  const { root, cwd, store } = setup(); mkdirSync(join(root, 'registry'))
  for (const text of ['{', '{"version":2,"projects":[]}', '{"version":1,"projects":[{}]}']) {
    writeFileSync(store.path, text)
    expect(() => store.list()).toThrow()
    await expect(store.create({ cwd, name: 'New' })).rejects.toThrow()
    expect(readFileSync(store.path, 'utf8')).toBe(text)
  }
})
test('lock and IO failures surface without a project', async () => {
  const { root, cwd } = setup()
  const store = new ProjectStore(join(root, 'registry'), { acquireLock: async () => { throw new Error('held lock') } })
  await expect(store.create({ cwd, name: 'New' })).rejects.toThrow('held lock')
  expect(store.list()).toEqual([])
})
test('legacy duplicate detection canonicalizes aliases and tolerates missing legacy folders', async () => {
  const { root, cwd, store } = setup()
  const alias = join(root, 'alias')
  symlinkSync(cwd, alias)
  await expect(store.create({ cwd, name: 'New' }, () => [{ cwd: alias, name: 'Existing alias project' }])).rejects.toThrow('Existing alias project')
  expect(store.list()).toEqual([])
  await store.create({ cwd, name: 'New' }, () => [{ cwd: join(root, 'missing'), name: 'Gone' }])
  expect(store.list()).toHaveLength(1)
})

test.skipIf(process.platform !== 'darwin')('accepts the NFC canonical path main returns for decomposed macOS folder names', async () => {
  const { root, store } = setup()
  const decomposed = join(root, 'cafe\u0301')
  mkdirSync(decomposed)
  const cwd = realpathSync(decomposed).normalize('NFC')
  expect((await store.create({ cwd, name: 'Café' })).cwd).toBe(cwd)
  await expect(store.create({ cwd, name: 'Duplicate' })).rejects.toThrow('Café')
})
