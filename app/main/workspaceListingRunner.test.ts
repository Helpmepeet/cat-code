import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runWorkspaceListingWorker } from './workspaceListingRunner.js'
import type { WorkerTiming } from '../shared/workerTiming.js'
import { parseWorkspaceListingRequest, parseWorkspaceListingResult, type WorkspaceMetadata } from '../shared/workspaceListingWorker.js'

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

test.skipIf(process.platform !== 'darwin')('macOS Electron Node runner invokes the real Bun worker for trusted metadata', async () => {
  const h = isolated()
  const electron = fileURLToPath(new URL('../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', import.meta.url))
  expect(existsSync(electron)).toBe(true)
  writeFileSync(join(h.config, '.config.json'), JSON.stringify({ projects: { [h.trusted]: { hasTrustDialogAccepted: true } } }))
  for (const root of [h.trusted, h.untrusted]) mkdirSync(join(root, '.cat-code'))
  writeFileSync(join(h.trusted, '.cat-code', 'project.json'), JSON.stringify({ aliases: ['  Cafe\u0301  ', 'Workspace'], description: 'Trusted workspace description' }))
  writeFileSync(join(h.untrusted, '.cat-code', 'project.json'), JSON.stringify({ aliases: ['untrusted-secret'], description: 'Must not be returned' }))
  const entry = join(h.dir, 'entry.ts')
  const bundle = join(h.dir, 'entry.cjs')
  const runner = fileURLToPath(new URL('./workspaceListingRunner.ts', import.meta.url))
  const worker = fileURLToPath(new URL('../sidecar/workspaceListingWorker.ts', import.meta.url))
  writeFileSync(entry, `
    import { runWorkspaceListingWorker } from ${JSON.stringify(runner)};
    async function main() {
      if (process.versions.bun || !process.versions.electron) throw new Error('Expected Electron Node runtime');
      let metadata;
      const roots = await runWorkspaceListingWorker({
        command: ${JSON.stringify(process.execPath)},
        args: [${JSON.stringify(worker)}],
        cwd: ${JSON.stringify(h.trusted)},
        env: {
          NODE_ENV: 'production', CLAUDE_CONFIG_DIR: ${JSON.stringify(h.config)},
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
          ANTHROPIC_API_KEY: '', OPENAI_API_KEY: ''
        },
        request: { type: 'workspace-list', version: 1, roots: ${JSON.stringify([h.untrusted, h.trusted])}, metadataOffset: 0 },
        onMetadata: value => { metadata = value; }
      });
      console.log(JSON.stringify({ roots, metadata, electron: process.versions.electron }));
    }
    main().catch(error => { console.error(error); process.exitCode = 1; });
  `)
  const build = await Bun.build({ entrypoints: [entry], target: 'node', format: 'cjs' })
  expect(build.success).toBe(true)
  if (!build.success) throw new Error(build.logs.map(String).join('\n'))
  await Bun.write(bundle, build.outputs[0]!)
  const child = Bun.spawn([electron, bundle], {
    cwd: h.dir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLAUDE_CONFIG_DIR: h.config },
    stdout: 'pipe', stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`Electron Node regression exited ${code}: ${stderr}`)
  expect(code).toBe(0)
  const result = JSON.parse(stdout)
  expect(result.electron).toBeString()
  expect(result.roots).toEqual([h.trusted])
  expect(result.metadata).toEqual([{ path: h.trusted, aliases: ['Café', 'Workspace'], description: 'Trusted workspace description' }])
}, 25_000)

