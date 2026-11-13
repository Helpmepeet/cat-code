import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { claimClaudeRefresh, commitClaudeLogin, completeClaudeRefresh, markClaudeRefreshDispatched,
  rejectClaudeCredential, setClaudeAuthorityVaultPathForTest } from '../../src/services/api/claudeAccountAuthority.js'
import type { SessionAccountSelection } from '../shared/sessionAccountSelection.js'

const roots: string[] = []
afterEach(() => {
  setClaudeAuthorityVaultPathForTest(undefined)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'claude-generation-restart-'))
  roots.push(root)
  setClaudeAuthorityVaultPathForTest(root)
  const credentials = { accessToken: 'first-access', refreshToken: 'first-refresh', expiresAt: Date.now() + 3600000 }
  const profile = { email_address: 'restart@example.test' }
  const installed = commitClaudeLogin('restart-account', 'first-login', credentials, profile)
  expect(installed.outcome).toBe('committed')
  return { root, credentials, profile, handle: installed.handle! }
}
async function restart(root: string, selection?: SessionAccountSelection) {
  const pool = new URL('../../src/services/api/claudeAccountPool.ts', import.meta.url).pathname
  const bootstrap = new URL('./sessionAccountBootstrap.ts', import.meta.url).pathname
  const routing = new URL('../../src/services/api/sessionAccountRouting.ts', import.meta.url).pathname
  const child = Bun.spawn([process.execPath, '-e', `
    globalThis.fetch = () => { throw new Error('network forbidden') };
    const pool = await import(${JSON.stringify(pool)});
    pool.setClaudeVaultPathForTest(${JSON.stringify(root)});
    const bootstrap = await import(${JSON.stringify(bootstrap)});
    const selection = bootstrap.readSessionAccountSelection(${JSON.stringify(JSON.stringify(selection ?? {}))});
    await bootstrap.restoreSessionAccountSelection(selection);
    const routing = await import(${JSON.stringify(routing)});
    const active = pool.getActiveClaudeAccount();
    console.log(JSON.stringify({ blocked: !!routing.getSessionAccountRouteBlock('anthropic'), generation: active?.lifecycleGeneration ?? null, selection }));
  `], { env: { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: join(root, 'config'), CLAUDE_CODE_SIMPLE: '1',
    ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, ANTHROPIC_AUTH_TOKEN: undefined }, stdout: 'pipe', stderr: 'pipe' })
  const stdout = await new Response(child.stdout).text()
  const stderr = await new Response(child.stderr).text()
  expect(await child.exited, stderr).toBe(0)
  return JSON.parse(stdout.trim()) as { blocked: boolean; generation: number | null; selection?: SessionAccountSelection }
}

test.each([false, true])('real replacement process holds an old chat after same-account relogin (previously dead=%s)', async dead => {
  const { root, credentials, profile, handle } = setup()
  const saved = { anthropic: handle.accountId, anthropicLoginGeneration: handle.generation }
  expect((await restart(root, saved)).blocked).toBe(false)
  if (dead) expect(rejectClaudeCredential(handle, 'old-rejected').outcome).toBe('committed')
  expect(commitClaudeLogin(handle.accountId, 'second-login', { ...credentials, accessToken: 'second-access' }, profile).outcome).toBe('committed')
  const replacement = await restart(root, saved)
  expect(replacement.blocked).toBe(true)
  expect(replacement.selection).toEqual(saved)
  expect((await restart(root, { anthropic: handle.accountId })).blocked).toBe(true)
  expect((await restart(root, { anthropic: handle.accountId, anthropicLoginGeneration: handle.generation + 1 })).blocked).toBe(false)
}, 30_000)

test('real replacement process permits a refreshed revision within the saved login generation', async () => {
  const { root, credentials, handle } = setup()
  const claim = claimClaudeRefresh(handle, 'refresh', 'owner').claim!
  expect(markClaudeRefreshDispatched(claim).outcome).toBe('committed')
  expect(completeClaudeRefresh(claim, { ...credentials, accessToken: 'refreshed-access' }).outcome).toBe('committed')
  const restored = await restart(root, { anthropic: handle.accountId, anthropicLoginGeneration: handle.generation })
  expect(restored.blocked).toBe(false)
  expect(restored.generation).toBe(handle.generation)
  expect((await restart(root)).blocked).toBe(false)
})

test('unversioned legacy selection restores only a verified generation-zero vault', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-legacy-restart-'))
  roots.push(root)
  mkdirSync(join(root, 'accounts'))
  writeFileSync(join(root, 'accounts', 'restart-account.json'), JSON.stringify({
    tokens: { access_token: 'legacy-access', refresh_token: 'legacy-refresh', expires_at: Date.now() + 3600000 },
    profile: { account_uuid: 'restart-account', email_address: 'legacy@example.test' },
  }))
  const restored = await restart(root, { anthropic: 'restart-account' })
  expect(restored.blocked).toBe(false)
  expect(restored.generation ?? 0).toBe(0)
})
