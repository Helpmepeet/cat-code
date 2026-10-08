#!/usr/bin/env bun
// Offline startup probe through the production desktop path:
// SidecarSupervisor (Electron-free main-side spawner) -> Unix socket -> real
// sidecar (app/sidecar/index.ts) with the production runtime flags, loading the
// frozen engine. A preload replaces the Codex transport with a scripted local
// fake and fails every other network call closed; sandbox-exec denies outbound IP.
//
// Usage: bun harness.ts --engine <dir> --copy <dir holding cat-code/> --out <dir> --prompt-file <file>
//        [--images <dir>] [--bin <dir>] [--model gpt-6.1-sol] [--effort high] [--mode auto]
// --images: prompt images, sent as the desktop composer sends them (images, then text).
// --bin: offline CLI stand-ins, staged and put first on PATH.
// --live --credential <file> [--max-minutes N] [--max-input-tokens N]: a real
//        run. No interceptor; the sandbox keeps its file and gh denies but allows
//        network. The credential file ({codexOAuth: ...}) is copied into the
//        fresh config and the refreshed tokens are written back after the run, so
//        runs must be sequential. Caps abort the turn. UNVERIFIED: never run.
// --abs: a JSON list [{from, to}] of inputs the prompt names by absolute path;
//        each is placed at `to` for the run (an existing file must be identical)
//        and removed afterwards if this run created it.
// The copy is cloned to /Users/Shared/ccw/<random>/cat-code for the run, so the
// working directory the model sees carries no study or setup name. The source
// copy remains untouched; failed attempts remain staged for inspection.
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { sandboxProfile, probeScratch } from './sandbox.ts'
import { randomBytes, randomUUID } from 'node:crypto'
import { createAttemptWorkspace } from '../attemptWorkspace.ts'
import { copyPrivateSeed } from '../privateModes.ts'
import { runtimeAllowances } from './runtimeAllowances.ts'

const args = process.argv.slice(2)
const opt = (k: string, d?: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1]! : d! }
const engine = resolve(opt('--engine'))
const copy = resolve(opt('--copy'))
const stage = join('/Users/Shared/ccw', randomBytes(3).toString('hex'))
const attempt = createAttemptWorkspace(resolve(opt('--out')), stage, copy)
const { out, cwd } = attempt
const promptText = readFileSync(opt('--prompt-file'), 'utf8').replaceAll('{{REPO}}', cwd).replaceAll('{{HOME}}', join(stage, 'home'))
const imagesDir = args.includes('--images') ? resolve(opt('--images')) : ''
const MEDIA: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
const images = imagesDir ? readdirSync(imagesDir).sort((a, b) => parseInt(a) - parseInt(b)).map(f => ({ type: 'image', source: { type: 'base64', media_type: MEDIA[f.split('.').pop()!]!, data: readFileSync(join(imagesDir, f)).toString('base64') } })) : []
const prompt = images.length ? [...images, ...(promptText ? [{ type: 'text', text: promptText }] : [])] : promptText
if (args.includes('--bin')) cpSync(resolve(opt('--bin')), join(stage, 'bin'), { recursive: true })
const placed: string[] = []
for (const a of args.includes('--abs') ? JSON.parse(readFileSync(resolve(opt('--abs')), 'utf8')) as { from: string; to: string }[] : []) {
  if (existsSync(a.to)) { if (!readFileSync(a.to).equals(readFileSync(a.from))) throw new Error(`absolute input ${a.to} exists with other content`); continue }
  mkdirSync(dirname(a.to), { recursive: true })
  cpSync(a.from, a.to)
  placed.push(a.to)
}
process.on('exit', () => { for (const p of placed) rmSync(p, { force: true }) })
const model = opt('--model', 'gpt-6.1-sol')
const effort = opt('--effort', 'high')
const mode = opt('--mode', 'auto')
const live = args.includes('--live')
const maxMinutes = Number(opt('--max-minutes', '60'))
const maxInput = Number(opt('--max-input-tokens', '40000000'))
const timeoutMs = live ? maxMinutes * 60e3 + 120e3 : Number(opt('--timeout-ms', '240000'))
const credential = live ? resolve(opt('--credential')) : ''

