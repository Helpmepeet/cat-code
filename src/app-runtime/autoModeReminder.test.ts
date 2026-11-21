import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type ProviderRequest = {
  tools: { name: string }[]
  messages: { content: string | { text?: string }[] }[]
}

function requestText(request: ProviderRequest) {
  return request.messages.map(({ content }) => typeof content === 'string'
    ? content
    : content.map(block => block.text ?? '').join('\n')).join('\n')
}

for (const surface of ['direct', 'script'] as const) {
  test(`Auto reminders preserve user scope and describe declared editing tools (${surface})`, async () => {
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
          CLAUDE_CODE_USE_OPENAI: '0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
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
      expect(full).toContain('Expect course corrections')
      expect(full).toContain('Do not take overly destructive actions')
      expect(full).toContain('Avoid data exfiltration')
      expect(full).toContain('For authorized file modifications in Auto Mode')
      expect(full).toContain('may incur additional security-review latency')
      expect(sparse).toContain('For authorized file modifications, prefer available native editing tools')
      expect(full).not.toMatch(/Execute immediately|Minimize interruptions|Prefer action over planning|When in doubt, start coding/i)
      expect(sparse).not.toMatch(/minimize interruptions|prefer action over planning/i)
      const declared = first.tools.map(tool => tool.name)
      for (const name of ['Edit', 'Write', 'Bash']) {
        expect(declared.includes(name)).toBe(surface === 'direct')
        expect(new RegExp(`\\b${name}\\b`).test(full)).toBe(declared.includes(name))
      }
      expect(full).not.toContain('apply_patch')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)
}
