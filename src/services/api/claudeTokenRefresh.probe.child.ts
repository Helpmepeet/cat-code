import { mock, spyOn } from 'bun:test'
import { appendFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import * as atomic from '../../utils/atomicFile.js'
import * as authority from './claudeAccountAuthority.js'
import * as debug from '../../utils/debug.js'

const [root, accountId, mode = 'refresh'] = process.argv.slice(2)
if (!root || !accountId) throw new Error('Missing isolated probe arguments')
authority.setClaudeAuthorityVaultPathForTest(root)
const lockPath = join(root, 'refresh-locks', accountId)
let sends = 0
let saveBlocked = mode === 'pending-save' || mode === 'compromised-pending-save'
const diagnostics: string[] = []
if (mode === 'diagnostics') spyOn(debug, 'logForDebugging').mockImplementation(message => { diagnostics.push(message) })
const write = atomic.writeFileAtomicDurableSync
spyOn(atomic, 'writeFileAtomicDurableSync').mockImplementation((path, data, options) => {
  if (saveBlocked && String(data).includes('successor-')) throw new Error('isolated persistence failure')
  return write(path, data, options)
})
mock.module(new URL('../oauth/client.ts', import.meta.url).href, () => ({
  isOAuthTokenExpired: (expiresAt: number) => expiresAt <= Date.now() + 300_000,
  refreshOAuthToken: async (_token: string, options: { initiateRequest: (start: () => Promise<unknown>) => Promise<unknown> }) => {
    if (mode === 'lock-loss-before-dispatch') rmSync(`${lockPath}.lock`, { recursive: true })
    if (mode === 'login-before-dispatch' || mode === 'delete-before-dispatch') {
      const read = authority.readClaudeAccountAuthority(accountId)
      if (!('handle' in read)) throw new Error('Missing dispatch authority')
      if (mode === 'delete-before-dispatch') authority.deleteClaudeAccountAuthority(read.handle)
      else authority.commitClaudeLogin(accountId, randomUUID(), {
        accessToken: 'new-login', refreshToken: 'new-login-refresh', expiresAt: Date.now() + 3_600_000,
      }, { account_uuid: accountId })
    }
    return options.initiateRequest(async () => {
      sends++
      appendFileSync(join(root, 'sends'), `${accountId}\n`)
      writeFileSync(join(root, `started-${accountId}`), 'started')
      if (mode === 'hold' || mode === 'lost-response' || mode === 'cancelled') {
        const deadline = Date.now() + 10_000
        while (!existsSync(join(root, `release-${accountId}`))) {
          if (Date.now() > deadline) throw new Error('isolated gate timed out')
          await Bun.sleep(5)
        }
      }
      if (mode === 'lost-response') throw Object.assign(new Error('response lost'), { code: 'ECONNRESET' })
      if ((mode === 'offline' && sends === 1) || mode === 'offline-always') throw Object.assign(new Error('not connected'), { code: 'ECONNREFUSED' })
      if (mode === 'rejected') throw { response: { data: { error: 'invalid_grant' } } }
      if (mode === 'compromised-pending-save') rmSync(`${lockPath}.lock`, { recursive: true })
      return { accessToken: `successor-${accountId}`, refreshToken: `rotated-${accountId}`, expiresAt: Date.now() + 3_600_000, scopes: ['user:inference'] }
    })
  },
}))
const { prepareClaudeAccountCredentials } = await import('./claudeTokenRefresh.js')
if (mode === 'login' || mode === 'relogin') {
  const result = authority.commitClaudeLogin(accountId, mode === 'login' ? `login-${accountId}` : randomUUID(), {
    accessToken: `initial-${accountId}`, refreshToken: `refresh-${accountId}`, expiresAt: 0, scopes: ['user:inference'],
  }, { account_uuid: accountId })
  process.stdout.write(JSON.stringify(result))
} else if (mode === 'delete') {
  const read = authority.readClaudeAccountAuthority(accountId)
  if (!('handle' in read)) throw new Error('Missing delete authority')
  process.stdout.write(JSON.stringify(authority.deleteClaudeAccountAuthority(read.handle)))
} else {
  const read = authority.readClaudeAccountAuthority(accountId)
  if (!('handle' in read)) throw new Error(`Missing authority: ${read.status}`)
  if (mode === 'reject-access' || mode === 'reject-refresh' || mode === 'inspect') {
    process.stdout.write(JSON.stringify(mode !== 'inspect'
      ? authority.rejectClaudeCredential(read.handle, randomUUID(), mode === 'reject-access' ? 'access_rejected' : 'invalid_grant')
      : { status: read.status, sendable: authority.isClaudeCredentialReady(read.handle), handle: read.handle }))
    process.exit(0)
  }
  if (mode === 'newer-revision') {
    const claim = authority.claimClaudeRefresh(read.handle, randomUUID(), randomUUID()).claim
    if (!claim) throw new Error('Missing refresh claim')
    authority.startClaudeRefreshDispatch(claim, () => undefined)
    authority.completeClaudeRefresh(claim, {
      ...read.record.credentials!, expiresAt: Date.now() + 3_600_000,
    })
    const rejected = authority.rejectClaudeCredential(read.handle)
    const result = await prepareClaudeAccountCredentials(read.handle, {
      refreshLockPath: lockPath, force: true, failedAccessToken: read.record.credentials!.accessToken,
    })
    process.stdout.write(JSON.stringify({ result, rejected, sends }))
    process.exit(0)
  }
  if (mode === 'cancelled') {
    const controller = new AbortController()
    const first = prepareClaudeAccountCredentials(read.handle, { refreshLockPath: lockPath, signal: controller.signal })
    while (!existsSync(join(root, `started-${accountId}`))) await Bun.sleep(5)
    controller.abort()
    const cancelled = await first
    writeFileSync(join(root, `release-${accountId}`), 'go')
    const result = await prepareClaudeAccountCredentials(read.handle, { refreshLockPath: lockPath })
    process.stdout.write(JSON.stringify({ cancelled, result, sends }))
    process.exit(0)
  }
  const result = await prepareClaudeAccountCredentials(read.handle, { refreshLockPath: lockPath, force: false, waitTimeoutMs: 15_000 })
  if (mode === 'pending-save' || mode === 'compromised-pending-save') {
    saveBlocked = false
    const retried = await prepareClaudeAccountCredentials(read.handle, { refreshLockPath: lockPath, waitTimeoutMs: 15_000 })
    process.stdout.write(JSON.stringify({ result, retried, sends }))
  } else process.stdout.write(JSON.stringify({ result, sends, ...(mode === 'diagnostics' ? { diagnostics } : {}) }))
}