const home = join(stage, 'home')
const config = join(home, '.cat-code')
const tmp = join(stage, 'tmp')
const scratch = probeScratch()
attempt.setScratch(scratch.dir)
const stub = join(scratch.dir, 'stub')
const xdgCache = join(home, '.cache')
const xdgConfig = join(home, '.config')
for (const d of [home, config, tmp, stub, xdgCache, xdgConfig]) mkdirSync(d, { recursive: true, mode: 0o700 })
if (existsSync(join(copy, 'home-seed'))) copyPrivateSeed(join(copy, 'home-seed'), home)

// Isolated account state: a fabricated Codex credential that only the local fake
// transport ever sees. Far-future expiry so no refresh is attempted.
writeFileSync(join(config, '.config.json'), JSON.stringify({
  hasCompletedOnboarding: true,
  projects: { [cwd]: { hasTrustDialogAccepted: true } },
  codexOAuth: live ? JSON.parse(readFileSync(credential, 'utf8')).codexOAuth : { accessToken: 'offline-probe-access', refreshToken: 'offline-probe-refresh', expiresAt: Date.now() + 365 * 86400e3, accountId: 'acct-offline-probe' },
}, null, 2), { mode: 0o600 })
writeFileSync(join(config, 'settings.json'), JSON.stringify({ model, effortLevel: effort }, null, 2), { mode: 0o600 })
chmodSync(join(config, '.config.json'), 0o600)
chmodSync(join(config, 'settings.json'), 0o600)

// The harness itself must not leak the operator's environment into the child.
const keep = ['PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM']
for (const k of Object.keys(process.env)) if (!keep.includes(k)) delete process.env[k]
if (existsSync(join(stage, 'bin'))) process.env.PATH = `${join(stage, 'bin')}:${process.env.PATH}`
Object.assign(process.env, {
  HOME: home, CLAUDE_CONFIG_DIR: config, TMPDIR: tmp, XDG_CACHE_HOME: join(home, '.cache'), XDG_CONFIG_HOME: join(home, '.config'),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  GIT_CONFIG_NOSYSTEM: '1',
  ...(live ? {} : { CCW_PROBE_DIR: stub, CCW_ENGINE: engine, ANTHROPIC_API_KEY: 'sk-ant-offline-probe' }),
  ...(!live && args.includes('--probe-bash') ? { CCW_PROBE_BASH: opt('--probe-bash') } : {}),
})

const bun = Bun.which('bun')!
const runtimes = runtimeAllowances([bun, ...['git', 'node'].flatMap(name => Bun.which(name) ?? [])])
const { SidecarSupervisor } = await import(join(engine, 'app/supervisor/supervisor.ts'))
const { SIDECAR_RUNTIME_ARGS } = await import(join(engine, 'app/main/mainDecisions.ts'))
const profile = sandboxProfile(stage, engine, {
  network: live,
  scratch: scratch.dir,
  runtimeBinaries: runtimes.binaries,
  runtimeLibraries: runtimes.libraries,
})
const frames: unknown[] = []
const supervisor = new SidecarSupervisor({
  sidecarCommand: '/usr/bin/sandbox-exec',
  sidecarArgs: ['-p', profile, bun, ...(live ? [] : [`--preload=${scratch.interceptor}`]), ...SIDECAR_RUNTIME_ARGS, join(engine, 'app/sidecar/index.ts')],
  sidecarCwd: cwd,
  socketDir: join(tmp, 's'),
  log: (line: string) => frames.push({ log: line }),
})
mkdirSync(join(tmp, 's'), { recursive: true })

