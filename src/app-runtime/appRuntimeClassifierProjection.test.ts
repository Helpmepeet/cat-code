import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PermissionDecision } from '../utils/permissions/PermissionResult.js'
import { SIDECAR_RUNTIME_ARGS } from '../../app/main/mainDecisions.js'

type ScenarioResult = { name: string; decision: PermissionDecision; bodies: string[] }

async function runFixture(runtimeArgs: readonly string[]): Promise<ScenarioResult[]> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'app-classifier-projection-')))
  try {
    await mkdir(join(root, 'config'))
    await mkdir(join(root, 'workspace'))
    const child = Bun.spawn([
      process.execPath, ...runtimeArgs,
      new URL('./appRuntimeClassifierProjection.fixture.ts', import.meta.url).pathname,
    ], {
      cwd: join(root, 'workspace'), stdout: 'pipe', stderr: 'pipe',
      env: {
        PATH: process.env.PATH, HOME: root, TMPDIR: root,
        CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
        ANTHROPIC_API_KEY: 'isolated-fixture-not-a-credential',
        CLAUDE_CODE_USE_OPENAI: '0', CLAUDE_CODE_AUTO_MODE_MODEL: 'claude-sonnet-4-5',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
        CLASSIFIER_PROJECTION_TEST_ROOT: root,
      },
    })
    const timer = setTimeout(() => child.kill(), 25_000)
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    clearTimeout(timer)
    if (code !== 0) throw new Error(`Classifier projection fixture failed (${code}): ${stderr}\n${stdout}`)
    return JSON.parse(stdout)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

for (const [name, runtimeArgs] of [
  ['classifier', ['--feature=TRANSCRIPT_CLASSIFIER']],
  ['desktop', SIDECAR_RUNTIME_ARGS],
] as const) {
  test(`${name}: the classifier judges what checkPermissions resolved for this call`, async () => {
    const results = await runFixture(runtimeArgs)
    const result = (scenario: string) => {
      const found = results.find(item => item.name === scenario)
      if (!found) throw new Error(`Missing scenario: ${scenario}`)
      return found
    }

    for (const [scenario, label, other] of [
      ['first resolved', 'click button Delete project', 'click button Save draft'],
      ['same input, second call', 'click button Save draft', 'click button Delete project'],
    ] as const) {
      const { bodies, decision } = result(scenario)
      // A block escalates to the second stage, so every request is checked.
      expect(bodies.length).toBeGreaterThan(0)
      for (const body of bodies) {
        expect(body).toContain(label)
        expect(body).not.toContain(other)
        expect(body).not.toContain('opaque e12')
      }
      expect(decision.behavior).not.toBe('allow')
    }

    // A tool cannot skip the classifier through this hook: an empty or
    // failing projection falls back to the tool's ordinary projection.
    for (const scenario of ['empty projection', 'throwing projection']) {
      const { bodies, decision } = result(scenario)
      expect(bodies.length).toBeGreaterThan(0)
      for (const body of bodies) expect(body).toContain('opaque e12')
      expect(decision.behavior).not.toBe('allow')
    }
  }, 60_000)
}
