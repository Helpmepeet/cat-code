import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

test('a legacy dev root remains owned while another app profile creates its own root', () => {
  const { root, storage: devStorage } = setup()
  const dev = devStorage.create()
  expect(dev.ok).toBe(true)
  if (!dev.ok) return
  const appId = randomUUID()
  const engineId = randomUUID()
  expect(devStorage.recordSessionIdentity(dev.binding, appId, engineId)).toBe(true)

  const ownershipDir = join(root, 'config-home', 'chat-workspaces')
  const scopedRecord = readdirSync(ownershipDir).find(name => name.startsWith('managed-storage-root-'))
  expect(scopedRecord).toBeDefined()
  if (!scopedRecord) return
  renameSync(join(ownershipDir, scopedRecord), join(ownershipDir, 'managed-storage-root.json'))

  const installedStorage = new ManagedStorage({
    appDataBase: join(root, 'installed-user-data'),
    ownershipDir,
  })
  const installed = installedStorage.create()
  expect(installed.ok).toBe(true)
  if (!installed.ok) return
  expect(installed.cwd.startsWith(join(realpathSync(root), 'installed-user-data', 'Chat Files'))).toBe(true)
  expect(installed.binding.storageRootId).not.toBe(dev.binding.storageRootId)
  expect(installedStorage.resolve(dev.binding)).toEqual({ ok: false, reason: 'invalid' })
  expect(installedStorage.hasSessionIdentity(dev.binding, appId, engineId)).toBe(false)

  const restartedDev = new ManagedStorage({
    appDataBase: join(root, 'user-data'),
    ownershipDir,
  })
  expect(restartedDev.resolve(dev.binding)).toEqual({ ok: true, cwd: dev.cwd, binding: dev.binding })
  expect(restartedDev.findByEngineSession(engineId)?.appSessionId).toBe(appId)
  expect(restartedDev.hasSessionIdentity(dev.binding, appId, engineId)).toBe(true)
  expect(restartedDev.create().ok).toBe(true)
  expect(new ManagedStorage({
    appDataBase: join(root, 'installed-user-data'),
    ownershipDir,
  }).resolve(installed.binding).ok).toBe(true)
})

test('session identity cannot cross app-data profiles sharing ownership records', () => {
  const { root, storage } = setup()
  const created = storage.create()
  if (!created.ok) throw new Error('expected managed chat')
  const appId = randomUUID()
  const engineId = randomUUID()
  expect(storage.recordSessionIdentity(created.binding, appId, engineId)).toBe(true)
  const other = new ManagedStorage({
    appDataBase: join(root, 'other-user-data'),
    ownershipDir: join(root, 'config-home', 'chat-workspaces'),
  })
  expect(other.hasSessionIdentity(created.binding, appId, engineId)).toBe(false)
  expect(other.wasRecreated(created.binding)).toBe(false)
  expect(storage.hasSessionIdentity(created.binding, appId, engineId)).toBe(true)
})

test('an invalid profile root record is not replaced by the legacy record', () => {
  const { root, storage } = setup()
  const created = storage.create()
  expect(created.ok).toBe(true)
  const ownershipDir = join(root, 'config-home', 'chat-workspaces')
  const scopedRecord = readdirSync(ownershipDir).find(name => name.startsWith('managed-storage-root-'))
  expect(scopedRecord).toBeDefined()
  if (!scopedRecord) return
  renameSync(join(ownershipDir, scopedRecord), join(ownershipDir, 'managed-storage-root.json'))
  symlinkSync(join(ownershipDir, 'managed-storage-root.json'), join(ownershipDir, scopedRecord))
  expect(storage.create()).toEqual({ ok: false, reason: 'invalid' })
})

test('only an actually missing managed folder can be explicitly recreated', () => {
  const { root, storage } = setup()
  const created = storage.create()
  expect(created.ok).toBe(true)
  if (!created.ok) return
  rmSync(created.cwd, { recursive: true, force: true })

  expect(storage.resolve(created.binding)).toEqual({ ok: false, reason: 'missing' })
  expect(storage.wasRecreated(created.binding)).toBe(false)
  const recreated = storage.recreate(created.binding)
  expect(recreated.ok).toBe(true)
  if (!recreated.ok) return
  expect(recreated.cwd).toBe(created.cwd)
  expect(storage.wasRecreated(created.binding)).toBe(true)
  expect(new ManagedStorage({
    appDataBase: join(root, 'user-data'),
    ownershipDir: join(root, 'config-home', 'chat-workspaces'),
  }).wasRecreated(created.binding)).toBe(true)

  const outside = join(root, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'keep.txt'), 'untouched')
  rmSync(created.cwd, { recursive: true, force: true })
  symlinkSync(outside, created.cwd)
  expect(storage.resolve(created.binding)).toEqual({ ok: false, reason: 'invalid' })
  expect(storage.recreate(created.binding)).toEqual({ ok: false, reason: 'invalid' })
})

test('an ownership writer with an older snapshot cannot erase the separate recreation marker', () => {
  const { root, storage } = setup()
  const created = storage.create()
  if (!created.ok) throw new Error('expected managed chat')
  const appId = randomUUID()
  const engineId = randomUUID()
  expect(storage.recordSessionIdentity(created.binding, appId, engineId)).toBe(true)
  const ownerPath = join(root, 'config-home', 'chat-workspaces', 'managed-storage',
    created.binding.storageRootId, `${created.binding.storageId}.json`)
  const stalePath = `${ownerPath}.stale`
  writeFileSync(stalePath, readFileSync(ownerPath))
  rmSync(created.cwd, { recursive: true, force: true })
  expect(storage.recreate(created.binding).ok).toBe(true)
  expect(JSON.parse(readFileSync(ownerPath, 'utf8')).folderRecreated).toBeUndefined()
  // Simulate the final rename of a cross-process identity writer that read its
  // ownership snapshot before recreation. Its replacement cannot remove notice.
  renameSync(stalePath, ownerPath)
  expect(storage.hasSessionIdentity(created.binding, appId, engineId)).toBe(true)
  expect(storage.wasRecreated(created.binding)).toBe(true)
  expect(storage.findByEngineSession(engineId)?.appSessionId).toBe(appId)
})

test('cwd files and malformed ownership-side markers cannot forge a recreation notice', () => {
  const { root, storage } = setup()
  const created = storage.create()
  if (!created.ok) throw new Error('expected managed chat')
  const markerPath = join(root, 'config-home', 'chat-workspaces', 'managed-storage',
    created.binding.storageRootId, `${created.binding.storageId}.recreated.json`)
  writeFileSync(join(created.cwd, 'recreated.json'), '{"version":1}')
  expect(storage.wasRecreated(created.binding)).toBe(false)
  rmSync(created.cwd, { recursive: true, force: true })

  writeFileSync(markerPath, JSON.stringify({
    version: 1,
    storageRootId: created.binding.storageRootId,
    storageId: randomUUID(),
  }))
  expect(() => storage.wasRecreated(created.binding)).toThrow()
  expect(storage.recreate(created.binding)).toEqual({ ok: false, reason: 'invalid' })
  expect(existsSync(created.cwd)).toBe(false)

  rmSync(markerPath)
  symlinkSync(join(root, 'config-home', 'chat-workspaces', 'managed-storage',
    created.binding.storageRootId, `${created.binding.storageId}.json`), markerPath)
  expect(() => storage.wasRecreated(created.binding)).toThrow()
  expect(storage.recreate(created.binding)).toEqual({ ok: false, reason: 'invalid' })
  expect(existsSync(created.cwd)).toBe(false)
})