test('real observation worker lists only saved-trusted roots without executing candidate hooks', async () => {
  const h = isolated()
  const marker = join(h.dir, 'hook-executed')
  writeFileSync(join(h.config, '.config.json'), JSON.stringify({ projects: { [h.trusted]: { hasTrustDialogAccepted: true } } }))
  mkdirSync(join(h.trusted, '.claude'))
  writeFileSync(join(h.trusted, 'CLAUDE.md'), 'Project instructions must never enter a workspace listing result.\n')
  writeFileSync(join(h.trusted, '.claude', 'settings.json'), JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: `touch '${marker}'` }] }],
  } }))
  const timings: WorkerTiming[] = []
  const roots = await runWorkspaceListingWorker({ command: process.execPath,
    onTiming: timing => { timings.push(timing) },
    args: [fileURLToPath(new URL('../sidecar/workspaceListingWorker.ts', import.meta.url))], cwd: h.trusted,
    env: { NODE_ENV: 'production', CLAUDE_CONFIG_DIR: h.config, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
      ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' },
    request: { type: 'workspace-list', version: 1, roots: [h.trusted, h.untrusted] },
  })
  expect(roots).toEqual([h.trusted])
  expect(existsSync(marker)).toBe(false)
  expect(timings.map(timing => timing.phase).sort()).toEqual([
    'build_metadata', 'build_provenance_git', 'configuration_prepare', 'trust_evaluation', 'worker_bootstrap_imports',
  ])
  expect(timings.every(timing => timing.outcome === 'completed' && timing.durationMs >= 0)).toBe(true)
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

test('real worker reads only requested saved-trusted metadata without loading project instructions', async () => {
  const h = isolated()
  const malformed = join(h.dir, 'malformed')
  const linked = join(h.dir, 'linked')
  const missing = join(h.dir, 'missing')
  for (const root of [h.trusted, h.untrusted, malformed, linked, missing]) mkdirSync(join(root, '.cat-code'), { recursive: true })
  writeFileSync(join(h.config, '.config.json'), JSON.stringify({ projects: Object.fromEntries([h.trusted, malformed, linked, missing].map(root => [root, { hasTrustDialogAccepted: true }])) }))
  writeFileSync(join(h.trusted, '.cat-code', 'project.json'), JSON.stringify({ aliases: ['  Cafe\u0301  '], description: 'A workspace', unrelated: true }))
  writeFileSync(join(h.untrusted, '.cat-code', 'project.json'), '{"aliases":["private"]}')
  writeFileSync(join(malformed, '.cat-code', 'project.json'), '{"aliases":[42]}')
  symlinkSync(join(h.untrusted, '.cat-code', 'project.json'), join(linked, '.cat-code', 'project.json'))
  const marker = join(h.dir, 'executed')
  writeFileSync(join(h.trusted, 'CLAUDE.md'), 'SECRET instructions')
  mkdirSync(join(h.trusted, '.claude'))
  writeFileSync(join(h.trusted, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch '${marker}'` }] }] } }))
  let metadata: WorkspaceMetadata[] | undefined
  const roots = await runWorkspaceListingWorker({
    command: process.execPath, args: [fileURLToPath(new URL('../sidecar/workspaceListingWorker.ts', import.meta.url))], cwd: h.trusted,
    env: { NODE_ENV: 'production', CLAUDE_CONFIG_DIR: h.config, DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' },
    request: { type: 'workspace-list', version: 1, roots: [h.untrusted, h.trusted, malformed, linked, missing], metadataOffset: 0 },
    onMetadata: value => { metadata = value },
  })
  expect(roots).toEqual([h.trusted, malformed, linked, missing])
  expect(metadata?.[0]).toEqual({ path: h.trusted, aliases: ['Café'], description: 'A workspace' })
  for (const row of metadata!.slice(1, 3)) {
    expect(row.aliases).toEqual([])
    expect(row.description).toBe('')
    expect(row.metadataWarning).toBeString()
  }
  expect(metadata?.[3]).toEqual({ path: missing, aliases: [], description: '' })
  expect(JSON.stringify(metadata)).not.toContain('SECRET')
  expect(metadata!.flatMap(row => row.aliases)).not.toContain('private')
  expect(existsSync(marker)).toBe(false)
}, 20_000)

test('metadata request and nested response schemas are closed and bounded', () => {
  const request = { type: 'workspace-list', version: 1, roots: ['/known'] }
  for (const metadataOffset of [-1, 128, 1.5, '0', null]) expect(parseWorkspaceListingRequest({ ...request, metadataOffset })).toBeNull()
  expect(parseWorkspaceListingRequest({ ...request, roots: ['/known', '/known'] })).toBeNull()
  const row = { path: '/known', aliases: ['work'], description: '' }
  const result = { type: 'workspace-list-result', version: 1, trustedRoots: ['/known'] }
  for (const metadata of [
    [row, row], [{ ...row, path: '/unknown' }], [{ ...row, extra: true }],
    [{ ...row, aliases: [''] }], [{ ...row, aliases: [42] }], [{ ...row, aliases: Array(13).fill('x') }],
    [{ ...row, description: 'x'.repeat(321) }], [{ ...row, metadataWarning: 42 }],
    Array(9).fill(row),
  ]) expect(parseWorkspaceListingResult({ ...result, metadata })).toBeNull()
})

test.each([
  { metadata: undefined, offset: 0 },
  { metadata: [{ path: '/known', aliases: [], description: '' }], offset: undefined },
  { metadata: [{ path: '/unknown', aliases: [], description: '' }], offset: 0 },
  { metadata: Array(2).fill({ path: '/known', aliases: [], description: '' }), offset: 0 },
  { metadata: [], offset: 0 },
])('runner rejects missing, unsolicited, unknown or duplicate metadata %#', async ({ metadata, offset }) => {
  const h = isolated()
  let called = false
  await expect(runWorkspaceListingWorker({
    command: process.execPath, args: ['-e', 'console.log(process.env.LISTING_FIXTURE_OUTPUT)'], cwd: h.dir,
    env: { LISTING_FIXTURE_OUTPUT: JSON.stringify({ type: 'workspace-list-result', version: 1, trustedRoots: ['/known'], ...(metadata === undefined ? {} : { metadata }) }) },
    request: { type: 'workspace-list', version: 1, roots: ['/known'], ...(offset === undefined ? {} : { metadataOffset: offset }) },
    onMetadata: () => { called = true },
  })).rejects.toThrow('Saved project trust could not be read')
  expect(called).toBe(false)
})

test('runner applies offset before trust filtering and delivers only after successful exit', async () => {
  const h = isolated()
  const trustedRoots = ['/skipped', ...Array.from({ length: 10 }, (_, i) => `/root${i}`)]
  const metadata = trustedRoots.slice(1, 9).map(path => ({ path, aliases: [], description: '' }))
  for (const code of [0, 1]) {
    let received: WorkspaceMetadata[] | undefined
    const pending = runWorkspaceListingWorker({
      command: process.execPath, args: ['-e', `console.log(process.env.LISTING_FIXTURE_OUTPUT); process.exit(${code})`], cwd: h.dir,
      env: { LISTING_FIXTURE_OUTPUT: JSON.stringify({ type: 'workspace-list-result', version: 1, trustedRoots, metadata }) },
      request: { type: 'workspace-list', version: 1, roots: ['/skipped', '/untrusted', ...trustedRoots.slice(1)], metadataOffset: 1 },
      onMetadata: value => { received = value },
    })
    expect(received).toBeUndefined()
    if (code === 0) { expect(await pending).toEqual(trustedRoots); expect(received).toEqual(metadata) }
    else { await expect(pending).rejects.toThrow(); expect(received).toBeUndefined() }
  }
})
