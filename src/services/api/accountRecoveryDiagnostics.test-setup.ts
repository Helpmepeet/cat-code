import { afterAll } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

export const accountRecoveryTestConfigDir = mkdtempSync(
  join(tmpdir(), 'codex-account-recovery-'),
)

process.env.CLAUDE_CONFIG_DIR = accountRecoveryTestConfigDir

const { _setGlobalConfigCacheForTesting } = await import('../../utils/config.js')
const { getGlobalClaudeFile } = await import('../../utils/env.js')
const { getClaudeConfigHomeDir } = await import('../../utils/envUtils.js')

function clearConfigCaches(): void {
  getClaudeConfigHomeDir.cache.clear()
  getGlobalClaudeFile.cache.clear()
  _setGlobalConfigCacheForTesting(null)
}

clearConfigCaches()

export function resetAccountRecoveryTestConfig(): void {
  rmSync(accountRecoveryTestConfigDir, { recursive: true, force: true })
  mkdirSync(accountRecoveryTestConfigDir, { recursive: true, mode: 0o700 })
  clearConfigCaches()
}

afterAll(() => {
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  clearConfigCaches()
  rmSync(accountRecoveryTestConfigDir, { recursive: true, force: true })
})
