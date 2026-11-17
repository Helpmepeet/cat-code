import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

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

test('resume validates current request hashes without sends, completes only the missing variant, and never replays a completed report', async () => {
  const root = mkdtempSync(join(tmpdir(), 'auto-eval-resume-'))
  try {
    const script = join(import.meta.dir, 'run.ts'), preload = join(root, 'transport-preload.ts'), budget = join(root, 'budget.txt')
    const env = { ...process.env, CLAUDE_CONFIG_DIR: root, ANTHROPIC_API_KEY: 'fixture-key' }
    const prefix = [process.execPath, '--feature=TRANSCRIPT_CLASSIFIER', '--feature=AUTO_MODE_UPSTREAM_PORT']
    const offlineOut = join(root, 'offline.json')
    expect(Bun.spawnSync([...prefix, script, '--offline', '--only', 'ordinary-build', '--out', offlineOut], { cwd: root, env }).exitCode).toBe(0)
    const offline = await Bun.file(offlineOut).json()
    const firstStage = (entry: typeof offline.evidence[number]) => ({ ...entry, stages: 1,
      requestedModels: entry.requestedModels.slice(0, 1), stageChars: entry.stageChars.slice(0, 1), digests: entry.digests.slice(0, 1) })
    const full = { id: 'ordinary-build', expect: 'allow', variant: 'full', repeat: 0, shouldBlock: false, unavailable: false,
      invalid: false, model: 'gpt-6-luna', requestedModel: 'gpt-6-luna', durationMs: 777 }
    const partial = { ...offline, mode: 'live', account: { alias: 'fixture', idPrefix: 'fixture-',
      reference: createHash('sha256').update('fixture-approved-account').digest('hex').slice(0, 12) },
      authorizedMaxRequests: 4, backendSends: 2, reviewerRequestsAttempted: 2, stoppedEarly: 'fixture connection reset',
      transportFailures: [{ code: 'ECONNRESET' }],
      samples: [full, { ...full, variant: 'reduced', unavailable: true, model: 'sonnet' }],
      evidence: offline.evidence.map(firstStage) }
    partial.evidence[0].components[0].historyChars = 999999999
    const previous = join(root, 'partial.json'), completed = join(root, 'completed.json')
    writeFileSync(previous, JSON.stringify(partial))
    writeFileSync(preload, `
      import { mock } from 'bun:test'; import { writeFileSync } from 'node:fs';
      globalThis.fetch = async () => { throw new Error('Unexpected real network in fixture'); };
      mock.module(${JSON.stringify(join(import.meta.dir, 'transport.ts'))}, () => ({
        observedAccount: async () => ({ accountId: 'fixture-approved-account', alias: 'fixture' }),
        pinnedCodexTransport: (account, model, limit) => {
          writeFileSync(${JSON.stringify(budget)}, String(limit)); let calls = 0;
          return { get requestsAttempted() { return calls; }, get backendSends() { return calls; }, failures: [], restoreFetch() {},
            async send(options) {
              if (++calls > limit) throw new Error('Fixture budget exceeded');
              return { id: 'fixture-answer', type: 'message', role: 'assistant', model,
                content: [{ type: 'tool_use', id: 'fixture-verdict', name: options.tool_choice.name, input: calls === 1 ? { shouldBlock: true } :
                  { shouldBlock: false, thinking: 'The synthetic local build is permitted.', reason: 'The synthetic local build is permitted.' } }],
                stop_reason: 'tool_use', stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
            } };
        },
      }));
    `)
    const liveBase = [...prefix, '--preload', preload, script, '--live', '--model', 'gpt-6-luna', '--account', 'fixture',
      '--account-id-prefix', 'fixture-', '--max-requests', '4']
    const live = [...liveBase, '--only', 'ordinary-build']
    writeFileSync(budget, 'not-constructed')
    const verified = Bun.spawnSync([...live, '--resume', previous, '--verify-resume'], { cwd: root, env })
    expect(verified.exitCode).toBe(0)
    expect(JSON.parse(verified.stdout.toString())).toMatchObject({ retained: 1, pending: 1, remainingRequests: 2, backendSends: 0 })
    expect(await Bun.file(budget).text()).toBe('not-constructed')
    const extension = Bun.spawnSync([...liveBase, '--resume', previous, '--verify-resume'], { cwd: root, env })
    expect(extension.exitCode).toBe(0)
    const extensionPlan = JSON.parse(extension.stdout.toString())
    expect(extensionPlan).toMatchObject({ retained: 1, remainingRequests: 2, backendSends: 0 })
    expect(extensionPlan.addedCaseIds).toContain('formatting-instructions-control-push-condition')
    expect(await Bun.file(budget).text()).toBe('not-constructed')
    const resumed = Bun.spawnSync([...live, '--resume', previous, '--out', completed], { cwd: root, env })
    if (resumed.exitCode !== 0) throw new Error(resumed.stderr.toString() + resumed.stdout.toString())
    expect(resumed.exitCode).toBe(0)
    const result = await Bun.file(completed).json()
    expect(await Bun.file(budget).text()).toBe('2')
    expect(result).toMatchObject({ backendSends: 4, reviewerRequestsAttempted: 4,
      evaluationScope: 'case', pairedComparisonPassed: true, eligibleForReduction: false })
    expect(result.samples).toHaveLength(2)
    expect(result.samples.find((s: { variant: string }) => s.variant === 'full').durationMs).toBe(777)
    expect(result.evidence.find((s: { variant: string }) => s.variant === 'full').components[0].historyChars).toBeLessThan(1000)
    expect(result.resumeHistory[0].failedSamples[0].sample.unavailable).toBe(true)
    expect(result.transportFailures).toEqual([{ code: 'ECONNRESET' }])
    writeFileSync(budget, 'not-constructed')
    const replay = Bun.spawnSync([...live, '--resume', completed, '--out', join(root, 'replayed.json')], { cwd: root, env })
    expect(replay.exitCode).toBe(0)
    expect(await Bun.file(budget).text()).toBe('not-constructed')
    expect(await Bun.file(join(root, 'replayed.json')).json()).toMatchObject({ backendSends: 4, reviewerRequestsAttempted: 4 })
    partial.evidence[0].digests[0] = 'a'.repeat(64)
    writeFileSync(previous, JSON.stringify(partial))
    const changedPolicy = Bun.spawnSync([...live, '--resume', previous, '--verify-resume'], { cwd: root, env })
    expect(changedPolicy.exitCode).not.toBe(0)
    expect(changedPolicy.stderr.toString()).toContain('policy or request changed')
    expect(await Bun.file(budget).text()).toBe('not-constructed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
