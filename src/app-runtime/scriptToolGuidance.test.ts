import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type RequestEvidence = {
  tools: string[]
  scriptDescription: string
  scriptGuidance?: string
  prompt: string
  resumePrompt?: string
  directAgentResult?: unknown[]
}

for (const provider of ['claude', 'gpt'] as const) {
  test(`${provider} request describes the actual Script tool surface in fresh and reopened sessions`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'script-guidance-')))
    const workspace = join(root, 'workspace')
    const config = join(root, 'config')
    try {
      await Promise.all([mkdir(workspace), mkdir(config)])
      const evidence: Record<string, RequestEvidence> = {}
      for (const phase of ['fresh', 'reopened', 'legacy'] as const) {
        const child = Bun.spawn([
          process.execPath, '--feature=CODE_MODE',
          new URL('./scriptToolGuidance.fixture.ts', import.meta.url).pathname,
          phase,
        ], {
          cwd: workspace, stdout: 'pipe', stderr: 'pipe',
          env: {
            PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin',
            HOME: root, TMPDIR: root, CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: config,
            ANTHROPIC_API_KEY: 'synthetic-fixture-key', ANTHROPIC_BASE_URL: 'https://script-guidance.invalid',
            CLAUDE_CODE_USE_OPENAI: provider === 'gpt' ? '1' : '0',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
            ENABLE_TOOL_SEARCH: 'false',
          },
        })
        const timer = setTimeout(() => child.kill(), 12_000)
        const [code, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]).finally(() => clearTimeout(timer))
        if (code !== 0) throw new Error(`Script guidance fixture (${phase}) failed (${code}): ${stderr}\n${stdout}`)
        evidence[phase] = JSON.parse(stdout) as RequestEvidence
      }

      const directTools = ['Read', 'Bash', 'Edit', 'apply_patch']
      const legacyTools = ['Bash', provider === 'gpt' ? 'apply_patch' : 'Edit', 'Read'].sort()
      for (const phase of ['fresh', 'reopened', 'legacy'] as const) {
        expect(evidence[phase]!.tools).toContain('REPL')
        expect(evidence[phase]!.tools.filter(name => directTools.includes(name)).sort())
          .toEqual(phase === 'legacy' ? legacyTools : [])
      }
      expect(evidence.legacy!.tools).toContain('Agent')
      expect(evidence.legacy!.prompt).toContain("the Agent tool's available-agent list")
      expect(evidence.legacy!.resumePrompt).toContain('Use Agent to start a fresh subagent')
      expect(evidence.legacy!.scriptGuidance).toContain('direct coding tools remain available')
      const scriptPhases = ['fresh', 'reopened'] as const
      expect(scriptPhases.filter(phase => evidence[phase]!.scriptGuidance?.includes('direct coding tools remain available')))
        .toEqual([])
      for (const phase of scriptPhases) {
        expect(evidence[phase]!.scriptDescription.toLowerCase()).not.toContain('direct coding tools remain available')
        expect(evidence[phase]!.tools).not.toContain('Agent')
        expect(evidence[phase]!.prompt).toContain('Discover Agent through REPL')
        expect(evidence[phase]!.prompt).not.toContain("the Agent tool's available-agent list")
        expect(evidence[phase]!.resumePrompt).toContain('Use Agent through REPL to start a fresh subagent')
        expect(evidence[phase]!.scriptGuidance).toContain('Use REPL for file and shell operations.')
      }
      if (provider === 'claude') {
        const serializedResult = JSON.stringify(evidence.fresh!.directAgentResult)
        expect(serializedResult).toContain('Use Agent through REPL in this session.')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 40_000)
}
