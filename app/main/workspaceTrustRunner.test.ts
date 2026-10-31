import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runWorkspaceTrustWorker } from './workspaceTrustRunner.js'
import { runWorkspaceListingWorker } from './workspaceListingRunner.js'
import { ProjectStore } from './projectStore.js'
import { ProjectCreationController } from './projectCreation.js'
import type { WorkspaceTrustWorkerRequest } from '../shared/workspaceTrustWorker.js'

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function isolated() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'project-trust-')))
  directories.push(dir)
  const config = join(dir, 'config'), cwd = join(dir, 'project')
  for (const path of [config, cwd]) mkdirSync(path)
  const env = { NODE_ENV: 'production', CLAUDE_CONFIG_DIR: config, HOME: config, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' }
  const worker = (path: string, request: WorkspaceTrustWorkerRequest) => runWorkspaceTrustWorker({ command: process.execPath,
    args: [fileURLToPath(new URL('../sidecar/workspaceTrustWorker.ts', import.meta.url))], cwd: path, env, request })
  const list = (roots: string[]) => runWorkspaceListingWorker({ command: process.execPath,
    args: [fileURLToPath(new URL('../sidecar/workspaceListingWorker.ts', import.meta.url))], cwd: dir, env,
    request: { type: 'workspace-list', version: 1, roots } })
  return { dir, config, cwd, env, worker, list }
}

test('project creation persists engine trust before registration and immediately passes real workspace listing', async () => {
  const h = isolated()
  const marker = join(h.dir, 'hook-executed')
  mkdirSync(join(h.cwd, '.cat-code'))
  writeFileSync(join(h.cwd, '.cat-code', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch '${marker}'` }] }] } }))
  const store = new ProjectStore(join(h.config, 'desktop'))
  const controller = new ProjectCreationController({ store, pick: async () => h.cwd,
    validateCwd: cwd => ({ ok: true, realpath: realpathSync(cwd) }), legacyKnown: () => [],
    inspectTrustRoot: async cwd => (await h.worker(cwd, { type: 'workspace.inspect', version: 1 })).trustRoot,
    trustFolder: async (cwd, expectedTrustRoot) => { await h.worker(cwd, { type: 'workspace.trust', version: 1, expectedTrustRoot }) },
  })
  expect(await h.list([h.cwd])).toEqual([])
  const draftId = controller.begin()
  expect(await controller.pick(draftId)).toEqual({ kind: 'selected', folder: { cwd: h.cwd, name: 'project', trustRoot: h.cwd } })
  expect((await controller.create({ draftId, name: 'Ready to jump', trustFolder: true })).ok).toBe(true)
  expect(await h.list(store.list().map(project => project.cwd))).toEqual([h.cwd])
  const saved = JSON.parse(readFileSync(join(h.config, '.cat-code.json'), 'utf8'))
  expect(saved.projects[h.cwd].hasTrustDialogAccepted).toBe(true)
  expect(existsSync(marker)).toBe(false)
}, 30_000)

test('nested git folder discloses and trusts the actual repository root, including siblings', async () => {
  const h = isolated()
  const git = Bun.spawnSync(['git', 'init', h.cwd], { stdout: 'pipe', stderr: 'pipe' })
  expect(git.exitCode).toBe(0)
  const nested = join(h.cwd, 'nested'), sibling = join(h.cwd, 'sibling')
  mkdirSync(nested); mkdirSync(sibling)
  expect(await h.worker(nested, { type: 'workspace.inspect', version: 1 })).toEqual({ type: 'workspace-trust-result', version: 1, trustRoot: h.cwd, trusted: false })
  await h.worker(nested, { type: 'workspace.trust', version: 1, expectedTrustRoot: h.cwd })
  const saved = JSON.parse(readFileSync(join(h.config, '.cat-code.json'), 'utf8'))
  expect(saved.projects[h.cwd].hasTrustDialogAccepted).toBe(true)
  expect(saved.projects[nested]).toBeUndefined()
  expect(await h.list([nested, sibling])).toEqual([nested, sibling])
}, 30_000)

test('new repository scope after selection is rejected before writing trust', async () => {
  const h = isolated()
  const nested = join(h.cwd, 'nested'); mkdirSync(nested)
  const before = await h.worker(nested, { type: 'workspace.inspect', version: 1 })
  expect(before.trustRoot).toBe(nested)
  expect(Bun.spawnSync(['git', 'init', h.cwd], { stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(0)
  await expect(h.worker(nested, { type: 'workspace.trust', version: 1, expectedTrustRoot: before.trustRoot })).rejects.toThrow('Folder trust could not be resolved or saved')
  expect(await h.list([nested, h.cwd])).toEqual([])
}, 30_000)

test.each([
  { type: 'workspace-trust-result', version: 1, trustRoot: '/known', trusted: false },
  { type: 'workspace-trust-result', version: 1, trustRoot: '/other', trusted: true },
  { type: 'workspace-trust-result', version: 1, trustRoot: 'relative', trusted: true },
  { type: 'workspace-trust-result', version: 1, trustRoot: '/known', trusted: true, extra: true },
])('accept rejects untrusted, mismatched, relative and extended receipts', async output => {
  const h = isolated()
  await expect(runWorkspaceTrustWorker({ command: process.execPath, cwd: h.cwd,
    args: ['-e', 'process.stdout.write(process.env.TRUST_FIXTURE + "\\n")'], env: { ...h.env, TRUST_FIXTURE: JSON.stringify(output) },
    request: { type: 'workspace.trust', version: 1, expectedTrustRoot: '/known' },
  })).rejects.toThrow('Folder trust could not be resolved or saved')
})
