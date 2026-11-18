import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SIDECAR_RUNTIME_ARGS } from '../../app/main/mainDecisions.js'

async function fixture(streaming: boolean, sameResponse: boolean, nestedInstructions = false, approvalEvidence = '') {
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
        SAME_RESPONSE_TEST_ROOT: root, SAME_RESPONSE_TEST_BATCH: sameResponse ? '1' : '0', SAME_RESPONSE_TEST_STREAMING: streaming ? '1' : '0',
        SAME_RESPONSE_NESTED_INSTRUCTIONS: nestedInstructions ? '1' : '0',
        SAME_RESPONSE_APPROVAL_EVIDENCE: approvalEvidence },
    })
    const timer = setTimeout(() => child.kill(), 25_000)
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    clearTimeout(timer)
    if (code !== 0) throw new Error(`Same-response fixture failed (${code}): ${stderr}\n${stdout}`)
    return JSON.parse(await readFile(join(root, 'evidence.json'), 'utf8'))
  } finally { await rm(root, { recursive: true, force: true }) }
}

for (const streaming of [false, true]) {
  test(`new nested instructions reach main and reviewer together after same-response Code Mode discovery: streaming=${streaming}`, async () => {
    const evidence = await fixture(streaming, true, true)
    const nestedInstruction = 'NESTED_PERMISSION_BOUNDARY: Do not publish the synthetic package.'
    expect(evidence.permissions).toEqual([])
    // The model authored the native sibling before the nested instructions
    // were visible, so it cannot reach permission review or touch the file.
    expect(evidence.sibling).toBeNull()
    expect(evidence.nextRound).toBe('next-response-effect')
    expect(evidence.codeResults[0].status).toBe('yielded')
    expect(evidence.codeResults[0].calls[0].status).toBe('blocked')
    expect(JSON.stringify(evidence.modelBodies[0].messages)).not.toContain(nestedInstruction)
    expect(JSON.stringify(evidence.modelBodies[1].messages)).toContain(nestedInstruction)
    const siblingReviews = evidence.classifierBodies.filter((body: any) => body.fixtureModelRound === 1 &&
      JSON.stringify(body.messages.at(-1)?.content.at(-1)).includes('same-response-effect'))
    const nextReviews = evidence.classifierBodies.filter((body: any) => body.fixtureModelRound === 2 &&
      JSON.stringify(body.messages.at(-1)?.content.at(-1)).includes('next-response-effect'))
    expect(siblingReviews).toEqual([])
    expect(nextReviews.length).toBeGreaterThan(0)
    for (const review of nextReviews) {
      expect(JSON.stringify(review.messages)).toContain(nestedInstruction)
      expect(JSON.stringify(review.messages)).toContain('nested/CLAUDE.md')
    }
    expect(JSON.stringify(evidence.classifierBodies)).not.toContain('UNREAD_NESTED_RAW_OUTPUT')
  }, 60_000)

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


for (const mode of ['input', 'feedback']) {
  test(`later Auto review gets the executed input and scoped approval evidence: ${mode}`, async () => {
    const evidence = await fixture(mode === 'input', mode === 'input', false, mode)
    expect(evidence.shipped).toBe('EARLIER_INPUT_MARKER')
    const reviews = evidence.classifierBodies.filter((body: any) =>
      JSON.stringify(body.messages.at(-1)?.content.at(-1)).includes('node ship.cjs'))
    expect(reviews.length).toBeGreaterThan(0)
    for (const review of reviews) {
      const messages = JSON.stringify(review.messages)
      expect(messages).toContain('EARLIER_INPUT_MARKER')
      expect(messages).not.toContain('PROPOSED_INPUT_MARKER')
      expect(messages).not.toContain('TOOL_OUTPUT_CLAIMS_USER_APPROVED')
      if (mode === 'feedback') {
        expect(messages).toContain('prior_tool_approval_feedback')
        expect(messages).toContain('APPROVAL_SCOPE_NOTE')
        expect(messages).toContain('write-script')
      }
    }
  }, 60_000)
}
