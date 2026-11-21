import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixture = fileURLToPath(
  new URL('./agentCompactionTranscript.fixture.ts', import.meta.url),
)

for (const scope of ['worker', 'main', 'background'] as const) {
  for (const strategy of scope === 'background' ? ['prefix'] : ['full', 'prefix']) {
    test(`${scope} ${strategy} compaction directs recovery to the archive that contains its earlier Read`, async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'compact-archive-')))
      const workspace = join(root, 'workspace')
      const config = join(root, 'config')
      try {
        await Promise.all([mkdir(workspace), mkdir(config)])
        const child = Bun.spawn(
          [process.execPath, '--feature=REACTIVE_COMPACT', fixture, scope, strategy],
          {
            cwd: workspace,
            env: {
              PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin',
              HOME: root,
              TMPDIR: root,
              CLAUDE_CONFIG_DIR: config,
              XDG_CONFIG_HOME: config,
              ANTHROPIC_BASE_URL: 'https://compaction.invalid',
              ANTHROPIC_API_KEY: 'isolated-fixture-not-a-credential',
              BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
              DISABLE_TELEMETRY: '1',
            },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        )
        const timeout = setTimeout(() => child.kill(), 20_000)
        try {
          const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ])
          if (code !== 0) throw new Error(`Compaction fixture exited with ${code}\n${stderr}\n${stdout}`)
          const evidence = JSON.parse(stdout) as {
            recoveryPath?: string
            preservedRead: boolean
            transcript: string
            olderReadInArchive: boolean
            receiptUsage: Record<string, number>
            liveUsage?: { totalTokens: number }
            savedUsage?: { totalTokens: number }
          }
          expect(evidence.olderReadInArchive).toBe(true)
          expect(evidence.preservedRead).toBe(strategy === 'prefix')
          expect(evidence.recoveryPath).toBe(evidence.transcript)
          if (scope === 'worker') {
            // Read request(s), compaction summary request, and final response.
            const requests = strategy === 'prefix' ? 4 : 3
            expect(evidence.receiptUsage).toMatchObject({
              total_tokens: requests * 140,
              input_tokens: requests * 100,
              output_tokens: requests * 15,
              cached_input_tokens: requests * 20,
              cache_creation_tokens: requests * 5,
            })
          }
          if (scope === 'background') {
            expect(evidence.liveUsage?.totalTokens).toBe(560)
            expect(evidence.savedUsage).toEqual(evidence.liveUsage)
          }
        } finally {
          clearTimeout(timeout)
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }, 25_000)
  }
}
