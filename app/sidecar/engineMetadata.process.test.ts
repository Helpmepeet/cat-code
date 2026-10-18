import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readSourceBuildId } from '../../src/utils/buildProvenance.js'
import { parseWorkerTimings } from '../shared/workerTiming.js'

const metadata = resolve('app/sidecar/engineMetadata.ts')
const worker = resolve('app/sidecar/workerRuntime.ts')

async function isolated(code: string, cwd: string, extraEnv: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, '-e', code], {
    cwd,
    env: { ...process.env, HOME: cwd, XDG_CONFIG_HOME: cwd, CLAUDE_CONFIG_DIR: cwd,
      NODE_ENV: 'test', CLAUDE_CODE_SIMPLE: '1', CAT_CODE_WORKER_TIMING: '1', ...extraEnv },
    stdout: 'pipe', stderr: 'pipe',
  })
  const [status, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  expect(status, stderr).toBe(0)
  return { stdout, stderr }
}

test('metadata uses the source package and checkout, not the worker cwd, and initializes only once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'engine-metadata-'))
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '999.0.0' }))
    const buildId = readSourceBuildId(process.cwd())
    const version = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version
    const result = await isolated(`
      const { plugin } = await import('bun')
      plugin({ name: 'metadata-only-engine-boundary', setup(build) {
        build.onLoad({ filter: /\\/src\\/.*\\.ts$/ }, async args => {
          if (!args.path.endsWith('/src/utils/buildProvenance.ts')) {
            throw new Error('metadata loaded unrelated engine code: ' + args.path)
          }
          return { contents: await Bun.file(args.path).text(), loader: 'ts' }
        })
      } })
      const { ensureEngineMacro } = await import(${JSON.stringify(metadata)})
      ensureEngineMacro()
      const first = MACRO
      ensureEngineMacro()
      if (first !== MACRO) throw new Error('metadata replaced')
      console.log(JSON.stringify(MACRO))
    `, root)
    const macro = JSON.parse(result.stdout)
    expect(macro.VERSION).toBe(buildId === 'unknown' ? 'unknown' : `${version}-desktop.sha${buildId}`)
    expect(Object.keys(macro).sort()).toEqual(['BUILD_TIME', 'FEEDBACK_CHANNEL', 'PACKAGE_URL', 'VERSION'])
    expect(Number.isFinite(Date.parse(macro.BUILD_TIME))).toBe(true)
    expect(macro.PACKAGE_URL).toBe('claude-code-source-snapshot')
    expect(macro.FEEDBACK_CHANNEL).toBe('github')
    expect(parseWorkerTimings(result.stderr).map(t => t.phase)).toEqual(['build_provenance_git', 'build_metadata'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an existing build metadata global bypasses source provenance work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'engine-metadata-defined-'))
  try {
    const result = await isolated(`
      globalThis.MACRO = { VERSION: 'compiled-version', BUILD_TIME: 'compiled-time' }
      const before = MACRO
      const { ensureEngineMacro } = await import(${JSON.stringify(metadata)})
      ensureEngineMacro()
      if (before !== MACRO) throw new Error('build metadata replaced')
      console.log(MACRO.VERSION)
    `, root)
    expect(result.stdout.trim()).toBe('compiled-version')
    expect(result.stderr).toBe('')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('worker bootstrap retains config and trust reads without the initializer import graph', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'engine-worker-bootstrap-')))
  const trusted = join(root, 'trusted'), untrusted = join(root, 'untrusted')
  mkdirSync(trusted); mkdirSync(untrusted)
  writeFileSync(join(root, '.config.json'), JSON.stringify({ projects: { [trusted]: { hasTrustDialogAccepted: true } } }))
  try {
    const result = await isolated(`
      const { plugin } = await import('bun')
      plugin({ name: 'forbid-live-initializer', setup(build) {
        build.onLoad({ filter: /(?:initializeRuntime|entrypoints\\/init)\\.ts$/ }, args => {
          throw new Error('worker loaded live initializer graph: ' + args.path)
        })
      } })
      const { bootstrapWorkerEngine } = await import(${JSON.stringify(worker)})
      await bootstrapWorkerEngine()
      const { getGlobalConfig, isPathTrusted } = await import(${JSON.stringify(resolve('src/utils/config.ts'))})
      getGlobalConfig()
      console.log(JSON.stringify([isPathTrusted(${JSON.stringify(trusted)}), isPathTrusted(${JSON.stringify(untrusted)}), typeof MACRO.VERSION]))
    `, root, { NODE_ENV: 'development' })
    expect(JSON.parse(result.stdout)).toEqual([true, false, 'string'])
    expect(parseWorkerTimings(result.stderr).map(t => t.phase)).toEqual([
      'worker_bootstrap_imports', 'build_provenance_git', 'build_metadata', 'configuration_prepare',
    ])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('compiled MACRO defines leave the extracted helper inert', async () => {
  const root = mkdtempSync(join(tmpdir(), 'engine-metadata-compiled-'))
  try {
    const build = await Bun.build({
      entrypoints: [metadata], target: 'bun',
      define: { MACRO: JSON.stringify({ VERSION: 'compiled-version', BUILD_TIME: 'compiled-time' }) },
    })
    expect(build.success, String(build.logs)).toBe(true)
    const bundle = join(root, 'metadata.mjs')
    writeFileSync(bundle, await build.outputs[0]!.text())
    const result = await isolated(`
      const { ensureEngineMacro } = await import(${JSON.stringify(pathToFileURL(bundle).href)})
      ensureEngineMacro()
      console.log(typeof globalThis.MACRO)
    `, root)
    expect(result.stdout.trim()).toBe('undefined')
    expect(result.stderr).toBe('')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
