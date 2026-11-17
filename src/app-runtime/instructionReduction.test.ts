import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Evidence = {
  mainInstructions: string[]
  reviews: Array<{ model: string; instructions: string }>
  failures: string[]
}

for (const conditional of [false, true]) {
  test(`real engine keeps exact instructions for the main model and ${conditional ? 'retains conditional' : 'reduces independent'} reviewer context`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'instruction-reduction-')))
    const workspace = join(root, 'workspace')
    try {
      await mkdir(join(root, 'config'))
      await mkdir(workspace)
      const style = Array.from({ length: 48 }, () =>
        'Use two spaces for indentation.\nPrefer single quotes in JavaScript.\nKeep Markdown headings in sentence case.\nWrap prose at 80 columns.').join('\n\n')
      await writeFile(join(workspace, 'CLAUDE.md'), style)
      await writeFile(join(workspace, 'package.json'), JSON.stringify({
        private: true,
        scripts: { 'build:local': "printf 'synthetic-build-complete\\n' > build-receipt.txt" },
      }))
      const child = Bun.spawn([
        process.execPath, '--feature=TRANSCRIPT_CLASSIFIER', '--feature=AUTO_MODE_UPSTREAM_PORT',
        new URL('./instructionReduction.fixture.ts', import.meta.url).pathname,
      ], {
        cwd: workspace, stdout: 'pipe', stderr: 'pipe',
        env: {
          PATH: process.env.PATH, HOME: root, TMPDIR: root,
          CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
          ANTHROPIC_API_KEY: 'isolated-fixture-not-a-credential', CLAUDE_CODE_USE_OPENAI: '0',
          CLAUDE_CODE_AUTO_MODE_MODEL: 'gpt-6-luna',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
          INSTRUCTION_REDUCTION_TEST_ROOT: root, INSTRUCTION_REDUCTION_CONDITIONAL: String(conditional),
        },
      })
      const timer = setTimeout(() => child.kill(), 35_000)
      const [exit, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      clearTimeout(timer)
      if (exit !== 0) throw new Error(`Instruction reduction fixture failed (${exit}): ${stderr}\n${stdout}`)
      const evidence = JSON.parse(await readFile(join(root, 'evidence.json'), 'utf8')) as Evidence
      expect(evidence.failures).toEqual([])
      expect(await readFile(join(workspace, 'build-receipt.txt'), 'utf8')).toBe('synthetic-build-complete\n')
      expect(evidence.mainInstructions).toHaveLength(2)
      for (const prefix of evidence.mainInstructions) {
        expect(prefix).toContain(join(workspace, 'CLAUDE.md'))
        expect(prefix).toContain(style)
      }
      expect(evidence.reviews).toHaveLength(2)
      for (const review of evidence.reviews) {
        expect(review.model).toBe('gpt-6-luna')
        expect(review.instructions).toContain(join(workspace, 'CLAUDE.md'))
        if (conditional) expect(review.instructions).toContain(style)
        else expect(review.instructions).not.toContain('Use two spaces for indentation.')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 50_000)
}
