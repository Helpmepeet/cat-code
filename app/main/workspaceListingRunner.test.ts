import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runWorkspaceListingWorker } from './workspaceListingRunner.js'

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function isolated() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-listing-')))
  directories.push(dir)
  const config = join(dir, 'config')
  const trusted = join(dir, 'trusted')
  const untrusted = join(dir, 'untrusted')
  for (const path of [config, trusted, untrusted]) mkdirSync(path)
  return { dir, config, trusted, untrusted }
}

test('real observation worker lists only saved-trusted roots without executing candidate hooks', async () => {
  const h = isolated()
  const marker = join(h.dir, 'hook-executed')
  writeFileSync(join(h.config, '.config.json'), JSON.stringify({ projects: { [h.trusted]: { hasTrustDialogAccepted: true } } }))
  mkdirSync(join(h.trusted, '.claude'))
  writeFileSync(join(h.trusted, 'CLAUDE.md'), 'Project instructions must never enter a workspace listing result.\n')
  writeFileSync(join(h.trusted, '.claude', 'settings.json'), JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: `touch '${marker}'` }] }],
  } }))
  const roots = await runWorkspaceListingWorker({ command: process.execPath,
    args: [fileURLToPath(new URL('../sidecar/workspaceListingWorker.ts', import.meta.url))], cwd: h.trusted,
    env: { NODE_ENV: 'production', CLAUDE_CONFIG_DIR: h.config, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
      ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' },
    request: { type: 'workspace-list', version: 1, roots: [h.trusted, h.untrusted] },
  })
  expect(roots).toEqual([h.trusted])
  expect(existsSync(marker)).toBe(false)
}, 20_000)

test.each([
  JSON.stringify({ type: 'workspace-list-result', version: 1, trustedRoots: ['/not-requested'] }),
  JSON.stringify({ type: 'workspace-list-result', version: 1, trustedRoots: ['/known'], extra: true }),
  `${JSON.stringify({ type: 'workspace-list-result', version: 1, trustedRoots: ['/known'] })}\n${JSON.stringify({ type: 'workspace-list-result', version: 1, trustedRoots: ['/known'] })}`,
])('listing rejects malformed, unsolicited, and duplicate worker records', async output => {
  const h = isolated()
  await expect(runWorkspaceListingWorker({ command: process.execPath,
    args: ['-e', 'process.stdout.write(process.env.LISTING_FIXTURE_OUTPUT + "\\n")'], cwd: h.dir,
    env: { CLAUDE_CONFIG_DIR: h.config, LISTING_FIXTURE_OUTPUT: output },
    request: { type: 'workspace-list', version: 1, roots: ['/known'] },
  })).rejects.toThrow('Saved project trust could not be read')
})
