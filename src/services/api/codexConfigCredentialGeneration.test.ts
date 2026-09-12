import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  clearCodexOAuthTokens,
  getCodexOAuthTokens,
  saveCodexOAuthTokens,
} from '../../utils/auth.js'
import {
  _setGlobalConfigCacheForTesting,
  enableConfigs,
} from '../../utils/config.js'
import { getGlobalClaudeFile } from '../../utils/env.js'
import { loadConfigAccount } from './codexAccountPool.js'
import { createCodexCredentialLifecycle } from './codexCredentialLifecycle.js'

describe('Codex config credential generation', () => {
  test('round-trips credential generation through a real temporary config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-config-generation-'))
    const previousNodeEnv = process.env.NODE_ENV
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    getGlobalClaudeFile.cache.clear()

    try {
      process.env.NODE_ENV = 'production'
      process.env.CLAUDE_CONFIG_DIR = dir
      getGlobalClaudeFile.cache.clear()
      enableConfigs()
      saveCodexOAuthTokens({
        accessToken: 'config-access',
        refreshToken: 'config-refresh',
        expiresAt: Date.now() + 60_000,
        accountId: 'config-generation-account',
        credentialGeneration: 9,
      })

      const written = JSON.parse(readFileSync(getGlobalClaudeFile(), 'utf-8')) as {
        codexOAuth?: Record<string, unknown>
      }
      expect(written.codexOAuth?.credentialGeneration).toBe(9)
      _setGlobalConfigCacheForTesting(null)
      getGlobalClaudeFile.cache.clear()
      expect(getCodexOAuthTokens()?.credentialGeneration).toBe(9)

      const lifecycleDir = mkdtempSync(join(tmpdir(), 'codex-config-lifecycle-'))
      try {
        const lifecycle = createCodexCredentialLifecycle({ directory: lifecycleDir })
        expect(
          loadConfigAccount({
            lifecycle,
            tokens: getCodexOAuthTokens(),
          }),
        ).toBeNull()
      } finally {
        rmSync(lifecycleDir, { recursive: true, force: true })
      }
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previousNodeEnv
      }
      if (previousConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      }
      getGlobalClaudeFile.cache.clear()
      _setGlobalConfigCacheForTesting(null)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('clears the Codex config block durably outside test mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-config-clear-'))
    const previousNodeEnv = process.env.NODE_ENV
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    getGlobalClaudeFile.cache.clear()

    try {
      process.env.NODE_ENV = 'production'
      process.env.CLAUDE_CONFIG_DIR = dir
      getGlobalClaudeFile.cache.clear()
      enableConfigs()
      saveCodexOAuthTokens({
        accessToken: 'config-access',
        refreshToken: 'config-refresh',
        expiresAt: Date.now() + 60_000,
        accountId: 'config-clear-account',
        credentialGeneration: 4,
      })
      expect(getCodexOAuthTokens()?.accountId).toBe('config-clear-account')

      clearCodexOAuthTokens()

      const written = JSON.parse(readFileSync(getGlobalClaudeFile(), 'utf-8')) as {
        codexOAuth?: unknown
      }
      expect(written.codexOAuth).toBeUndefined()
      _setGlobalConfigCacheForTesting(null)
      getGlobalClaudeFile.cache.clear()
      expect(getCodexOAuthTokens()).toBeNull()
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previousNodeEnv
      }
      if (previousConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      }
      getGlobalClaudeFile.cache.clear()
      _setGlobalConfigCacheForTesting(null)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
