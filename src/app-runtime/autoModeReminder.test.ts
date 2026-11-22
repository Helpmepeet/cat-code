import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type ProviderRequest = {
  tools: { name: string }[]
  messages?: RequestMessage[]
  input?: RequestMessage[]
}

type RequestMessage = { role?: string; content: string | { text?: string }[] }

function requestText(request: ProviderRequest) {
  return (request.messages ?? request.input ?? []).map(({ content }) => typeof content === 'string'
    ? content
    : content?.map(block => block.text ?? '').join('\n')).join('\n')
}

const cases = [
  ['claude', 'direct'], ['claude', 'script'], ['gpt', 'direct'], ['gpt', 'script'],
] as const

for (const [provider, surface] of cases) {
  test(`Auto requests carry contextual approval guidance and describe declared editing tools (${provider}, ${surface})`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'auto-reminder-')))
    try {
      await Promise.all([mkdir(join(root, 'config')), mkdir(join(root, 'workspace'))])
      const child = Bun.spawn([
        process.execPath, '--feature=CODE_MODE', '--feature=TRANSCRIPT_CLASSIFIER',
        new URL('./autoModeReminder.fixture.ts', import.meta.url).pathname, surface,
      ], {
        cwd: join(root, 'workspace'), stdout: 'pipe', stderr: 'pipe',
        env: {
          PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin', HOME: root, TMPDIR: root,
          CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
          ANTHROPIC_BASE_URL: 'https://auto-reminder.invalid', ANTHROPIC_API_KEY: 'isolated-fixture-not-a-credential',
          CLAUDE_CODE_USE_OPENAI: provider === 'gpt' ? '1' : '0',
          ANTHROPIC_MODEL: provider === 'gpt' ? 'gpt-6.2-astra' : 'claude-sonnet-4-5',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
          ENABLE_TOOL_SEARCH: 'false',
        },
      })
      const timer = setTimeout(() => child.kill(), 15_000)
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]).finally(() => clearTimeout(timer))
      if (code !== 0) throw new Error(`Auto reminder fixture exited with ${code}\n${stderr}`)

      const [first, later] = JSON.parse(stdout) as [ProviderRequest, ProviderRequest]
      const full = requestText(first).match(/## Auto Mode Active[\s\S]+?<\/system-reminder>/)?.[0] ?? ''
      const sparse = requestText(later).match(/Auto mode still active[^<]+/)?.[0] ?? ''
      const policy = /judge pushes and cleanup by their scope and effects\.[^.]+authorized by the user or loaded instructions[^.]+permission checks\.[^.]+authorization is unclear[^.]+required approval/i
      if (provider === 'gpt') {
        const actions = requestText({ ...first, input: first.input?.filter(message => message.role === 'developer') })
          .match(/# Acting and Asking\n[\s\S]+?(?=\n# )/)?.[0] ?? ''
        expect(actions).not.toMatch(/confirm first unless/i)
        expect(actions).toMatch(policy)
      }
      expect(full).not.toMatch(/the user chose|anything that deletes data or modifies shared/i)
      expect(full).toMatch(policy)
      expect(full).toContain('Expect course corrections')
      expect(full).toContain('Do not take overly destructive actions')
      expect(full).toContain('Avoid data exfiltration')
      expect(full).toContain('For authorized file modifications in Auto Mode')
      expect(full).toContain('may incur additional security-review latency')
      expect(sparse).toContain('For authorized file modifications, prefer available native editing tools')
      expect(full).not.toMatch(/Execute immediately|Minimize interruptions|Prefer action over planning|When in doubt, start coding/i)
      expect(sparse).not.toMatch(/minimize interruptions|prefer action over planning/i)
      const declared = first.tools.map(tool => tool.name)
      for (const name of ['Edit', 'apply_patch', 'Write', 'Bash']) {
        const expected = surface === 'direct' && name !== (provider === 'gpt' ? 'Edit' : 'apply_patch')
        expect(declared.includes(name)).toBe(expected)
        expect(new RegExp(`\\b${name}\\b`).test(full)).toBe(declared.includes(name))
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)
}
