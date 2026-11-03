import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claimClaudeRefresh, commitClaudeLogin, completeClaudeRefresh, markClaudeRefreshDispatched,
  readClaudeAccountAuthority, rejectClaudeCredential, setClaudeAuthorityVaultPathForTest,
  type ClaudeAuthorityRead,
} from '../../src/services/api/claudeAccountAuthority.js'
import { projectClaudeAccountHealth } from './accountsDomain.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import { prepareClaudeAccountForSelection, seedClaudeAccountPoolForTest,
  setClaudeVaultPathForTest, resetClaudeAccountPoolForTest } from '../../src/services/api/claudeAccountPool.js'
import { commitClaudeAccountSwitch } from '../../src/services/api/claudeAccountSwitch.js'

const directories: string[] = []
afterEach(() => {
  resetClaudeAccountPoolForTest()
  setClaudeAuthorityVaultPathForTest(undefined)
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'claude-health-'))
  directories.push(directory)
  setClaudeVaultPathForTest(directory)
  const credentials = { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: Date.now() + 3600000 }
  const installed = commitClaudeLogin('health-account', 'login-one', credentials, { email_address: 'health@example.test' })
  expect(installed.outcome).toBe('committed')
  return { directory, credentials, handle: installed.handle! }
}
async function freshHealth(directory: string) {
  const authority = new URL('../../src/services/api/claudeAccountAuthority.ts', import.meta.url).pathname
  const domain = new URL('./accountsDomain.ts', import.meta.url).pathname
  const child = Bun.spawn([process.execPath, '-e', `
    globalThis.fetch = () => { throw new Error('network forbidden') };
    const a = await import(${JSON.stringify(authority)});
    a.setClaudeAuthorityVaultPathForTest(${JSON.stringify(directory)});
    const { projectClaudeAccountHealth } = await import(${JSON.stringify(domain)});
    console.log(JSON.stringify(projectClaudeAccountHealth(a.readClaudeAccountAuthority('health-account'))));
  `], { env: { ...process.env, HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'config'), CLAUDE_CODE_SIMPLE: '1' }, stdout: 'pipe', stderr: 'pipe' })
  const output = await new Response(child.stdout).text()
  const errors = await new Response(child.stderr).text()
  expect(await child.exited, errors).toBe(0)
  return JSON.parse(output.trim())
}

test('fresh workers see exact-revision rejection and a newer revision supersedes it', async () => {
  const { directory, credentials, handle } = setup()
  const claim = claimClaudeRefresh(handle, 'renew', 'owner').claim!
  expect(markClaudeRefreshDispatched(claim).outcome).toBe('committed')
  expect(rejectClaudeCredential(handle, 'reject-old').outcome).toBe('committed')
  expect((await freshHealth(directory)).credentialHealth).toBe('sign_in_required')
  expect(completeClaudeRefresh(claim, { ...credentials, accessToken: 'synthetic-new-access' }).outcome).toBe('committed')
  expect(rejectClaudeCredential(handle, 'late-old-rejection').outcome).toBe('rejected')
  expect(await freshHealth(directory)).toEqual({ loginGeneration: 1, credentialRevision: 1, credentialHealth: 'ready' })
  const current = readClaudeAccountAuthority('health-account')
  if (!('handle' in current)) throw new Error('missing authority')
  expect(rejectClaudeCredential(current.handle, 'reject-current').outcome).toBe('committed')
  expect((await freshHealth(directory)).credentialHealth).toBe('sign_in_required')
})

test('pending login and uncertain refresh project only actionable redacted health', () => {
  const { handle } = setup()
  const current = readClaudeAccountAuthority(handle.accountId)
  if (!('record' in current)) throw new Error('missing authority')
  for (const [updates, health] of [
    [{ pendingLogin: { operationId: 'pending', generation: 2, credentials: current.record.credentials!, profile: {} } }, 'persistence_pending'],
    [{ credentialDisposition: 'uncertain' }, 'refresh_uncertain'],
    [{ refreshIntent: { operationId: 'refresh', ownerNonce: 'private-owner', phase: 'dispatched', generation: 1, revision: 0 } }, 'refresh_uncertain'],
  ] as const) {
    const projected = projectClaudeAccountHealth({ ...current, record: { ...current.record, ...updates } } as ClaudeAuthorityRead)
    expect(projected.credentialHealth).toBe(health)
    expect(scanForSecrets(projected).ok).toBe(true)
    expect(Object.keys(projected).sort()).toEqual(['credentialHealth', 'credentialRevision', 'loginGeneration'])
  }
})

test('a superseded login receipt is rejected by explicit generation selection', async () => {
  const { credentials, handle } = setup()
  seedClaudeAccountPoolForTest({ accounts: [{
    accountUuid: handle.accountId, emailAddress: 'health@example.test', ...credentials,
    lifecycleGeneration: handle.generation, credentialRevision: 0, status: 'healthy',
  }], activeAccountUuid: handle.accountId })
  expect(commitClaudeLogin(handle.accountId, 'newer-login', { ...credentials, accessToken: 'new-login-token' }, { email_address: 'health@example.test' }).outcome).toBe('committed')
  expect(prepareClaudeAccountForSelection(handle.accountId, handle.generation)).toBeNull()
  expect(await commitClaudeAccountSwitch(handle.accountId, { expectedLoginGeneration: handle.generation })).toBeNull()
})
