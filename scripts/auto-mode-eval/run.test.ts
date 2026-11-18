import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { EVIDENCE_CASES } from './cases.js'

test('the executable requires an explicit mode and names missing live authorization inputs before loading providers', () => {
  const script = join(import.meta.dir, 'run.ts')
  for (const [args, message] of [
    [[], 'Choose --offline'],
    [['--live', '--model', 'fixture-model'], '--live requires --model and --account'],
    [['--live', '--offline'], 'Choose exactly one'],
  ] as const) {
    const result = Bun.spawnSync([process.execPath, script, ...args], { env: { ...process.env, CLAUDE_CONFIG_DIR: '/nonexistent/fixture-config' } })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain(message)
  }
})

test('the executable stops on the first unavailable reviewer and records no blocked fallback as an evaluated model', async () => {
  const root = mkdtempSync(join(tmpdir(), 'auto-eval-stop-'))
  try {
    const preload = join(root, 'transport-preload.ts')
    const out = join(root, 'report.json')
    writeFileSync(preload, `
      import { mock } from 'bun:test';
      globalThis.fetch = async () => { throw new Error('Unexpected real network in fixture'); };
      mock.module(${JSON.stringify(join(import.meta.dir, 'transport.ts'))}, () => ({
        observedAccount: async () => ({ accountId: 'fixture-approved-account' }),
        pinnedCodexTransport: () => {
          let attempts = 0;
          return { account: { alias: 'fixture', idPrefix: 'fixture-' }, backendSends: 0,
            get requestsAttempted() { return attempts; }, failures: [{ name: 'Error', message: 'Fixture transport unavailable' }],
            restoreFetch() {}, async send() { attempts++; throw new Error('Fixture transport unavailable'); } };
        },
      }));
    `)
    const result = Bun.spawnSync([process.execPath, '--feature=TRANSCRIPT_CLASSIFIER', '--feature=AUTO_MODE_UPSTREAM_PORT',
      '--preload', preload, join(import.meta.dir, 'run.ts'), '--live', '--model', 'gpt-6-luna', '--account', 'fixture',
      '--account-id-prefix', 'fixture-', '--max-requests', '104', '--out', out],
    { cwd: root, env: { ...process.env, CLAUDE_CONFIG_DIR: root, ANTHROPIC_API_KEY: 'fixture-key' } })
    expect(result.exitCode).toBe(1)
    const report = await Bun.file(out).json()
    expect(report.samples).toHaveLength(1)
    expect(report.samples[0]).toMatchObject({ requestedModel: 'gpt-6-luna', unavailable: true })
    expect(report).toMatchObject({ reviewerRequestsAttempted: 1, backendSends: 0, accuracyMeasured: false, latencyMeasured: false })
    expect(report.comparison.models).toEqual([])
    expect(report.stoppedEarly).toContain('Reviewer unavailable')
    expect(report.transportFailures[0].message).toBe('Fixture transport unavailable')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

const runner = [process.execPath, '--feature=TRANSCRIPT_CLASSIFIER', '--feature=AUTO_MODE_UPSTREAM_PORT']
const script = join(import.meta.dir, 'run.ts')

function liveFixture(root: string, limit: number) {
  const preload = join(root, 'transport-preload.ts')
  const budget = join(root, 'budget.txt')
  const release = join(root, 'release')
  writeFileSync(preload, `
    import { mock } from 'bun:test'; import { existsSync, writeFileSync } from 'node:fs';
    globalThis.fetch = async () => { throw new Error('Unexpected real network in fixture'); };
    mock.module(${JSON.stringify(join(import.meta.dir, 'transport.ts'))}, () => ({
      observedAccount: async () => ({ accountId: 'fixture-approved-account', alias: 'fixture' }),
      pinnedCodexTransport: (account, model, limit, reserve) => {
        writeFileSync(${JSON.stringify(budget)}, String(limit)); let attempts = 0, sends = 0;
        return { get requestsAttempted() { return attempts; }, get backendSends() { return sends; },
          failures: [{ code: 'ECONNRESET' }], restoreFetch() {},
          async send(options) {
            if (++attempts > limit) throw new Error('Fixture budget exceeded');
            await reserve();
            sends++;
            const pass = process.env.CATCODE_EVAL_FIXTURE_PASS;
            if (pass === 'crash') process.kill(process.pid, 'SIGKILL');
            if (pass === 'initial' && sends === 3) throw new Error('Fixture transport unavailable');
            if (pass === 'pause') {
              const timeout = Date.now() + 8000;
              while (!existsSync(${JSON.stringify(release)}) && Date.now() < timeout) await Bun.sleep(20);
            }
            return { id: 'fixture-answer', type: 'message', role: 'assistant', model,
              content: [{ type: 'tool_use', id: 'fixture-verdict', name: options.tool_choice.name,
                input: { shouldBlock: pass === 'initial' ? sends === 1 : sends === 1 && pass === 'resume',
                  thinking: 'PRIVATE_THINKING_MUST_NOT_BE_REPORTED',
                  reason: 'The synthetic local build is permitted.' + ' rationale'.repeat(100) } }],
              stop_reason: 'tool_use', stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
          } };
      },
    }));
  `)
  const base = [...runner, '--preload', preload, script, '--live', '--model', 'gpt-6-luna', '--account', 'fixture',
    '--account-id-prefix', 'fixture-', '--max-requests', String(limit)]
  const env = { ...process.env, CLAUDE_CONFIG_DIR: root, ANTHROPIC_API_KEY: 'fixture-key' }
  const run = (args: string[], pass = 'resume') => Bun.spawnSync([...base, ...args], { cwd: root,
    env: { ...env, CATCODE_EVAL_FIXTURE_PASS: pass } })
  return { base, budget, release, env, run }
}

test('resume uses the durable latest checkpoint, verifies changed request settings, and never replays completed cases', async () => {
  const root = mkdtempSync(join(tmpdir(), 'auto-eval-resume-'))
  try {
    const { run, budget } = liveFixture(root, 5)
    const previous = join(root, 'partial.json'), completed = join(root, 'completed.json')
    const only = ['--only', 'ordinary-build']
    const partial = run([...only, '--out', previous], 'initial')
    expect(partial.exitCode).toBe(1)
    const partialReport = await Bun.file(previous).json()
    expect(partialReport).toMatchObject({ backendSends: 3, reservedBackendSends: 3 })
    expect(partialReport.samples.map((sample: { unavailable: boolean }) => sample.unavailable)).toEqual([false, true])
    writeFileSync(budget, 'not-constructed')
    const verified = run([...only, '--resume', previous, '--verify-resume'])
    if (verified.exitCode !== 0) throw new Error(verified.stderr.toString())
    expect(JSON.parse(verified.stdout.toString())).toMatchObject({ retained: 1, pending: 1, remainingRequests: 2, backendSends: 0 })
    const settings = join(root, 'settings.json')
    writeFileSync(settings, JSON.stringify({ reasoningSummaryDetail: 'detailed' }))
    const changed = run([...only, '--resume', previous, '--verify-resume'])
    expect(changed.exitCode).not.toBe(0)
    expect(changed.stderr.toString()).toContain('policy or request changed')
    rmSync(settings)
    const extension = run(['--resume', previous, '--verify-resume'])
    expect(extension.exitCode).toBe(0)
    const extensionPlan = JSON.parse(extension.stdout.toString())
    expect(extensionPlan).toMatchObject({ retained: 1, remainingRequests: 2, backendSends: 0 })
    expect(extensionPlan.addedCaseIds).toContain('formatting-instructions-control-push-condition')
    expect(await Bun.file(budget).text()).toBe('not-constructed')

    const resumed = run([...only, '--resume', previous, '--out', completed])
    if (resumed.exitCode !== 0) throw new Error(resumed.stderr.toString())
    const result = await Bun.file(completed).json()
    expect(await Bun.file(budget).text()).toBe('2')
    expect(result).toMatchObject({ backendSends: 5, reservedBackendSends: 5, reviewerRequestsAttempted: 5,
      evaluationScope: 'case', pairedComparisonPassed: true, eligibleForReduction: false })
    expect(result.samples).toHaveLength(2)
    expect(result.samples[0].durationMs).toBe(partialReport.samples[0].durationMs)
    const diagnostic = result.samples.find((sample: { variant: string }) => sample.variant === 'reduced')
    expect(diagnostic.reason).toHaveLength(600)
    expect(diagnostic.reason).toStartWith('The synthetic local build is permitted.')
    expect(diagnostic.stageDecisions).toMatchObject([{ stage: 'fast', shouldBlock: true },
      { stage: 'thinking', shouldBlock: false, reason: diagnostic.reason }])
    expect(JSON.stringify(result)).not.toContain('PRIVATE_THINKING_MUST_NOT_BE_REPORTED')
    expect(result.resumeHistory[0].failedSamples[0].sample.unavailable).toBe(true)
    expect(result.transportFailures).toContainEqual({ code: 'ECONNRESET' })

    writeFileSync(budget, 'not-constructed')
    const replayed = join(root, 'replayed.json')
    const replay = run([...only, '--resume', previous, '--out', replayed])
    expect(replay.exitCode).toBe(0)
    expect(await Bun.file(budget).text()).toBe('not-constructed')
    expect(await Bun.file(replayed).json()).toMatchObject({ backendSends: 5, reservedBackendSends: 5, reviewerRequestsAttempted: 5 })
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 15_000)

test('a stopped process leaves its reservation spent even before any sample completes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'auto-eval-crashed-'))
  try {
    const { run, budget } = liveFixture(root, 1)
    const out = join(root, 'interrupted.json')
    const crashed = run(['--only', 'ordinary-build', '--out', out], 'crash')
    expect(crashed.exitCode).not.toBe(0)
    expect(await Bun.file(out).json()).toMatchObject({ backendSends: 0, samples: [] })
    writeFileSync(budget, 'not-constructed')
    const verified = run(['--only', 'ordinary-build', '--resume', out, '--verify-resume'])
    expect(verified.exitCode).not.toBe(0)
    expect(verified.stderr.toString()).toContain('No authorized backend sends remain')
    expect(await Bun.file(budget).text()).toBe('not-constructed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a second process cannot spend an active evaluation budget from a copy of its resume handle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'auto-eval-concurrent-'))
  const out = join(root, 'original.json')
  const { run, base, budget, release, env } = liveFixture(root, 2)
  const active = Bun.spawn([...base, '--only', 'ordinary-build', '--out', out], {
    cwd: root, env: { ...env, CATCODE_EVAL_FIXTURE_PASS: 'pause' }, stdout: 'ignore', stderr: 'ignore',
  })
  try {
    const expiresAt = Date.now() + 5000
    while (!existsSync(budget) && Date.now() < expiresAt) await Bun.sleep(20)
    expect(existsSync(budget)).toBe(true)
    const copy = join(root, 'copy.json')
    writeFileSync(copy, await Bun.file(out).text())
    const conflict = run(['--only', 'ordinary-build', '--resume', copy])
    expect(conflict.exitCode).not.toBe(0)
    expect(conflict.stderr.toString()).toContain('already being held')
    writeFileSync(release, '')
    expect(await active.exited).toBe(0)
    expect(await Bun.file(out).json()).toMatchObject({ backendSends: 2, reservedBackendSends: 2 })
  } finally {
    active.kill()
    await active.exited
    rmSync(root, { recursive: true, force: true })
  }
}, 15_000)

test('offline emits a complete full-corpus JSON report to stdout', async () => {
  const child = Bun.spawn([...runner, script, '--offline'], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(stderr)
  const report = JSON.parse(stdout)
  expect(report.cases).toBe(EVIDENCE_CASES.length)
  expect(report.evidence).toHaveLength(EVIDENCE_CASES.length * 2)
  expect(report.structuralFailures).toBe(0)
})

test('offline qualification rejects drift and treats an empty active manifest as disabled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'auto-eval-qualification-'))
  try {
    const verify = ['--offline', '--verify-qualification']
    const candidatePath = join(root, 'candidate.json')
    writeFileSync(candidatePath, 'null')
    const disabled = Bun.spawnSync([...runner, script, ...verify, '--qualification', candidatePath])
    expect(disabled.exitCode).toBe(0)
    expect(JSON.parse(disabled.stdout.toString())).toEqual({ qualification: 'none', reductionEnabled: false })

    // Captured inputs exercise compatibility only. This fixture makes no
    // claim that a reviewer was run or that a production reduction qualifies.
    const offline = Bun.spawnSync([...runner, script, '--offline'])
    expect(offline.exitCode).toBe(0)
    const report = JSON.parse(offline.stdout.toString())
    const byId = new Map(EVIDENCE_CASES.map(test => [test.id, test.expect]))
    const candidate = { schema: 1, model: report.model, repeats: 1, corpusDigest: report.corpusDigest, policyDigest: report.policyDigest,
      requests: report.evidence.map((entry: typeof report.evidence[number]) => ({ ...entry, shouldBlock: byId.get(entry.id) === 'block' })) }
    writeFileSync(candidatePath, JSON.stringify(candidate))
    const matched = Bun.spawnSync([...runner, script, ...verify, '--qualification', candidatePath])
    if (matched.exitCode !== 0) throw new Error(matched.stderr.toString())
    expect(JSON.parse(matched.stdout.toString())).toMatchObject({ qualification: 'verified', cases: EVIDENCE_CASES.length })

    candidate.requests[0].digests[0] = 'a'.repeat(64)
    writeFileSync(candidatePath, JSON.stringify(candidate))
    const stale = Bun.spawnSync([...runner, script, ...verify, '--qualification', candidatePath])
    expect(stale.exitCode).not.toBe(0)
    expect(stale.stderr.toString()).toContain('Auto Mode reduction qualification changed')
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 15_000)
