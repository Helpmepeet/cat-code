import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('a credential-free CI process without a selected account has no stored OAuth route', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-route-empty-'))
  try {
    const modulePath = new URL('./claudeStoredOAuthRoute.ts', import.meta.url).pathname
    const child = Bun.spawn([process.execPath, '-e', `
      const { hasSelectedStoredClaudeOAuthRoute } = await import(${JSON.stringify(modulePath)});
      if (hasSelectedStoredClaudeOAuthRoute()) throw new Error('unexpected stored route');
    `], {
      env: { ...process.env, CI: 'true', HOME: root, CLAUDE_CONFIG_DIR: root,
        ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined,
        CLAUDE_CODE_OAUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: undefined,
        CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: undefined },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(code, stderr).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 15_000)
