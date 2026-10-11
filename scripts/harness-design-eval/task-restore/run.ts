import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fixture } from './fixtures.js'
import { policy as offlinePolicy, sha, validatePrices, type Prices } from './policy.js'
import { environment, profile, dependenciesAt } from './isolation.js'
import { subscriptionGateway, subscriptionPolicy, subscriptionUsage } from './subscription.js'
import { gateway } from './gateway.js'
import { grade, oracleProgram } from './grade.js'
import { dependencyHash, inventory } from './prepare.js'
import type { SidecarSupervisor as SupervisorType } from '../../../app/supervisor/supervisor.js'

function same(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b) }
export function usage(records: any[]) {
  let input = 0, output = 0, cached = 0, created = 0, unknown = 0
  const started = records.filter(r => r.kind === 'request')
  for (const attempt of started) {
    const response = records.find(r => r.kind === 'response' && r.attempt === attempt.attempt)
    if (!response || response.status !== 200) { unknown++; continue }
    let initial: any, final: any
    for (const line of response.text.split('\n')) {
      if (!line.startsWith('data: ')) continue
      try {
        const event = JSON.parse(line.slice(6))
        if (event.type === 'message_start') initial = event.message?.usage
        if (event.type === 'message_delta') final = event.usage
      } catch {}
    }
    const tokenCount = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0
    if (!initial || !final || !tokenCount(initial.input_tokens) || !tokenCount(final.output_tokens) ||
        !tokenCount(initial.cache_creation_input_tokens ?? 0) || !tokenCount(initial.cache_read_input_tokens ?? 0) ||
        !/event: message_stop/.test(response.text)) { unknown++; continue }
    input += initial.input_tokens ?? 0
    created += initial.cache_creation_input_tokens ?? 0
    cached += initial.cache_read_input_tokens ?? 0
    output += final.output_tokens ?? 0
  }
  return { input, cached, created, output, unknownAttempts: unknown, attempts: started.length }
}
export function cost(records: any[], prices: Prices) {
  if (usage(records).unknownAttempts) return null
  let usd = 0
  for (const response of records.filter(r => r.kind === 'response')) {
    let initial: any, output: number | undefined
    for (const line of response.text.split('\n')) {
      if (!line.startsWith('data: ')) continue
      try { const e = JSON.parse(line.slice(6)); if (e.type === 'message_start') initial = e.message?.usage; if (e.type === 'message_delta') output = e.usage?.output_tokens } catch {}
    }
    if (!initial || output === undefined) return null
    const five = initial.cache_creation?.ephemeral_5m_input_tokens ?? 0, hour = initial.cache_creation?.ephemeral_1h_input_tokens ?? 0
    if (five + hour !== (initial.cache_creation_input_tokens ?? 0) || initial.server_tool_use?.web_search_requests || initial.server_tool_use?.web_fetch_requests) return null
    usd += (initial.input_tokens * prices.inputUsdPerMillion + (initial.cache_read_input_tokens ?? 0) * prices.cacheReadUsdPerMillion + five * prices.cacheWrite5mUsdPerMillion + hour * prices.cacheWrite1hUsdPerMillion + output * prices.outputUsdPerMillion) / 1e6
  }
  return usd
}
export function exposure(records: any[], seed: any, compactRequired: boolean) {
  const requests = records.filter(r => r.kind === 'request' && ['work', 'recovery'].includes(r.phase) && r.body.tools?.some((t: any) => ['Bash', 'Read'].includes(t.name)))
  const first = requests[0]
  const history = first?.providerBody?.input ?? first?.body.messages
  const originalTrackingRemoved = first ? !seed.trackingIds.some((id: string) => JSON.stringify(history).includes(id)) : false
  const snapshotCount = first ? (JSON.stringify(history).match(/Unfinished tracked work at compaction\./g) ?? []).length : null
  return { firstRequestSeen: !!first, originalTrackingRemoved, snapshotCount,
    valid: !!first && (!compactRequired || originalTrackingRemoved) }
}
export function verification(frames: any[]) {
  const calls = new Map<string, string>(), results: any[] = []
  for (const frame of frames) {
    const e = frame.event ?? frame.payload
    const m = e?.type === 'message' ? e.message : null
    if (!m || !Array.isArray(m.message?.content)) continue
    for (const block of m.message.content) {
      if (m.type === 'assistant' && block.type === 'tool_use' && block.name === 'Bash') calls.set(block.id, block.input?.command ?? '')
      if (m.type === 'user' && block.type === 'tool_result') results.push(block)
    }
  }
  const checkCalls = [...calls].filter(([, command]) => /(?:^|[\n;&])\s*bun\s+(?:\.\/)?check\.ts(?:\s|$)/.test(command))
  return { attempted: checkCalls.length > 0, succeeded: checkCalls.some(([id]) => results.some(r => r.tool_use_id === id && !r.is_error && JSON.stringify(r.content).includes('Invoice checks passed'))) }
}
export async function run(root: string, live: boolean, approvalPath?: string, subscription = false) {
  const policy = subscription ? { ...offlinePolicy, ...subscriptionPolicy } : offlinePolicy
  if (live && !subscription && !policy.liveExecutionAllowed) throw Error('Live execution blocked: GPT-6.1 Sol pilot is proposal-only; this gateway supports Anthropic Messages only')
  const rawManifest = readFileSync(join(root, 'manifest.json'), 'utf8')
  const manifest = JSON.parse(rawManifest)
  const digest = sha(rawManifest)
  if (readFileSync(join(root, 'manifest.sha256'), 'utf8').trim() !== digest) throw Error('Manifest hash mismatch')
  for (const [key, value] of Object.entries(offlinePolicy)) if (!same(manifest[key], value)) throw Error(`Policy drift: ${key}`)
  const engine = join(root, 'engine')
  if (!same(inventory(engine), manifest.engineInventory)) throw Error('Frozen engine/support changed')
  if (Bun.version !== manifest.runtime.bun || sha(readFileSync(process.execPath)) !== manifest.runtime.binarySha256) throw Error('Runtime drift')
  if (sha(readFileSync(join(engine, 'bun.lock'))) !== manifest.runtime.dependencyLockSha256) throw Error('Dependency lock drift')
  if (dependencyHash(join(engine, 'node_modules')) !== manifest.runtime.dependencyTreeSha256) throw Error('Installed dependency drift')
  if (!same(inventory(import.meta.dir), inventory(join(engine, 'scripts/harness-design-eval/task-restore')))) throw Error('Runner/support drift; prepare again before approval')
  const { SidecarSupervisor } = await import(join(engine, 'app/supervisor/supervisor.ts'))
  let key: string | undefined, prices: Prices | undefined
  if (subscription && (!live || !same(manifest.subscription, subscriptionPolicy))) throw Error('Subscription execution requires frozen subscription policy and --live --subscription')
  if (live && !subscription) {
    if (!approvalPath) throw Error('Live execution requires explicit manifest authorization')
    const approval = JSON.parse(readFileSync(approvalPath, 'utf8'))
    if (approval.authorize !== true || approval.manifestSha256 !== digest || approval.dedicatedProjectConfirmed !== true || approval.providerSpendLimitConfirmed !== true || !Number.isFinite(approval.providerSpendLimitUsd) || approval.providerSpendLimitUsd <= 0 || approval.providerSpendLimitUsd > policy.maxUsdSuite || !approval.keyFile) throw Error('Live authorization/account isolation/provider spending limit incomplete')
    prices = approval.prices
    validatePrices(prices!)
    // The first credential read is behind the explicit gate above.
    key = readFileSync(approval.keyFile, 'utf8').trim()
    if (!key.startsWith('sk-ant-')) throw Error('Dedicated first-party API key required')
  }
  const destination = join(root, subscription ? 'subscription-results' : live ? 'live-results' : 'offline-results')
  if (existsSync(destination)) throw Error('Results already exist; no silent reruns')
  mkdirSync(destination, { mode: 0o700 })
  writeFileSync(join(destination, 'results.json'), JSON.stringify({ manifestSha256: digest, live, prices: prices ?? null, results: [] }, null, 2))
  // Supervisor inherits its parent's environment. Remove ambient account,
  // provider, hook and proxy settings before spawning any engine process.
  if (!subscription) for (const name of Object.keys(process.env)) if (!['PATH', 'SHELL', 'LANG', 'TERM'].includes(name)) delete process.env[name]
  const suite = { usd: 0, input: 0, requests: 0 }, results: any[] = [], start = Date.now()
  for (const item of subscription ? subscriptionPolicy.schedule : manifest.schedule) {
    if (Date.now() - start >= policy.maxSuiteMs) break
    const f = fixture(item.caseId)
    const seedRoot = join(root, 'seeds', f.id), seed = JSON.parse(readFileSync(join(seedRoot, 'seed.json'), 'utf8'))
    if (!same(inventory(join(seedRoot, 'workspace')), manifest.inputs[f.id].workspace) || !same(inventory(join(seedRoot, 'home')), manifest.inputs[f.id].home)) throw Error('Seed drift')
    // Paths carry no arm/case labels. Same workspace path for both arms within a
    // pair, recreated byte-for-byte; HOME/config and conversation IDs are cloned.
    const pairKey = `${f.id}-${item.repeat}`
    const pairPathFile = join(destination, `${pairKey}.path`)
    const stage = existsSync(pairPathFile) ? readFileSync(pairPathFile, 'utf8') : mkdtempSync('/private/tmp/tre-')
    if (!existsSync(pairPathFile)) writeFileSync(pairPathFile, stage)
    mkdirSync(stage, { recursive: true, mode: 0o700 })
    const cwd = join(stage, 'workspace'), home = join(stage, 'home'), temp = join(stage, 'tmp')
    cpSync(join(seedRoot, 'workspace'), cwd, { recursive: true }); cpSync(join(seedRoot, 'home'), home, { recursive: true })
    mkdirSync(temp)
    cpSync(join(engine, 'scripts/harness-design-eval/task-restore/preload.ts'), join(stage, 'transport.ts'))
    if (subscription) cpSync(join(engine, 'scripts/harness-design-eval/task-restore/subscription-preload.ts'), join(stage, 'subscription-transport.ts'))
    // Transcript project routing is cwd-derived. Rebase only the project catalog
    // directory key and path fields, identically in both arms.
    const oldCwd = join(seedRoot, 'workspace')
    const configPath = join(home, '.cat-code/.config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    config.projects = { [cwd]: { hasTrustDialogAccepted: true } }
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 })
    const projects = join(home, '.cat-code/projects')
    const oldProject = oldCwd.replace(/[^a-zA-Z0-9]/g, '-')
    const newProject = cwd.replace(/[^a-zA-Z0-9]/g, '-')
    if (existsSync(join(projects, oldProject))) {
      cpSync(join(projects, oldProject), join(projects, newProject), { recursive: true })
      rmSync(join(projects, oldProject), { recursive: true })
    }
    for (const path of Object.keys(inventory(join(home, '.cat-code')))) {
      if (!path.endsWith('.jsonl')) continue
      const file = join(home, '.cat-code', path)
      writeFileSync(file, readFileSync(file, 'utf8').replaceAll(oldCwd, cwd))
    }
    const resumeTranscript = join(projects, newProject, `${seed.sessionId}.jsonl`)
    if (!existsSync(resumeTranscript)) throw Error('Rebased seed transcript missing before gateway startup')
    const records: any[] = [], frames: any[] = []
    const out = join(destination, `${pairKey}-${item.arm}`)
    mkdirSync(out, { mode: 0o700 })
    writeFileSync(join(out, 'attempt.json'), JSON.stringify({ ...item, cohort: f.cohort, mocked: !live, started: Date.now() }))
    const save = (record: any) => {
      records.push(record); appendFileSync(join(out, 'requests.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 })
    }
    const g = subscription ? await subscriptionGateway(engine, { save, suite, conversationId: randomUUID() })
      : gateway({ live, key, prices, redirect: f.redirect, suite, save })
    const env = { ...environment(home, temp, f.mode), TASK_EVAL_GATEWAY: g.endpoint, TASK_EVAL_CAPABILITY: g.capability,
      ...(subscription ? { TASK_EVAL_ENGINE_PATH: engine, ANTHROPIC_SMALL_FAST_MODEL: policy.model } : {}),
      CAT_CODE_EVAL_COMPACT_TASK_RESTORE: item.arm === 'on' ? '1' : '0' }
    const dependencies = dependenciesAt(engine)
    const sandbox = profile(stage, engine, dependencies, g.port)
    const secret = join(out, 'isolation-canary.txt')
    writeFileSync(secret, 'Private grader/output canary')
    const probeCode = `import {readFileSync, openSync, closeSync, lstatSync, realpathSync} from 'node:fs';
      for(const p of process.argv.slice(1)){let denied=false;try{readFileSync(p)}catch{denied=true}if(!denied)throw Error('Private file readable')}
      readFileSync('src/invoice.ts');
      const fd=openSync('src/invoice.ts','r');lstatSync('/dev/fd/'+fd);realpathSync('/dev/fd/'+fd);closeSync(fd);
      if(process.env.TASK_EVAL_GATEWAY||process.env.TASK_EVAL_CAPABILITY)throw Error('Gateway capability leaked');
      let blocked=false;try{await fetch('https://example.com')}catch{blocked=true}if(!blocked)throw Error('External transport admitted');
      console.log('isolation passed');`
    const probe = Bun.spawn(['/usr/bin/sandbox-exec', '-p', sandbox, process.execPath, `--preload=${join(stage, 'transport.ts')}`,
      ...(subscription ? [`--preload=${join(stage, 'subscription-transport.ts')}`] : []), '--eval', probeCode,
      join(engine, 'scripts/harness-design-eval/task-restore/grade.ts'), secret], { cwd, env, stdout: 'pipe', stderr: 'pipe' })
    const [probeOut, probeError, probeExit] = await Promise.all([new Response(probe.stdout).text(), new Response(probe.stderr).text(), probe.exited])
    writeFileSync(join(out, 'isolation.json'), JSON.stringify({ probeOut, probeError, probeExit }))
    if (probeExit !== 0 || !probeOut.includes('isolation passed')) { g.stop(); throw Error('Agent isolation preflight failed') }
    const started = Date.now(), deadline = Math.min(started + policy.maxRunMs, start + policy.maxSuiteMs)
    let supervisor: SupervisorType | undefined, active = false, done = false, ready: any, appId: string, error: string | null = null, boundaryError: string | null = null
    const cleanup = () => { supervisor?.shutdown(); g.stop(); process.exit(130) }
    process.once('SIGTERM', cleanup); process.once('SIGINT', cleanup)
    async function waitUntil(predicate: () => boolean, timeout = deadline) {
      while (!predicate() && !boundaryError && Date.now() < timeout) await Bun.sleep(50)
      if (boundaryError) throw Error(boundaryError)
      if (!predicate()) throw Error('Run wall-time cap')
    }
    async function attach() {
      ready = undefined; active = false; done = false; boundaryError = null; appId = randomUUID()
      supervisor = new SidecarSupervisor({ sidecarCommand: '/usr/bin/sandbox-exec',
        sidecarArgs: ['-p', sandbox, process.execPath, `--preload=${join(stage, 'transport.ts')}`,
          ...(subscription ? [`--preload=${join(stage, 'subscription-transport.ts')}`] : []),
          ...policy.runtimeFeatures.map(feature => `--feature=${feature}`), 'run', join(engine, 'app/sidecar/index.ts')],
        sidecarCwd: cwd, sidecarEnv: subscription ? Object.assign(Object.fromEntries(Object.keys(process.env).map(key => [key, undefined])), env) : env, socketDir: join(temp, 's') })
      supervisor.subscribe((event: any) => {
        appendFileSync(join(out, 'frames.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 })
        if (event.type !== 'frame') {
          frames.push({ supervisor: event })
          if (event.type === 'exit' && !ready) boundaryError = `Sidecar exited before ready: ${event.code}`
          return
        }
        const frame = event.frame; frames.push(frame)
        if (frame.kind === 'error' && frame.code === 'bad_request') boundaryError = `Sidecar rejected evaluator input: ${frame.message}`
        if (frame.kind === 'ready') ready = frame
        const e = frame.event ?? frame.payload
        if (frame.kind === 'event' && e?.type === 'turn.status') {
          if (e.activeTurn) { active = true; done = false }
          else if (active) done = true
        }
        if (frame.kind === 'event' && e?.type === 'permission.requested') {
          // The inherited OS sandbox owns filesystem/network containment. The
          // same allow-once policy is applied in both arms; no rules are saved.
          supervisor!.send(appId, { type: 'permission.response', requestId: e.request.requestId, response: { behavior: 'allow', updatedInput: {} } } as any)
        }
      })
      supervisor.spawnSession(appId, { cwd, model: policy.model, effort: policy.effort, permissionMode: 'default', resumeEngineSessionId: seed.sessionId })
      await waitUntil(() => !!ready, Math.min(deadline, Date.now() + 20000))
    }
    async function submit(prompt: string, phase: string) {
      g.setPhase(phase); active = false; done = false
      supervisor!.send(appId, { type: 'app.submit', requestId: randomUUID(), prompt })
      await waitUntil(() => done)
      await Bun.sleep(250)
      if (g.stats().stopped) throw Error(g.stats().stopped!)
    }
    try {
      await attach()
      if (f.cohort !== 'ordinary') {
        await submit(f.compact, 'compact')
        if (f.restart) { supervisor!.shutdown(); await Bun.sleep(500); await attach() }
      }
      if (subscription) g.setPhase('work')
      await submit(f.continuation, 'work')
      if (subscription) {
        const beforeRecovery = exposure(records, seed, true)
        writeFileSync(join(out, 'before-recovery.json'), JSON.stringify({ exposure: beforeRecovery, verification: verification(frames) }))
      }
      await submit(f.recovery, 'recovery')
    } catch (caught) { error = String(caught) }
    finally { supervisor?.shutdown(); await Bun.sleep(500); g.stop(); if ('drain' in g) await g.drain(); process.removeListener('SIGTERM', cleanup); process.removeListener('SIGINT', cleanup) }
    // Grading happens with no model process running. Its sandbox prevents
    // fixture code from reading answers, keys, or other runs or writing results.
    let oracle: Record<string, boolean> | null = null
    if (!f.redirect) {
      const grader = Bun.spawn(['/usr/bin/sandbox-exec', '-p', sandbox.replace(`(allow file-write* (subpath ${JSON.stringify(stage)}) (literal "/dev/null"))`, '(allow file-write* (literal "/dev/null"))'),
        process.execPath, '--eval', oracleProgram], { cwd, env: environment(home, temp, f.mode), stdout: 'pipe', stderr: 'pipe' })
      const timer = setTimeout(() => grader.kill(), 5000)
      const [stdout, stderr, code] = await Promise.all([new Response(grader.stdout).text(), new Response(grader.stderr).text(), grader.exited])
      clearTimeout(timer)
      writeFileSync(join(out, 'oracle.json'), JSON.stringify({ stdout, stderr, code }))
      if (code === 0) { try { oracle = JSON.parse(stdout.trim()) } catch {} }
    }
    const check = verification(frames)
    const scoring = grade(cwd, f.id, oracle, f.redirect ? check.attempted : check.succeeded)
    const boundaries = new Set(frames.flatMap(frame => frame.event?.message?.subtype === 'compact_boundary' ? [frame.event.message.uuid] : [])).size
    const e = exposure(records, seed, f.cohort !== 'ordinary')
    const u = subscription ? subscriptionUsage(records) : usage(records)
    const validity = !error && e.valid && (f.cohort === 'ordinary' ? boundaries === 0 : boundaries > 0)
    const result = { ...item, cohort: f.cohort, mocked: !live, error, valid: validity, boundaries, exposure: e,
      restorationDeliveryGap: item.arm === 'on' && f.cohort === 'forced' && e.snapshotCount !== 1,
      ...scoring, verification: check, elapsedMs: Date.now() - started, usage: u, reservations: g.stats(),
      subscription, costUsdEstimate: prices ? cost(records, prices) : null }
    cpSync(cwd, join(out, 'workspace'), { recursive: true })
    // Save isolated transcripts, not configuration/credentials. No live key exists
    // in the child, but keeping only transcript evidence reduces future risk.
    cpSync(join(home, '.cat-code/projects'), join(out, 'transcripts'), { recursive: true })
    writeFileSync(join(out, 'requests.json'), JSON.stringify(records, null, 2), { mode: 0o600 })
    writeFileSync(join(out, 'frames.json'), JSON.stringify(frames, null, 2), { mode: 0o600 })
    writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2))
    results.push(result)
    writeFileSync(join(destination, 'results.json'), JSON.stringify({ manifestSha256: digest, live, prices: prices ?? null, results }, null, 2))
    rmSync(stage, { recursive: true })
    console.log(JSON.stringify({ caseId: f.id, repeat: item.repeat, arm: item.arm, valid: validity, mocked: !live, error }))
    if (!subscription && (error || !validity || (live && (scoring.incorrect.length || u.unknownAttempts || result.costUsdEstimate === null || g.stats().stopped)))) break
  }
  return { destination, runs: results.length, manifestSha256: digest, live }
}
if (import.meta.main) {
  const args = process.argv.slice(2)
  if (!args.includes('--offline') && !args.includes('--live')) throw Error('Choose --offline or explicitly authorized --live')
  if (args.includes('--offline') && args.includes('--live')) throw Error('Conflicting execution modes')
  const authorization = args.indexOf('--authorization')
  console.log(JSON.stringify(await run(resolve(args[0]!), args.includes('--live'), authorization >= 0 ? args[authorization + 1] : undefined, args.includes('--subscription')), null, 2))
}
