import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const scenario of ['admit', 'deny', 'ask', 'wrapper', 'budget', 'budget-wrapper']) {
  test(`real-engine Auto Code Mode ${scenario}: one script admission retains final-input policy`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'code-mode-auto-')))
    try {
      await mkdir(join(root, 'config'))
      await mkdir(join(root, 'workspace'))
      const child = Bun.spawn([process.execPath, '--feature=CODE_MODE', '--feature=TRANSCRIPT_CLASSIFIER', '--feature=AUTO_MODE_UPSTREAM_PORT', new URL('./codeModeAuto.fixture.ts', import.meta.url).pathname], {
        cwd: join(root, 'workspace'), stdout: 'pipe', stderr: 'pipe',
        env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin', HOME: root, TMPDIR: root,
          CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
          ANTHROPIC_API_KEY: 'isolated-fixture-not-a-credential', CLAUDE_CODE_USE_OPENAI: '0',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
          NODE_ENV: 'test', CLAUDE_CODE_AUTO_MODE_MODEL: 'sonnet', CODE_MODE_TEST_ROOT: root, CODE_MODE_AUTO_SCENARIO: scenario },
      })
      const timer = setTimeout(() => child.kill(), 30_000)
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      clearTimeout(timer)
      if (exit !== 0) throw new Error(`Auto fixture failed (${exit}): ${stderr}\n${stdout}`)
      const evidence = JSON.parse(await readFile(join(root, 'evidence.json'), 'utf8'))
      const results = evidence.transcript.filter((message: any) => message.toolUseResult?.kind === 'code-mode').map((message: any) => message.toolUseResult)
      if (scenario.startsWith('budget')) {
        const effect = await readFile(join(root, 'workspace', 'budget.txt'), 'utf8').catch(() => null)
        // A review-size guard may reject before REPL.call, so no host result is
        // required. It must be a truthful normal error receipt, with no dispatch.
        if (results.length === 0) {
          expect(effect).toBeNull()
          expect(evidence.transcript.filter((message: any) => message.codeMode)).toEqual([])
          const receipt = evidence.transcript.flatMap((message: any) => message.type === 'user' && Array.isArray(message.message.content) ? message.message.content : [])
            .find((block: any) => block.type === 'tool_result' && block.tool_use_id === 'submitted-script')
          expect(receipt?.is_error).toBe(true)
          expect(String(receipt?.content)).toMatch(/(?:review|admission|classif|auto).*(?:budget|limit|size|large|long)|(?:budget|limit|size|large|long).*(?:review|admission|classif|auto)/i)
        } else {
          expect(results).toHaveLength(1)
          expect(results[0].status).toBe('completed')
          expect(effect).toBe('complete-source-executed')
          expect(results[0].output).toContain('budget-selected-output')
          expect(results[0].calls).toHaveLength(1)
          expect(evidence.classifierBodies.length).toBeGreaterThan(0)
          expect([...new Set(evidence.reviews.map((review: any) => review.toolUseId))]).toEqual(['submitted-script'])
        }
        // Regardless of execution/rejection, no actual request may silently
        // truncate the pending source while presenting it as the current action.
        for (const body of evidence.classifierBodies) {
          const action = body.messages.at(-1).content.at(-1).text
          const expected = `<pending_action>\nREPL ${evidence.code}\n</pending_action>\n`
          if (action !== expected) throw new Error(`Incomplete final-source Auto review (${scenario}): action length ${action.length}, expected ${expected.length}; middle=${action.includes(':distinct-middle:')}, suffix=${action.includes(':distinct-suffix*/')}; executed=${effect !== null}`)
        }
        return
      }
      expect(results).toHaveLength(1)
      if (!evidence.classifierBodies.length) throw new Error(`Expected script Auto admission; observed zero classifier requests, wrapper status=${results[0].status}, child statuses=${results[0].calls.map((call: any) => call.status).join(',')}`)
      // Request fast-stage escalation so the real thinking-stage review lifecycle
      // is observable. HTTP attempts are not logical permission occurrences.
      expect([...new Set(evidence.reviews.map((review: any) => review.toolUseId))]).toEqual(['submitted-script'])
      expect(evidence.reviews.some((review: any) => review.toolUseId === 'submitted-script' && review.outcome === 'reviewing')).toBe(true)
      expect(evidence.reviews.some((review: any) => review.toolUseId === 'submitted-script' && review.outcome === 'allowed')).toBe(true)
      for (const body of evidence.classifierBodies) {
        // The final block identifies the prospective action separately from
        // history. Verify its entire source inside the engine envelope.
        const blocks = body.messages.at(-1).content
        const action = blocks.at(-1).text
        const projectedCode = /[\r\n\v\f\u0085\u2028\u2029<]/.test(evidence.code)
          ? JSON.stringify(evidence.code).replaceAll('<', '\\u003c').replaceAll('\u0085', '\\u0085').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')
          : evidence.code
        expect(action).toBe(`<pending_action>\nREPL ${projectedCode}\n</pending_action>\n`)
      }
      const children = evidence.transcript.filter((message: any) => message.type === 'assistant' && message.codeMode)
      const reviewedIdentities = new Set(children.flatMap((message: any) => message.message.content.filter((block: any) => block.type === 'tool_use').map((block: any) => block.id)).filter((id: string) => evidence.reviews.some((review: any) => review.toolUseId === id)))
      expect([...reviewedIdentities]).toEqual([])
      if (scenario === 'admit' || scenario === 'wrapper') {
        expect(results[0].status).toBe('completed')
        expect(results[0].output).toContain('onetwothree')
        expect(results[0].calls).toHaveLength(5)
        expect(await readFile(join(root, 'workspace', 'third.txt'), 'utf8')).toBe('onetwothree')
        expect(await readFile(join(root, 'workspace', 'written.txt'), 'utf8')).toBe('actual-write')
        if (scenario === 'wrapper') expect(results[0].output).not.toContain('unmodified-source')
      } else {
        for (const path of ['original.txt', 'forbidden.txt', 'later.txt']) expect(await readFile(join(root, 'workspace', path), 'utf8').catch(() => null)).toBeNull()
        expect(results[0].status).not.toBe('completed')
        expect(results[0].calls.some((call: any) => ['denied', 'failed', 'blocked'].includes(call.status))).toBe(true)
        const audit = evidence.transcript.filter((message: any) => message.codeMode && message.type === 'user')
        const refusedCall = results[0].calls.find((call: any) => ['denied', 'failed', 'blocked'].includes(call.status))
        expect(audit.some((message: any) => message.message.content.some((block: any) => block.type === 'tool_result' && block.is_error && block.tool_use_id === refusedCall.toolUseId))).toBe(true)
        const sourceIndex = evidence.transcript.findIndex((message: any) => message.type === 'assistant' && message.message.content.some((block: any) => block.type === 'tool_use' && block.id === refusedCall.toolUseId))
        const source = evidence.transcript[sourceIndex]
        const refusalIndex = evidence.transcript.findIndex((message: any) => message.permissionDecision?.toolUseId === refusedCall.toolUseId)
        const refusal = evidence.transcript[refusalIndex]
        const outerResultIndex = evidence.transcript.findIndex((message: any) => message.toolUseResult?.kind === 'code-mode')
        expect(sourceIndex).toBeGreaterThan(-1)
        expect(refusalIndex).toBeGreaterThan(sourceIndex)
        expect(outerResultIndex).toBeGreaterThan(refusalIndex)
        expect(refusal.sourceToolAssistantUUID).toBe(source.uuid)
        // The audit call preserves submitted input. Native refusal metadata
        // snapshots processedInput: the final hook-modified executable action.
        expect(source.message.content.find((block: any) => block.type === 'tool_use' && block.id === refusedCall.toolUseId).input.command).toBe("bash -c 'printf original > original.txt'")
        for (const authenticated of evidence.authentication) {
          expect(authenticated.records).toHaveLength(1)
          expect(authenticated.records[0]).toMatchObject({
            toolUseId: refusedCall.toolUseId, assistantUuid: source.uuid, toolName: 'Bash',
            input: { command: "bash -c 'printf forbidden > forbidden.txt'" },
            outcome: scenario === 'ask' ? 'rejected-by-user' : 'blocked-by-permissions',
          })
          expect(authenticated.positioned).toHaveLength(1)
          expect(authenticated.positioned[0].ownerUuid).toBe(refusal.uuid)
          expect(authenticated.positioned[0].records).toEqual(authenticated.records)
          expect(authenticated.normalizedChildren).toEqual([])
          expect(JSON.stringify(authenticated.normalized)).not.toContain(refusedCall.toolUseId)
          expect(JSON.stringify(authenticated.normalized)).not.toContain('permissionDecision')
        }
        expect(evidence.authentication[1].records).toEqual(evidence.authentication[0].records)
        if (scenario === 'ask') {
          expect(evidence.permissions).toHaveLength(1)
          expect(evidence.permissions[0].request.tool_use_id).toBe(refusedCall.toolUseId)
          expect(evidence.permissions[0].request.input.command).toBe("bash -c 'printf forbidden > forbidden.txt'")
        } else expect(evidence.permissions).toEqual([])
        const nextModel = JSON.stringify(evidence.modelBodies[1])
        expect(nextModel).not.toContain(refusedCall.toolUseId)
        expect(nextModel).toContain('Code Mode')
        expect(nextModel).toMatch(/refus|denied|blocked|yielded/i)
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 35_000)
}
