import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Controller startup changes process-wide model/bootstrap state. Keep the real
// engine in its own process so this proof cannot alter neighboring app tests.
test.each([true, false])('real desktop first-turn model request includes a snapshot only with open peers (populated=%s)', async populated => {
  const root = mkdtempSync(join(tmpdir(), 'peer-start-controller-'))
  mkdirSync(join(root, 'workspace'))
  try {
    const child = Bun.spawn([
      process.execPath, new URL('./peerStartContext.integration.fixture.ts', import.meta.url).pathname,
      root, String(populated),
    ], {
      env: {
        ...process.env,
        HOME: root,
        CLAUDE_CONFIG_DIR: join(root, 'config'),
        CODEX_HOME: join(root, 'codex'),
        ANTHROPIC_API_KEY: 'isolated-scripted-test-key',
        CATCODE_SIDECAR_MODEL: 'gpt-6.1-sol',
        CLAUDE_CODE_SIMPLE: '0',
        CLAUDE_CODE_DISABLE_ATTACHMENTS: '0',
        TEST_ENABLE_SESSION_PERSISTENCE: '1',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: 'peer start controller passed\n', stderr: '' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
