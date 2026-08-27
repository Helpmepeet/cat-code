import { existsSync, writeFileSync } from 'fs'
import { createCrossProcessSafeStorage } from './crossProcessStorage.js'
import { plainTextStorage } from './plainTextStorage.js'

const role = process.env.PROBE_ROLE
const readyFile = process.env.PROBE_READY_FILE
const startFile = process.env.PROBE_START_FILE
if (!role || !readyFile || !startFile) {
  throw new Error('Missing secure-storage probe input')
}

const storage = createCrossProcessSafeStorage(plainTextStorage)
const snapshot = storage.read() ?? {}
writeFileSync(readyFile, String(process.pid))
while (!existsSync(startFile)) await Bun.sleep(10)

const result =
  role === 'terminal'
    ? storage.update({
        ...snapshot,
        claudeAiOauth: {
          accessToken: 'synthetic-terminal-access',
          refreshToken: 'synthetic-terminal-refresh',
          expiresAt: 1,
          scopes: ['user:inference'],
          subscriptionType: null,
          rateLimitTier: null,
        },
      })
    : storage.update({
        ...snapshot,
        mcpOAuth: {
          ...snapshot.mcpOAuth,
          'synthetic-server': {
            accessToken: 'synthetic-desktop-access',
          },
        },
      })

if (!result.success) throw new Error(`${role} secure-storage update failed`)
process.stdout.write(
  `RESULT:${JSON.stringify({ role, pid: process.pid, success: true })}\n`,
)
