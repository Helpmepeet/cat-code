import { createRequire } from 'node:module'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const baselineRevision = '008dc331ee27d8467cc584a648e235d5ba0454b1'
const esbuild = createRequire(join(root, 'app/package.json'))('esbuild')
const targetNames = ['deliveryTraceSink', 'transcriptProjector', 'todoPlan', 'subagentDockState']
const paths = Object.fromEntries(targetNames.map(name => [name,
  name === 'deliveryTraceSink' ? join(root, 'app/main', `${name}.ts`) : join(root, 'app/renderer/src', `${name}.ts`),
]))
const baseline = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name,
  execFileSync('git', ['show', `${baselineRevision}:${path.slice(root.length + 1)}`], { cwd: root, encoding: 'utf8' }),
]))
const output = process.argv[2]
if (!output) throw new Error('Usage: node 2026-10-15-desktop-performance-follow-up.probe.mjs NEW_OUTPUT_DIRECTORY')
mkdirSync(output, { recursive: false })
const buildDir = mkdtempSync(join(tmpdir(), 'catcode-perf-followup-build-'))

async function bundle(entry, variant, name) {
  const outfile = join(buildDir, `${name}-${variant}.mjs`)
  const plugin = {
    name: 'baseline-owned-modules',
    setup(build) {
      build.onResolve({ filter: /(?:deliveryTraceSink|transcriptProjector|todoPlan|subagentDockState)\.js$/ }, args => {
        if (variant !== 'baseline') return undefined
        const moduleName = args.path.match(/([^/]+)\.js$/)?.[1]
        if (!moduleName || !(moduleName in paths)) return undefined
        return { path: paths[moduleName], namespace: 'baseline-owned' }
      })
      build.onLoad({ filter: /.*/, namespace: 'baseline-owned' }, args => {
        const moduleName = args.path.match(/([^/]+)\.ts$/)?.[1]
        return { contents: baseline[moduleName], loader: 'ts', resolveDir: dirname(args.path) }
      })
    },
  }
  await esbuild.build({
    ...(typeof entry === 'string' ? { stdin: { contents: entry, resolveDir: root, sourcefile: 'renderer-probe.ts', loader: 'ts' } } : { entryPoints: [entry.path] }),
    bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile,
    plugins: [plugin], logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: "import { createRequire as __perfRequire } from 'node:module'; const require = __perfRequire(import.meta.url);" },
  })
  return outfile
}

function run(outfile, config) {
  const child = spawnSync('node', [outfile], {
    encoding: 'utf8', env: { ...process.env, PERF_PROBE_CONFIG: JSON.stringify(config) },
    maxBuffer: 64 * 1024 * 1024,
  })
  if (child.status !== 0) throw new Error(child.stderr)
  return JSON.parse(child.stdout.trim().split('\n').at(-1))
}

const rendererProbe = `
import { PROTOCOL_VERSION } from './app/shared/protocol.js'
import { createTranscriptState, projectServerFrame, selectNestedTranscriptRows, nestedRowsChange } from './app/renderer/src/transcriptProjector.js'
import { selectTodoPlan } from './app/renderer/src/todoPlan.js'
import { createSubagentDockState, reconcileSubagentDockState, selectSubagentDock } from './app/renderer/src/subagentDockState.js'
const SID = 'synthetic'
const frame = message => ({ kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: SID, event: { type: 'message', message } })
let state = projectServerFrame(createTranscriptState(), { kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId: SID, engineSessionId: 'engine-synthetic', payload: { type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false, abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [] } })
const play = message => { state = projectServerFrame(state, frame(message)) }
for (let i = 0; i < 288; i++) {
  const id = 'toolu_' + i
  const name = i < 4 ? 'Agent' : i % 2 ? 'Read' : 'Bash'
  play({ type: 'assistant', session_id: 'engine-synthetic', parent_tool_use_id: null, uuid: '00000000-0000-4000-8000-' + String(i * 2).padStart(12, '0'), message: { id: 'message_' + i, role: 'assistant', content: [{ type: 'tool_use', id, name, input: name === 'Agent' ? { prompt: 'inspect' } : {} }] } })
  if (i < 256) play({ type: 'user', session_id: 'engine-synthetic', parent_tool_use_id: null, uuid: '00000000-0000-4000-8000-' + String(i * 2 + 1).padStart(12, '0'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'finished', is_error: false }] } })
}
for (let i = 0; i < 4; i++) play({ type: 'assistant', session_id: 'engine-synthetic', parent_tool_use_id: 'toolu_' + i, uuid: '00000000-0000-4000-8000-' + String(1000+i).padStart(12, '0'), message: { id: 'child_' + i, role: 'assistant', content: [{ type: 'text', text: 'worker step' }] } })
play({ type: 'stream_event', session_id: 'engine-synthetic', uuid: 'stream-start', event: { type: 'message_start', message: { id: 'streaming', type: 'message', role: 'assistant', model: 'synthetic', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } } })
play({ type: 'stream_event', session_id: 'engine-synthetic', uuid: 'stream-block', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
let before = selectNestedTranscriptRows(state, SID)
let recreatedCompleted = 0
let changedStart = null
const start = performance.now()
for (let i = 0; i < 100; i++) {
  play({ type: 'stream_event', session_id: 'engine-synthetic', uuid: 'stream-delta-' + i, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'next ' } } })
  const next = selectNestedTranscriptRows(state, SID)
  for (let j = 0; j < 256; j++) if (before[j] !== next[j]) recreatedCompleted++
  if (i === 0) changedStart = nestedRowsChange(next)?.start ?? null
  before = next
}
const projectorMs = performance.now() - start
let visits = 0
const rows = before.map(row => new Proxy(row, { get(target, property, receiver) { if (property === 'kind') visits++; return Reflect.get(target, property, receiver) } }))
const todoStart = performance.now()
for (let i = 0; i < 200; i++) selectTodoPlan(rows)
const todoMs = performance.now() - todoStart
const todoVisits = visits
visits = 0
let dockState = createSubagentDockState()
const facts = { workers: [], tasks: null, transcriptRows: rows, leases: null, nowMs: 1000, reducedMotion: true }
const dockStart = performance.now()
for (let i = 0; i < 200; i++) {
  const input = { ...facts, nowMs: facts.nowMs + i }
  dockState = reconcileSubagentDockState(dockState, input)
  selectSubagentDock(dockState, input)
}
const dockMs = performance.now() - dockStart
process.stdout.write(JSON.stringify({ topLevelRows: rows.length, completed: 256, pending: 32, nestedAgents: 4, deltas: 100, recreatedCompleted, changedStart, projectorMs, todoVisits, todoMs, dockVisits: visits, dockMs }) + '\\n')
`

try {
  for (const variant of ['baseline', 'after']) {
    const renderer = await bundle(rendererProbe, variant, 'renderer')
    const rendererResult = run(renderer, {})
    writeFileSync(join(output, `renderer-${variant}.json`), JSON.stringify(rendererResult, null, 2) + '\n')
    const tracing = await bundle({ path: join(root, 'docs/reports/2026-10-06-performance-measurements/probes/tracing.ts') }, variant, 'tracing')
    const tracingResult = run(tracing, { reps: 2, warmups: 1, smoke: false })
    writeFileSync(join(output, `tracing-${variant}.json`), JSON.stringify(tracingResult, null, 2) + '\n')
    process.stdout.write(`${variant}: ${JSON.stringify(rendererResult)}\n`)
  }
} finally {
  rmSync(buildDir, { recursive: true, force: true })
}
