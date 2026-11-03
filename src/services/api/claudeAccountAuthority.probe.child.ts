import { setClaudeAuthorityVaultPathForTest, readClaudeAccountAuthority, migrateClaudeAccountAuthority,
  commitClaudeLogin, retryClaudeAuthorityPersistence, rejectClaudeCredential,
  claimClaudeRefresh, startClaudeRefreshDispatch, completeClaudeRefresh, deleteClaudeAccountAuthority,
  acquireClaudeAccountMutationLock,
} from './claudeAccountAuthority.js'
import { writeFileSync } from 'fs'
import { join } from 'path'

const [root, action, operationId = 'login', token = 'new'] = process.argv.slice(2)
if (!root || !action) throw new Error('Expected isolated vault root and action')
setClaudeAuthorityVaultPathForTest(root)
const id = 'synthetic-account'
const read = () => readClaudeAccountAuthority(id)
let out: unknown
if (action === 'read') out = read()
else if (action === 'try-guard') {
  try { const release = acquireClaudeAccountMutationLock(id, 0); release(); out = { acquired: true } }
  catch (error) { out = { acquired: false, code: (error as NodeJS.ErrnoException).code } }
}
else if (action === 'login-other') {
  const { spyOn } = await import('bun:test')
  const pool = await import('./claudeAccountPool.js')
  const secure = await import('../../utils/secureStorage/index.js')
  const config = await import('../../utils/config.js')
  config.enableConfigs()
  let stored: any = {}
  spyOn(secure, 'getSecureStorage').mockReturnValue({
    name: 'isolated-probe', read: () => stored, readAsync: async () => stored,
    update: data => { stored = data; return { success: true } }, delete: () => true,
  })
  pool.setClaudeVaultPathForTest(root)
  pool.setClaudeConfigAccountForTest({ active: true, value: null })
  out = pool.appendClaudeAccount({
    accountUuid: 'other-account', emailAddress: 'other@example.com',
    accessToken: token, refreshToken: `refresh-${token}`, expiresAt: 100,
  }, { operationId })
}
else if (action.startsWith('init')) {
  const pool = await import('./claudeAccountPool.js')
  const config = await import('../../utils/config.js')
  config.enableConfigs()
  pool.setClaudeVaultPathForTest(root)
  pool.setClaudeConfigAccountForTest({ active: true, value: null })
  if (action === 'init-failure') {
    const { spyOn } = await import('bun:test')
    spyOn(config, 'saveGlobalConfig').mockReturnValue(false)
  }
  pool.initClaudeAccountPool()
  out = { active: pool.getActiveClaudeAccount(), authority: read(), inventory: pool.getClaudePoolStatus() }
}
else if (action === 'suspend-login') {
  const { spyOn } = await import('bun:test')
  const atomic = await import('../../utils/atomicFile.js')
  const original = atomic.writeFileAtomicDurableSync
  let paused = false
  spyOn(atomic, 'writeFileAtomicDurableSync').mockImplementation((path, data, options) => {
    if (!paused && String(path) === join(root, 'authority-v1', `${id}.json`)) {
      paused = true
      writeFileSync(join(root, 'paused.ready'), String(process.pid))
      process.kill(process.pid, 'SIGSTOP')
    }
    return original(path, data, options)
  })
  out = commitClaudeLogin(id, operationId, { accessToken: token, refreshToken: `refresh-${token}`, expiresAt: 100 }, { account_uuid: id, email_address: 'synthetic@example.com' })
}
else if (action === 'migrate') out = migrateClaudeAccountAuthority(id)
else if (action === 'login') out = commitClaudeLogin(id, operationId, { accessToken: token, refreshToken: `refresh-${token}`, expiresAt: 100 }, { account_uuid: id, email_address: 'synthetic@example.com' })
else if (action === 'retry') out = retryClaudeAuthorityPersistence(id, operationId)
else {
  const current = read()
  if (!('handle' in current)) throw new Error(`Missing handle: ${current.status}`)
  if (action === 'reject') out = rejectClaudeCredential(current.handle, operationId)
  else if (action === 'delete') out = deleteClaudeAccountAuthority(current.handle, operationId)
  else if (action === 'refresh') {
    const claimed = claimClaudeRefresh(current.handle, operationId, 'owner')
    if (!claimed.claim) throw new Error(`Claim failed: ${JSON.stringify(claimed)}`)
    const dispatched = startClaudeRefreshDispatch(claimed.claim, () => true)
    if (!dispatched.started) throw new Error('Dispatch failed')
    out = completeClaudeRefresh(claimed.claim, { accessToken: token, refreshToken: `refresh-${token}`, expiresAt: 100 })
  } else throw new Error(`Unknown action: ${action}`)
}
process.stdout.write(`RESULT:${JSON.stringify(out)}\n`)
