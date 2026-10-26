import { createFallbackStorage } from './fallbackStorage.js'
import { createCrossProcessSafeStorage, removeMatchingClaudeOAuthFromStores } from './crossProcessStorage.js'
import { macOsKeychainStorage } from './macOsKeychainStorage.js'
import { plainTextStorage } from './plainTextStorage.js'
import type { SecureStorage } from './types.js'

export function removeMatchingClaudeOAuthCredentials(
  tokens: { accessToken: string; refreshToken: string },
): boolean {
  return removeMatchingClaudeOAuthFromStores(
    process.platform === 'darwin'
      ? [macOsKeychainStorage, plainTextStorage]
      : [plainTextStorage],
    tokens,
  )
}

/**
 * Get the appropriate secure storage implementation for the current platform
 */
export function getSecureStorage(): SecureStorage {
  if (process.platform === 'darwin') {
    return createCrossProcessSafeStorage(
      createFallbackStorage(macOsKeychainStorage, plainTextStorage),
    )
  }

  // TODO: add libsecret support for Linux

  return createCrossProcessSafeStorage(plainTextStorage)
}
