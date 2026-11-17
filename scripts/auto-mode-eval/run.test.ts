import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

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
