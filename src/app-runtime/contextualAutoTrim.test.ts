import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONTEXTUAL_REVIEW_MAX_BYTES, type ContextualEvidence } from '../utils/permissions/contextualReviewPrompt.js'

for (const [restriction, name] of [
  ['none', 'an over-budget Script review drops unrelated correspondence and still covers the cell'],
  ['operator', 'a linked withdrawal survives an over-budget Script review'],
  ['teammate', 'a teammate restriction survives an over-budget Script review'],
] as const) {
  test(name, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cat-contextual-auto-trim-')))
    try {
      const cwd = join(root, 'workspace')
      await mkdir(cwd)
      const fixture = new URL('./contextualAutoTrim.fixture.ts', import.meta.url).pathname
      const child = Bun.spawn([process.execPath, '--feature=CODE_MODE', '--feature=TRANSCRIPT_CLASSIFIER',
        '--feature=AUTO_MODE_UPSTREAM_PORT', '--feature=AUTO_MODE_CONTEXTUAL_REVIEW', fixture], {
        cwd, stdout: 'pipe', stderr: 'pipe',
        env: {
          PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin', HOME: root, TMPDIR: root,
          CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
          ANTHROPIC_API_KEY: 'isolated-fixture', CLAUDE_CODE_USE_OPENAI: '0',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
          NODE_ENV: 'test', CLAUDE_CODE_AUTO_MODE_MODEL: 'claude-sonnet-5-5',
          CONTEXTUAL_TRIM_ROOT: root, CONTEXTUAL_TRIM_RESTRICTION: restriction,
        },
      })
      const timeout = setTimeout(() => child.kill(), 25_000)
      const [exit, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      clearTimeout(timeout)
      if (exit !== 0) throw new Error(`Trim fixture exited ${exit}\n${error}\n${output}`)
      const result = JSON.parse(output) as {
        reviews: { bytes: number; omittedCorrespondence: boolean; wholeScript: boolean; evidence: ContextualEvidence }[]
        effects: string | null; prompts: number; script: string; grant: string; withdrawal: string; teammateHold: string
      }
      expect(result.reviews).toHaveLength(1)
      expect(result.prompts).toBe(0)
      expect(result.effects).toBe(restriction === 'none' ? 'firstsecond' : null)

      const { bytes, evidence, omittedCorrespondence, wholeScript } = result.reviews[0]!
      expect(bytes).toBeLessThanOrEqual(CONTEXTUAL_REVIEW_MAX_BYTES)
      expect(omittedCorrespondence).toBe(true)
      expect(wholeScript).toBe(true)
      expect(evidence.conversation).toContainEqual(expect.objectContaining({ text: expect.stringMatching(/entries were omitted/i) }))
      expect(evidence.action).toMatchObject({ tool: 'Bash', cwd,
        input: { command: 'printf first >> effects.txt' }, script: { source: expect.stringContaining(result.script) },
      })
      expect(evidence.conversation.filter(row => row.text === 'Yes, do that.').map(row => row.proposal?.text))
        .toEqual(restriction === 'operator' ? [result.grant, result.withdrawal] : [result.grant])
      if (restriction === 'teammate') {
        expect(evidence.conversation).toContainEqual(expect.objectContaining({ origin: 'peer', text: result.teammateHold }))
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
}
