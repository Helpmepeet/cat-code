import { join } from 'path'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { getErrnoCode } from '../errors.js'
import { writeFileSyncAndFlush_DEPRECATED } from '../file.js'
import { getFsImplementation } from '../fsOperations.js'
import {
  jsonParse,
  jsonStringify,
} from '../slowOperations.js'
import type { SecureStorage, SecureStorageData } from './types.js'
import type { FreshReadResult } from './crossProcessStorage.js'

function getStoragePath(): { storageDir: string; storagePath: string } {
  const storageDir = getClaudeConfigHomeDir()
  const storageFileName = '.credentials.json'
  return { storageDir, storagePath: join(storageDir, storageFileName) }
}

export const plainTextStorage = {
  name: 'plaintext',
  read(): SecureStorageData | null {
    // sync IO: called from sync context (SecureStorage interface)
    const { storagePath } = getStoragePath()
    try {
      const data = getFsImplementation().readFileSync(storagePath, {
        encoding: 'utf8',
      })
      return jsonParse(data)
    } catch {
      return null
    }
  },
  async readAsync(): Promise<SecureStorageData | null> {
    const { storagePath } = getStoragePath()
    try {
      const data = await getFsImplementation().readFile(storagePath, {
        encoding: 'utf8',
      })
      return jsonParse(data)
    } catch {
      return null
    }
  },
  readFresh(): FreshReadResult {
    const { storagePath } = getStoragePath()
    try {
      const data = getFsImplementation().readFileSync(storagePath, {
        encoding: 'utf8',
      })
      return { status: 'present', data: jsonParse(data) }
    } catch (error) {
      if (getErrnoCode(error) === 'ENOENT') {
        return { status: 'missing', data: null }
      }
      return { status: 'unavailable', data: null }
    }
  },
  update(data: SecureStorageData): { success: boolean; warning?: string } {
    // sync IO: called from sync context (SecureStorage interface)
    try {
      const { storageDir, storagePath } = getStoragePath()
      try {
        getFsImplementation().mkdirSync(storageDir, {
          recursive: true,
          mode: 0o700,
        })
      } catch (e: unknown) {
        const code = getErrnoCode(e)
        if (code !== 'EEXIST') {
          throw e
        }
      }

      writeFileSyncAndFlush_DEPRECATED(storagePath, jsonStringify(data), {
        encoding: 'utf8',
        mode: 0o600,
      })
      return {
        success: true,
        warning: 'Warning: Storing credentials in plaintext.',
      }
    } catch {
      return { success: false }
    }
  },
  delete(): boolean {
    // sync IO: called from sync context (SecureStorage interface)
    const { storagePath } = getStoragePath()
    try {
      getFsImplementation().unlinkSync(storagePath)
      return true
    } catch (e: unknown) {
      const code = getErrnoCode(e)
      if (code === 'ENOENT') {
        return true
      }
      return false
    }
  },
} satisfies SecureStorage
