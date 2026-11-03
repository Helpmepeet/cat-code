import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fixture = new URL('./remoteBridgeCore.auth.probe.child.ts', import.meta.url).pathname
for (const mode of [
  'proactive', 'proactive-pending', 'proactive-uncertain', 'proactive-selection-after-prepare', 'sse', 'sse-pending', 'sse-uncertain',
  'prepare-selection-race', 'archive-false', 'archive-pending', 'archive-uncertain',
  'archive-selection', 'archive-login', 'archive-unchanged', 'archive-successor', 'archive-throws', 'archive-unbound', 'auth-read-throws',
]) {
  test(`remote bridge auth boundaries: ${mode}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'remote-bridge-auth-'))
    const child = Bun.spawn([process.execPath, fixture, mode], {
      env: { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: join(root, 'config') },
      stdout: 'pipe', stderr: 'pipe',
    })
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: '', stderr: '' })
    } finally {
      child.kill()
      rmSync(root, { recursive: true, force: true })
    }
  })
}
