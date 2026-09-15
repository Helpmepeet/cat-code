import { mkdirSync } from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { acquireMutationLockSync } from '../lockfile.js'
import { logForDebugging } from '../debug.js'
import { clearKeychainCache } from './macOsKeychainHelpers.js'
import type { SecureStorage, SecureStorageData } from './types.js'

const LOCK_WAIT_MS = 10_000

export type FreshReadResult = {
  status: 'present' | 'missing' | 'unavailable'
  data: SecureStorageData | null
}

type FreshReadableStorage = SecureStorage & {
  readFresh?: () => FreshReadResult
}

const readBases = new WeakMap<object, SecureStorageData>()

function clone<T>(value: T): T {
  return structuredClone(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function equal(first: unknown, second: unknown): boolean {
  return JSON.stringify(first) === JSON.stringify(second)
}

function mergeChanges(
  base: Record<string, unknown>,
  next: Record<string, unknown>,
  fresh: Record<string, unknown>,
): Record<string, unknown> {
  const merged = clone(fresh)
  for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
    if (!Object.hasOwn(next, key)) {
      delete merged[key]
      continue
    }
    const baseValue = base[key]
    const nextValue = next[key]
    if (equal(baseValue, nextValue)) continue
    const freshValue = merged[key]
    if (isRecord(nextValue)) {
      merged[key] = mergeChanges(
        isRecord(baseValue) ? baseValue : {},
        nextValue,
        isRecord(freshValue) ? freshValue : {},
      )
    } else {
      merged[key] = clone(nextValue)
    }
  }
  return merged
}

function attachReadBase(data: SecureStorageData | null): SecureStorageData | null {
  if (!data) return data
  // A storage cache may return the same object more than once. Keep the first
  // caller's snapshot for that object so a later read cannot change the merge
  // base after the caller has mutated it in place.
  if (!readBases.has(data)) readBases.set(data, clone(data))
  return data
}

function acquireStorageLock(): () => void {
  const configHome = getClaudeConfigHomeDir()
  mkdirSync(configHome, { recursive: true, mode: 0o700 })
  return acquireMutationLockSync(join(configHome, '.secure-storage-mutation'), {
    label: 'Secure storage',
    waitMs: LOCK_WAIT_MS,
  })
}

export function createCrossProcessSafeStorage(
  storage: SecureStorage,
): SecureStorage {
  const freshReadableStorage = storage as FreshReadableStorage
  return {
    name: storage.name,
    read() {
      return attachReadBase(storage.read())
    },
    async readAsync() {
      return attachReadBase(await storage.readAsync())
    },
    update(data) {
      const base = readBases.get(data) ?? {}
      const next = clone(data)
      const release = acquireStorageLock()
      try {
        clearKeychainCache()
        let freshRead: FreshReadResult
        try {
          const readFresh = freshReadableStorage.readFresh
          if (readFresh) {
            freshRead = readFresh()
          } else {
            const data = storage.read()
            freshRead = data === null
              ? { status: 'unavailable', data: null }
              : { status: 'present', data }
          }
        } catch (error) {
          logForDebugging(`Secure storage fresh read failed: ${error}`, {
            level: 'error',
          })
          return { success: false }
        }
        if (freshRead.status === 'unavailable') {
          logForDebugging(
            'Secure storage fresh read was unavailable; refusing to publish update',
            { level: 'error' },
          )
          return { success: false }
        }
        const fresh = freshRead.data ?? {}
        const merged = mergeChanges(
          base as Record<string, unknown>,
          next as Record<string, unknown>,
          fresh as Record<string, unknown>,
        ) as SecureStorageData
        return storage.update(merged)
      } finally {
        release()
      }
    },
    delete() {
      const release = acquireStorageLock()
      try {
        clearKeychainCache()
        return storage.delete()
      } finally {
        release()
      }
    },
  }
}
