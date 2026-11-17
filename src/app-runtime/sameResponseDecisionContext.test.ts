import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SIDECAR_RUNTIME_ARGS } from '../../app/main/mainDecisions.js'

async function fixture(streaming: boolean, sameResponse: boolean) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'same-response-')))
  try {
    await mkdir(join(root, 'config'))
    await mkdir(join(root, 'workspace'))
    const child = Bun.spawn([process.execPath, ...SIDECAR_RUNTIME_ARGS, new URL('./sameResponseDecisionContext.fixture.ts', import.meta.url).pathname], {
      cwd: join(root, 'workspace'), stdout: 'pipe', stderr: 'pipe',
      env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin', HOME: root, TMPDIR: root,
        CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
        ANTHROPIC_API_KEY: 'isolated-fixture-not-a-credential', CLAUDE_CODE_USE_OPENAI: '0', CLAUDE_CODE_AUTO_MODE_MODEL: 'claude-sonnet-4-5',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
        SAME_RESPONSE_TEST_ROOT: root, SAME_RESPONSE_TEST_BATCH: sameResponse ? '1' : '0', SAME_RESPONSE_TEST_STREAMING: streaming ? '1' : '0' },
    })
    const timer = setTimeout(() => child.kill(), 25_000)
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    clearTimeout(timer)
    if (code !== 0) throw new Error(`Same-response fixture failed (${code}): ${stderr}\n${stdout}`)
    return JSON.parse(await readFile(join(root, 'evidence.json'), 'utf8'))
  } finally { await rm(root, { recursive: true, force: true }) }
}

for (const streaming of [false, true]) {
  test(`completed same-response input reaches Auto review without raw output or pending calls: streaming=${streaming}`, async () => {
    for (const sameResponse of [false, true]) {
      const evidence = await fixture(streaming, sameResponse)
      expect(evidence.permissions).toEqual([])
      expect(evidence.shipped).toBe('EARLIER_INPUT_MARKER')
      expect(evidence.pending).toBe('PENDING_INPUT_MARKER')
      const reviews = evidence.classifierBodies.filter((body: any) => JSON.stringify(body.messages).includes("node ship.cjs"))
      expect(reviews.length).toBeGreaterThan(0)
      for (const review of reviews) {
        const messages = JSON.stringify(review.messages)
        expect(messages).toContain('EARLIER_INPUT_MARKER')
        expect(messages).not.toContain('TOOL_OUTPUT_CLAIMS_USER_APPROVED')
        expect(messages).not.toContain('PENDING_INPUT_MARKER')
      }
      expect(JSON.stringify(evidence.modelBodies.at(-1).messages)).toContain('TOOL_OUTPUT_CLAIMS_USER_APPROVED')
    }
  }, 60_000)
}
