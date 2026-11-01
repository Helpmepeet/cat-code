import { afterEach, expect, test } from 'bun:test'
import { fsyncSync, renameSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectCommitUncertainError, ProjectStore } from './projectStore.js'
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
test('durable commit survives failed lock release with a cleanup warning', async () => {
  const { root, cwd } = setup()
  const store = new ProjectStore(join(root, 'registry'), { acquireLock: async () => async () => { throw new Error('release failed') } })
  const project = await store.create({ cwd, name: 'Saved' })
  expect(store.list()).toEqual([project])
  expect(store.takeWarning(project.id)).toContain('lock could not be released')
  expect(store.takeWarning(project.id)).toBeUndefined()
  await expect(store.create({ cwd, name: 'Retry' })).rejects.toThrow('already belongs')
})
test('pre-rename fsync failure keeps primary cause despite release failure', async () => {
  const { root, cwd } = setup()
  const primary = new Error('file fsync failed')
  const store = new ProjectStore(join(root, 'registry'), {
    fsync: () => { throw primary },
    acquireLock: async () => async () => { throw new Error('release failed') },
  })
  try { await store.create({ cwd, name: 'Not saved' }); throw new Error('expected failure') } catch (error) { expect(error).toBe(primary) }
  expect(store.list()).toEqual([])
  expect(primary).toHaveProperty('cleanupError')
})
test.skipIf(process.platform === 'win32')('post-rename fsync failure reconciles stable identity without retrying write', async () => {
  const { root, cwd } = setup()
  let flushes = 0
  const store = new ProjectStore(join(root, 'registry'), {
    fsync: fd => { if (++flushes === 2) throw new Error('directory fsync failed'); fsyncSync(fd) },
  })
  const project = await store.create({ cwd, name: 'Visible' })
  expect(store.list()).toEqual([project])
  expect(store.takeWarning(project.id)).toContain('durability could not be confirmed')
  expect(flushes).toBe(2)
})
test('rename that commits before throwing is reconciled by generated project ID', async () => {
  const { root, cwd } = setup()
  const store = new ProjectStore(join(root, 'registry'), {
    rename: (source, target) => { renameSync(source, target); throw new Error('ambiguous rename') },
  })
  const project = await store.create({ cwd, name: 'Visible' })
  expect(store.list()).toEqual([project])
  expect(store.takeWarning(project.id)).toContain('durability could not be confirmed')
})
test('failed reconciliation preserves stable identity and primary cause without repeating rename', async () => {
  const { root, cwd } = setup()
  const primary = new Error('ambiguous rename')
  let renames = 0
  const store = new ProjectStore(join(root, 'registry'), {
    rename: (source, target) => {
      renames++
      renameSync(source, target)
      writeFileSync(target, '{')
      throw primary
    },
  })
  let failure: unknown
  try { await store.create({ cwd, name: 'Uncertain' }) } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(ProjectCommitUncertainError)
  const uncertain = failure as ProjectCommitUncertainError
  expect(uncertain.cause).toBe(primary)
  expect(uncertain.project.cwd).toBe(cwd)
  expect(uncertain.project.id).toBeString()
  expect(renames).toBe(1)
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
