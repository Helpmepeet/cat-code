import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Scenario = 'script' | 'script-specialists' | 'reentry' | 'specialists' | 'restricted' | 'deferred' | 'cached'
type Message = { content?: string | { text?: string }[] }

async function capture(scenario: Scenario): Promise<{
  request: {
    tools: { name: string; description: string }[]
    messages?: Message[]
    input?: Message[]
  }
  planPath: string
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'plan-mode-reminder-')))
  try {
    await mkdir(join(root, 'config'))
    await mkdir(join(root, 'workspace'))
    const claude = scenario === 'specialists' || scenario === 'restricted' || scenario === 'cached'
    const child = Bun.spawn([
      process.execPath,
      '--feature=CODE_MODE',
      ...(claude || scenario === 'script-specialists' ? ['--feature=BUILTIN_EXPLORE_PLAN_AGENTS'] : []),
      new URL('./planModeReminder.fixture.ts', import.meta.url).pathname,
    ], {
      cwd: join(root, 'workspace'), stdout: 'pipe', stderr: 'pipe',
      env: {
        PATH: process.env.PATH, HOME: root, TMPDIR: root,
        CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
        CLAUDE_CODE_USE_OPENAI: claude ? '0' : '1',
        ANTHROPIC_API_KEY: 'fixture-not-a-credential',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
        ENABLE_TOOL_SEARCH: scenario === 'deferred' ? 'true' : 'false',
        CLAUDE_CODE_PLAN_MODE_INTERVIEW_PHASE: '0',
        CLAUDE_CODE_AGENT_LIST_IN_MESSAGES: 'false',
        PLAN_MODE_TEST_ROOT: root, PLAN_MODE_TEST_SCENARIO: scenario,
      },
    })
    const timeout = setTimeout(() => child.kill(), 15_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`Plan fixture (${scenario}) failed (${code}): ${stderr}\n${stdout}`)
      return JSON.parse(stdout)
    } finally {
      clearTimeout(timeout)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

for (const scenario of ['script', 'script-specialists', 'reentry', 'specialists', 'restricted', 'deferred', 'cached'] as const) {
  test(`Plan mode only refers to callable tools and specialists (${scenario})`, async () => {
    const { request, planPath } = await capture(scenario)
    const text = (request.messages ?? request.input ?? [])
      .flatMap(({ content }) => typeof content === 'string' ? content : content?.map(block => block.text ?? '') ?? [])
      .join('\n')
    const reminder = text.match(/Plan mode is active\.[\s\S]+?<\/system-reminder>/)?.[0] ?? ''
    const agent = request.tools.find(tool => tool.name === 'Agent')
    const names = request.tools.map(tool => tool.name)
    const scriptFirst = scenario === 'script' || scenario === 'script-specialists'
    expect(names.includes('Agent')).toBe(!scriptFirst)
    if (!scriptFirst) {
      expect(agent?.description.includes('- Explore:')).toBe(scenario === 'specialists')
      expect(agent?.description.includes('- Plan:')).toBe(
        scenario === 'specialists' || scenario === 'restricted' || scenario === 'cached',
      )
    }
    expect(reminder).toContain(planPath)
    expect(reminder).toContain('only file you are allowed to edit')
    if (scenario === 'deferred') {
      expect(names).not.toContain('ExitPlanMode')
      expect(names).toContain('ToolSearch')
      expect(reminder).not.toContain('ExitPlanMode')
      expect(reminder).toMatch(/ToolSearch[^\n]+plan approval/)
      return
    }
    expect(reminder).toContain('ExitPlanMode')
    expect(names).toContain('ExitPlanMode')

    if (scenario === 'script') {
      expect(names).not.toContain('Write')
      expect(names).toContain('REPL')
      expect(reminder).not.toMatch(/\b(?:Explore|Plan) (?:subagent|agent)/)
      expect(reminder).not.toContain('using the Write tool')
      expect(reminder).toContain('REPL')
    } else if (scenario === 'script-specialists') {
      expect(reminder).toContain('Explore agents through REPL')
      expect(reminder).toContain('Launch Plan agent(s) through REPL')
    } else if (scenario === 'reentry') {
      expect(text).toContain('Re-entering Plan Mode')
      expect(names).toContain('apply_patch')
      expect(names).not.toContain('Edit')
      expect(reminder).not.toContain('using the Edit tool')
      expect(reminder).toContain('apply_patch')
    } else if (scenario === 'specialists') {
      expect(reminder).toContain('Explore subagent type')
      expect(reminder).toContain('Launch Plan agent')
      expect(reminder).not.toContain('through REPL')
    } else {
      expect(names).not.toContain('AskUserQuestion')
      expect(reminder).not.toContain('AskUserQuestion')
      expect(reminder).not.toMatch(/\bExplore (?:subagent|agent)/)
      expect(reminder).toContain('Launch Plan agent')
    }
  }, 20_000)
}
