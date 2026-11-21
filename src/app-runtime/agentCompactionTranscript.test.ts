import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixture = fileURLToPath(
  new URL('./agentCompactionTranscript.fixture.ts', import.meta.url),
)

for (const scope of ['worker', 'main'] as const) {
  for (const strategy of ['full', 'prefix'] as const) {
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
          }
          expect(evidence.olderReadInArchive).toBe(true)
          expect(evidence.preservedRead).toBe(strategy === 'prefix')
          expect(evidence.recoveryPath).toBe(evidence.transcript)
        } finally {
          clearTimeout(timeout)
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }, 25_000)
  }
}