const sessionId = randomUUID()
let ready: any = null
let activeSeen = false
let done = false
let idleSince = 0
supervisor.subscribe((event: any) => {
  if (event.type !== 'frame') { frames.push({ supervisor: event.type, detail: event.reason ?? event.code ?? undefined }); return }
  const f = event.frame
  frames.push(f)
  if (f.kind === 'ready') ready = f
  const e = f.event ?? f.payload
  if (f.kind === 'event' && e?.type === 'turn.status') {
    if (e.activeTurn) { activeSeen = true; done = false; idleSince = 0 }
    else if (activeSeen) { done = true; idleSince = Date.now() }
  }
})
supervisor.spawnSession(sessionId, { cwd, model, effort, permissionMode: mode })

const deadline = Date.now() + timeoutMs
while (!ready && Date.now() < deadline) await Bun.sleep(100)
if (!ready) throw new Error('sidecar never became ready')
// Any failure after spawn must still stop the sidecar: an orphan keeps the
// caller's output pipe open.
process.on('uncaughtException', e => { try { supervisor.shutdown() } catch {} console.error(e); process.exit(1) })
process.on('unhandledRejection', e => { try { supervisor.shutdown() } catch {} console.error(e); process.exit(1) })
try { supervisor.send(sessionId, { type: 'app.submit', requestId: randomUUID(), prompt }) }
catch (e) { supervisor.shutdown(); await Bun.sleep(1000); throw e }
// Input tokens so far, from the run's own transcripts (one usage per message id).
function inputSoFar(): number {
  const seen = new Set<string>(); let total = 0
  const walk = (d: string): string[] => existsSync(d) ? readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.jsonl') ? [p] : [] }) : []
  for (const f of walk(join(config, 'projects'))) for (const l of readFileSync(f, 'utf8').split('\n')) {
    try { const r = JSON.parse(l); const u = r.message?.usage; if (u && r.message.id && !seen.has(r.message.id)) { seen.add(r.message.id); total += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) } } catch {}
  }
  return total
}
let aborted = ''
let lastCheck = 0
// A finished turn can be followed by another when a background worker reports;
// a live run ends after 60s without a new turn.
while (Date.now() < deadline && !(done && (!live || Date.now() - idleSince > 60e3))) {
  await Bun.sleep(1000)
  if (live && !aborted && Date.now() - lastCheck > 15e3) {
    lastCheck = Date.now()
    const used = inputSoFar()
    if (used > maxInput) aborted = `input tokens ${used} > ${maxInput}`
    if (aborted) supervisor.send(sessionId, { type: 'app.abort', requestId: randomUUID(), reason: 'study cap' })
  }
}
if (live && !done && !aborted) { aborted = `wall time > ${maxMinutes} min`; supervisor.send(sessionId, { type: 'app.abort', requestId: randomUUID(), reason: 'study cap' }); await Bun.sleep(10e3) }
if (live) {
  // Write back refreshed tokens so the next run starts from the current pair.
  const cfg = JSON.parse(readFileSync(join(config, '.config.json'), 'utf8'))
  if (cfg.codexOAuth) {
    writeFileSync(credential, JSON.stringify({ ...JSON.parse(readFileSync(credential, 'utf8')), codexOAuth: cfg.codexOAuth }, null, 2), { mode: 0o600 })
    chmodSync(credential, 0o600)
  }
}
await Bun.sleep(3000) // let post-turn auxiliary requests (title) land
supervisor.shutdown()
await Bun.sleep(1000)
cpSync(home, join(out, 'home'), { recursive: true })
cpSync(stub, join(out, 'stub'), { recursive: true })
rmSync(scratch.dir, { recursive: true, force: true })

writeFileSync(join(out, 'frames.json'), JSON.stringify(frames, null, 1))
const requests = existsSync(join(out, 'stub', 'requests')) ? readdirSync(join(out, 'stub', 'requests')).sort() : []
attempt.complete()
console.log(JSON.stringify({ output: out, ready: !!ready, engineSessionId: ready?.engineSessionId, turnCompleted: done, live, aborted: aborted || undefined, requests }, null, 1))
