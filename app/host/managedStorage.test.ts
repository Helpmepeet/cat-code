import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManagedStorage } from './managedStorage.js'

const tempRoots: string[] = []

afterEach(() => {
  for (const path of tempRoots.splice(0)) rmSync(path, { recursive: true, force: true })
})

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-managed-storage-'))
  tempRoots.push(root)
  const storage = new ManagedStorage({
    appDataBase: join(root, 'user-data'),
    ownershipDir: join(root, 'config-home', 'chat-workspaces'),
  })
  return { root, storage }
}

test('a storage id keeps one owned folder across host instances and supports shared branch identities', () => {
  const { root, storage } = setup()
  const created = storage.create()
  expect(created.ok).toBe(true)
  if (!created.ok) return
  expect(existsSync(join(created.cwd, 'tmp'))).toBe(true)

  const sourceAppId = randomUUID()
  const sourceEngineId = randomUUID()
  const branchAppId = randomUUID()
  const branchEngineId = randomUUID()
  expect(storage.recordSessionIdentity(created.binding, sourceAppId, sourceEngineId)).toBe(true)
  expect(storage.recordSessionIdentity(created.binding, branchAppId, branchEngineId)).toBe(true)

  const restartedHost = new ManagedStorage({
    appDataBase: join(root, 'user-data'),
    ownershipDir: join(root, 'config-home', 'chat-workspaces'),
  })
  expect(restartedHost.resolve(created.binding)).toEqual({
    ok: true,
    cwd: created.cwd,
    binding: created.binding,
  })
  expect(restartedHost.findByEngineSession(sourceEngineId)?.appSessionId).toBe(sourceAppId)
  expect(restartedHost.findByEngineSession(branchEngineId)?.appSessionId).toBe(branchAppId)
})

test('only an actually missing managed folder can be explicitly recreated', () => {
  const { root, storage } = setup()
  const created = storage.create()
  expect(created.ok).toBe(true)
  if (!created.ok) return
  rmSync(created.cwd, { recursive: true, force: true })

  expect(storage.resolve(created.binding)).toEqual({ ok: false, reason: 'missing' })
  const recreated = storage.recreate(created.binding)
  expect(recreated.ok).toBe(true)
  if (!recreated.ok) return
  expect(recreated.cwd).toBe(created.cwd)

  const outside = join(root, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'keep.txt'), 'untouched')
  rmSync(created.cwd, { recursive: true, force: true })
  symlinkSync(outside, created.cwd)
  expect(storage.resolve(created.binding)).toEqual({ ok: false, reason: 'invalid' })
  expect(storage.recreate(created.binding)).toEqual({ ok: false, reason: 'invalid' })
})
