import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import * as pool from '../../services/api/claudeAccountPool.js'
import * as storage from '../../utils/secureStorage/index.js'
import * as logout from './logout.js'
import { authLogout } from '../../cli/handlers/auth.js'

beforeEach(() => {
  pool.seedClaudeAccountPoolForTest({
    accounts: ['active', 'replacement'].map(accountUuid => ({
      accountUuid, emailAddress: `${accountUuid}@example.com`,
      accessToken: accountUuid, refreshToken: accountUuid,
      expiresAt: Date.now() + 60000, status: 'healthy' as const,
    })),
    activeAccountUuid: 'active',
  })
  spyOn(storage, 'getSecureStorage').mockImplementation(() => { throw new Error('unexpected storage access') })
  spyOn(storage, 'removeMatchingClaudeOAuthCredentials').mockImplementation(() => { throw new Error('unexpected credential deletion') })
})

afterEach(() => {
  mock.restore()
  pool.resetClaudeAccountPoolForTest()
})

test('slash logout reports removal failure without syncing replacement or reporting success', async () => {
  const remove = spyOn(pool, 'removeClaudeAccount').mockReturnValue(false)
  const sync = spyOn(pool, 'syncClaudeAccountToStorage').mockImplementation(() => {})
  const result = await logout.call() as { props: { children: string } }
  expect(result.props.children).toBe('Failed to remove Claude account. Check logs for details.')
  expect(remove).toHaveBeenCalledWith('active')
  expect(sync).not.toHaveBeenCalled()
  expect(pool.getActiveClaudeAccount()?.accountUuid).toBe('active')
})

test('CLI logout exits unsuccessfully without syncing or writing success', async () => {
  const remove = spyOn(pool, 'removeClaudeAccount').mockReturnValue(false)
  const sync = spyOn(pool, 'syncClaudeAccountToStorage').mockImplementation(() => {})
  const output: string[] = []
  const errors: string[] = []
  spyOn(process.stdout, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true })
  spyOn(process.stderr, 'write').mockImplementation(chunk => { errors.push(String(chunk)); return true })
  const exit = spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit:${code}`) })
  await expect(authLogout()).rejects.toThrow('exit:1')
  expect(remove).toHaveBeenCalledWith('active')
  expect(sync).not.toHaveBeenCalled()
  expect(output).toEqual([])
  expect(errors).toEqual(['Failed to log out.\n'])
  expect(exit).toHaveBeenCalledWith(1)
})
