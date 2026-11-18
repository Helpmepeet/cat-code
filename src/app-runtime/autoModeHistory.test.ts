import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SIDECAR_RUNTIME_ARGS } from '../../app/main/mainDecisions.js'

async function fixture(scenario: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'auto-history-')))
  try {
    await mkdir(join(root, 'config'))
    await mkdir(join(root, 'workspace'))
    const child = Bun.spawn([process.execPath, ...SIDECAR_RUNTIME_ARGS, new URL('./autoModeHistory.fixture.ts', import.meta.url).pathname], {
      cwd: join(root, 'workspace'), stdout: 'pipe', stderr: 'pipe',
      env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin', HOME: root, TMPDIR: root,
        CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
        ANTHROPIC_API_KEY: 'isolated-fixture-not-a-credential', CLAUDE_CODE_USE_OPENAI: '0', CLAUDE_CODE_AUTO_MODE_MODEL: 'gpt-6-luna',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', AUTO_HISTORY_TEST_ROOT: root, AUTO_HISTORY_TEST_SCENARIO: scenario },
    })
    const timer = setTimeout(() => child.kill(), 25_000)
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    clearTimeout(timer)
    if (code !== 0) throw new Error(`History fixture failed (${code}): ${stderr}\n${stdout}`)
    return JSON.parse(await readFile(join(root, 'evidence.json'), 'utf8'))
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('unqualified artifact review keeps history, provenance, refusals, imports and bound approval scope', async () => {
  for (const scenario of ['independent', 'copied', 'refusal', 'import', 'proposal']) {
    const evidence = await fixture(scenario)
    expect(evidence.noiseContent).toContain('NOISE_HISTORY_MARKER')
    expect(evidence.mainHistoryRetainsNoise).toBe(true)
    expect(evidence.classifierBodies.length).toBeGreaterThan(0)
    for (const request of evidence.classifierBodies) {
      const history = JSON.stringify(request.messages)
      expect(history).toContain('NOISE_HISTORY_MARKER')
      if (scenario === 'copied') {
        expect(history).toContain('source.txt')
        expect(history).toContain('COPIED_PROVENANCE_MARKER')
      }
      if (scenario === 'refusal') {
        expect(history).toContain('REFUSAL_HISTORY_MARKER')
        expect(history).toContain('rejected-by-user')
        expect(evidence.decisions.some((record: any) => record.outcome === 'rejected-by-user')).toBe(true)
      }
      if (scenario === 'import') expect(history).toContain('OLD_HELPER_MARKER')
      if (scenario === 'proposal') {
        expect(history).toContain('PROPOSAL_SCOPE_MARKER')
        expect(history).toContain('both reports only after')
      }
    }
    expect(evidence.permissions.length).toBe(scenario === 'refusal' ? 1 : 0)
    expect(evidence.content).toContain(scenario === 'copied' ? 'COPIED_PROVENANCE_MARKER' : scenario === 'import' ? 'require(' : 'REPORT_READY')
  }
}, 120_000)

test('Luna and the fallback reviewer both receive full history without qualification', async () => {
  const evidence = await fixture('fallback')
  const luna = evidence.classifierBodies.filter((request: any) => request.model === 'gpt-6-luna')
  const sonnet = evidence.classifierBodies.filter((request: any) => request.model.includes('sonnet'))
  expect(luna.length).toBeGreaterThan(0)
  expect(sonnet.length).toBeGreaterThan(0)
  for (const request of luna) expect(JSON.stringify(request.messages)).toContain('NOISE_HISTORY_MARKER')
  for (const request of sonnet) expect(JSON.stringify(request.messages).includes('NOISE_HISTORY_MARKER')).toBe(true)
  expect(evidence.mainHistoryRetainsNoise).toBe(true)
  expect(evidence.permissions).toEqual([])
  expect(evidence.content).toBe('REPORT_READY')
}, 60_000)

test('an opaque engine local-command record retains earlier inputs without projecting its output', async () => {
  const evidence = await fixture('local-command')
  expect(evidence.noiseContent).toContain('NOISE_HISTORY_MARKER')
  expect(evidence.ordinaryDroppedCalls).toBeGreaterThan(0)
  expect(evidence.opaqueDroppedCalls).toBe(0)
  expect(evidence.reviewMatchesFull).toBe(true)
  expect(evidence.reviewHasNoise).toBe(true)
  expect(evidence.reviewHasRawOutput).toBe(false)
  expect(evidence.mainHasRawOutput).toBe(true)
}, 60_000)
