import type { SecureStorage, SecureStorageData } from './types.js'
import type { FreshReadResult } from './crossProcessStorage.js'

/**
 * Creates a fallback storage that tries to use the primary storage first,
 * and if that fails, falls back to the secondary storage
 */
export function createFallbackStorage(
  primary: SecureStorage,
  secondary: SecureStorage,
): SecureStorage {
  const primaryFresh = primary as SecureStorage & {
    readFresh?: () => FreshReadResult
  }
  const secondaryFresh = secondary as SecureStorage & {
    readFresh?: () => FreshReadResult
  }
  return {
    name: `${primary.name}-with-${secondary.name}-fallback`,
    read(): SecureStorageData {
      const result = primary.read()
      if (result !== null && result !== undefined) {
        return result
      }
      return secondary.read() || {}
    },
    async readAsync(): Promise<SecureStorageData | null> {
      const result = await primary.readAsync()
      if (result !== null && result !== undefined) {
        return result
      }
      return (await secondary.readAsync()) || {}
    },
    readFresh(): FreshReadResult {
      const primaryResult = primaryFresh.readFresh?.() ?? {
        status: 'unavailable' as const,
        data: null,
      }
      if (primaryResult.status === 'present') return primaryResult

      const secondaryResult = secondaryFresh.readFresh?.() ?? {
        status: 'unavailable' as const,
        data: null,
      }
      if (secondaryResult.status === 'present') return secondaryResult
      if (
        primaryResult.status === 'missing' &&
        secondaryResult.status === 'missing'
      ) {
        return { status: 'missing', data: null }
      }
      return { status: 'unavailable', data: null }
    },
    update(data: SecureStorageData): { success: boolean; warning?: string } {
      // Capture state before update
      const primaryDataBefore = primary.read()

      const result = primary.update(data)

      if (result.success) {
        // Delete secondary when migrating to primary for the first time
        // This preserves credentials when sharing .claude between host and containers
        // See: https://github.com/anthropics/claude-code/issues/1414
        if (primaryDataBefore === null) {
          secondary.delete()
        }
        return result
      }

      const fallbackResult = secondary.update(data)

      if (fallbackResult.success) {
        // Primary write failed but primary may still hold an *older* valid
        // entry. read() prefers primary whenever it returns non-null, so that
        // stale entry would shadow the fresh data we just wrote to secondary —
        // e.g. a refresh token the server has already rotated away, causing a
        // /login loop (#30337). Best-effort delete; if this also fails the
        // user's keychain is in a bad state we can't fix from here.
        if (primaryDataBefore !== null) {
          primary.delete()
        }
        return {
          success: true,
          warning: fallbackResult.warning,
        }
      }

      return { success: false }
    },
    delete(): boolean {
      const primarySuccess = primary.delete()
      const secondarySuccess = secondary.delete()

      return primarySuccess || secondarySuccess
    },
  }
}
