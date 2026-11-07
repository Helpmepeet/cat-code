import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PermissionDecision } from '../utils/permissions/PermissionResult.js'
import type { AppPermissionRequest } from './sessionEvents.js'
import { SIDECAR_RUNTIME_ARGS } from '../../app/main/mainDecisions.js'

type ScenarioResult = {
  name: string
  toolDecision: PermissionDecision
  ruleDecision: PermissionDecision | null
  decision: PermissionDecision
  requests: AppPermissionRequest[]
  classifierRequests: number
}

async function runFixture(runtimeArgs: readonly string[]): Promise<ScenarioResult[]> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'app-permission-safety-')))
  try {
    await mkdir(join(root, 'config'))
    await mkdir(join(root, 'workspace'))
    const child = Bun.spawn([
      process.execPath, ...runtimeArgs,
      new URL('./appRuntimePermissionSafety.fixture.ts', import.meta.url).pathname,
    ], {
      cwd: join(root, 'workspace'), stdout: 'pipe', stderr: 'pipe',
      env: {
        PATH: process.env.PATH, HOME: root, TMPDIR: root,
        CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
        ANTHROPIC_API_KEY: 'isolated-fixture-not-a-credential',
        CLAUDE_CODE_USE_OPENAI: '0', CLAUDE_CODE_AUTO_MODE_MODEL: 'claude-sonnet-4-5',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
        PERMISSION_SAFETY_TEST_ROOT: root,
      },
    })
    const timer = setTimeout(() => child.kill(), 25_000)
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    clearTimeout(timer)
    if (code !== 0) throw new Error(`Permission safety fixture failed (${code}): ${stderr}\n${stdout}`)
    return JSON.parse(stdout)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

for (const [name, runtimeArgs] of [
  ['classifier', ['--feature=TRANSCRIPT_CLASSIFIER']],
  ['desktop', SIDECAR_RUNTIME_ARGS],
] as const) {
  test(`${name}: tool-wide asks preserve mandatory safety approval through the real app permission path`, async () => {
    const results = await runFixture(runtimeArgs)
    const result = (name: string) => {
      const found = results.find(item => item.name === name)
      if (!found) throw new Error(`Missing scenario: ${name}`)
      return found
    }
    const manual = result('manual safety')
    expect(manual.toolDecision).toMatchObject({
      behavior: 'ask',
      decisionReason: { type: 'safetyCheck', classifierApprovable: false },
    })
    if (manual.toolDecision.behavior !== 'ask') throw new Error('Expected a safety ask')
    expect(manual.classifierRequests).toBe(0)
    expect(manual.requests).toHaveLength(1)
    expect(manual.ruleDecision).toEqual(manual.toolDecision)
    expect(manual.requests[0]?.request).toMatchObject({
      tool_name: 'Write', decision_reason: manual.toolDecision.message,
      input: { file_path: expect.stringContaining('GIT~1/config'), content: 'fixture content' },
    })
    expect(manual.decision.behavior).toBe('deny')

    const headless = result('headless safety')
    expect(headless.ruleDecision).toEqual(headless.toolDecision)
    expect(headless.classifierRequests).toBe(0)
    expect(headless.requests).toHaveLength(0)
    expect(headless.decision).toMatchObject({ behavior: 'deny', decisionReason: { type: 'asyncAgent' } })

    const approvable = result('classifier safety')
    expect(approvable.toolDecision).toMatchObject({
      behavior: 'ask', decisionReason: { type: 'safetyCheck', classifierApprovable: true },
    })
    for (const item of [approvable, result('ordinary ask')]) {
      expect(item.ruleDecision).toMatchObject({ behavior: 'ask', decisionReason: { type: 'rule' } })
      expect(item.classifierRequests).toBeGreaterThan(0)
      expect(item.requests).toHaveLength(0)
      expect(item.decision.behavior).toBe('allow')
    }

    for (const item of [result('content deny'), result('tool deny')]) {
      expect(item.ruleDecision).toMatchObject({ behavior: 'deny', decisionReason: { type: 'rule' } })
      expect(item.decision).toMatchObject({ behavior: 'deny', decisionReason: { type: 'rule' } })
      expect(item.classifierRequests).toBe(0)
      expect(item.requests).toHaveLength(0)
    }
  }, 30_000)
}
