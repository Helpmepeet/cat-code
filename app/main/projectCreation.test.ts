import { afterEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, renameSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectCreationController } from './projectCreation.js'
import { ProjectStore } from './projectStore.js'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'project-draft-test-'))); roots.push(root)
  const cwd = join(root, 'folder'); mkdirSync(cwd)
  const store = new ProjectStore(join(root, 'registry'))
  const deps = { store, pick: async (): Promise<string | null> => cwd, inspectTrustRoot: async (path: string) => path, trustFolder: mock(async (_cwd: string, _root: string) => {}), validateCwd: (path: string): { ok: true; realpath: string } | { ok: false } => { try { return { ok: true, realpath: realpathSync(path) } } catch { return { ok: false } } }, legacyKnown: () => [] as { cwd: string; name: string }[] }
  return { root, cwd, store, deps, controller: new ProjectCreationController(deps) }
}
test('selection has no TTL, creates no session and is consumed only on success', async () => {
  const { controller, store } = setup(); const draftId = controller.begin()
  expect((await controller.pick(draftId)).kind).toBe('selected')
  expect(store.list()).toEqual([])
  const now = Date.now; Date.now = () => now() + 86_400_000
  try { expect((await controller.create({ draftId, name: '  Project  ', trustFolder: false })).ok).toBe(true) } finally { Date.now = now }
  expect(store.list()[0]?.name).toBe('Project')
  expect((await controller.create({ draftId, name: 'Again', trustFolder: false })).ok).toBe(false)
})
test('picker cancel, close and stale async picker create nothing', async () => {
  const { controller, deps, store, cwd } = setup()
  deps.pick = async () => null
  const id = controller.begin(); expect(await controller.pick(id)).toEqual({ kind: 'cancelled' })
  expect((await controller.create({ draftId: id, name: 'No', trustFolder: false })).ok).toBe(false)
  let finish!: (value: string) => void
  deps.pick = () => new Promise(resolve => { finish = resolve })
  const pending = controller.pick(id); controller.cancel(id); const next = controller.begin(); finish(cwd)
  expect(await pending).toEqual({ kind: 'cancelled' })
  expect((await controller.create({ draftId: next, name: 'No', trustFolder: false })).ok).toBe(false)
  expect(store.list()).toEqual([])
})
test('closed inputs, validation failures and duplicates retain the draft for retry', async () => {
  const { controller, deps, cwd, store } = setup(); const draftId = controller.begin()
  deps.validateCwd = () => ({ ok: false })
  expect((await controller.pick(draftId)).kind).toBe('error')
  deps.validateCwd = path => ({ ok: true, realpath: path })
  await controller.pick(draftId)
  expect((await controller.create({ draftId, name: 'No', trustFolder: true, cwd })).ok).toBe(false)
  deps.legacyKnown = () => [{ cwd, name: 'Old project' }]
  expect(await controller.create({ draftId, name: 'New', trustFolder: true })).toEqual({ ok: false, error: 'This folder already belongs to project "Old project".' })
  expect(deps.trustFolder).not.toHaveBeenCalled()
  deps.legacyKnown = () => []
  expect((await controller.create({ draftId, name: 'New', trustFolder: false })).ok).toBe(true)
  expect(deps.trustFolder).not.toHaveBeenCalled()
  expect(store.list()).toHaveLength(1)
})
for (const mode of ['redirect', 'replace']) test(`rejects ${mode} after selection`, async () => {
  const { controller, cwd, root, store } = setup(); const draftId = controller.begin(); await controller.pick(draftId)
  renameSync(cwd, join(root, 'old'))
  if (mode === 'redirect') symlinkSync(join(root, 'old'), cwd); else mkdirSync(cwd)
  expect((await controller.create({ draftId, name: 'No', trustFolder: true })).ok).toBe(false)
  expect(store.list()).toEqual([])
})
test('cancel while awaiting the write lock prevents persistence', async () => {
  const { deps, root } = setup()
  let unlock!: () => void
  const store = new ProjectStore(join(root, 'blocked'), { acquireLock: () => new Promise(resolve => { unlock = () => resolve(async () => {}) }) })
  const controller = new ProjectCreationController({ ...deps, store })
  const draftId = controller.begin(); await controller.pick(draftId)
  const pending = controller.create({ draftId, name: 'No', trustFolder: true }); controller.cancel(draftId); unlock()
  expect((await pending).ok).toBe(false); expect(store.list()).toEqual([])
  expect(deps.trustFolder).not.toHaveBeenCalled()
})

test('trust applies to the validated draft folder and disclosed engine root before project persistence', async () => {
  const { controller, deps, cwd, root, store } = setup()
  deps.inspectTrustRoot = async () => root
  deps.trustFolder.mockImplementation(async (path, trustRoot) => {
    expect(path).toBe(cwd)
    expect(trustRoot).toBe(root)
    expect(store.list()).toEqual([])
  })
  const draftId = controller.begin()
  expect(await controller.pick(draftId)).toEqual({ kind: 'selected', folder: { cwd, name: 'folder', trustRoot: root } })
  expect((await controller.create({ draftId, name: 'Trusted', trustFolder: true })).ok).toBe(true)
  expect(deps.trustFolder).toHaveBeenCalledTimes(1)
  expect(store.list()).toHaveLength(1)
})

test('trust failure leaves no project and retains the draft for retry or an untrusted creation', async () => {
  const { controller, deps, store } = setup()
  deps.trustFolder.mockRejectedValueOnce(new Error('Disk write failed'))
  const draftId = controller.begin(); await controller.pick(draftId)
  expect(await controller.create({ draftId, name: 'Retry', trustFolder: true })).toEqual({
    ok: false, error: 'Could not save folder trust. The project was not created. Choose the folder again to retry, or untick Trust this folder.',
  })
  expect(store.list()).toEqual([])
  expect((await controller.create({ draftId, name: 'Retry', trustFolder: false })).ok).toBe(true)
  expect(deps.trustFolder).toHaveBeenCalledTimes(1)
})

test('a stale scope lookup cannot authorize a closed draft', async () => {
  const { controller, deps, cwd, store } = setup()
  let finish!: (root: string) => void
  deps.inspectTrustRoot = () => new Promise(resolve => { finish = resolve })
  const draftId = controller.begin()
  const pending = controller.pick(draftId)
  await Promise.resolve()
  controller.reset()
  finish(cwd)
  expect(await pending).toEqual({ kind: 'cancelled' })
  expect((await controller.create({ draftId, name: 'No', trustFolder: true })).ok).toBe(false)
  expect(deps.trustFolder).not.toHaveBeenCalled()
  expect(store.list()).toEqual([])
})
