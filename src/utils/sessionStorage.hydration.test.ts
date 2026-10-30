import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

for (const mode of ['v1', 'v2']) {
  const scenarios = ['busy', 'success', 'empty', 'reader-failure', 'write-failure', 'borrowed-success', 'borrowed-failure', 'released-main',
    'symlink-main', 'hardlink-main', 'permissive-main', 'release-at-guard-main',
    ...(mode === 'v2' ? ['epoch', 'released-agent', 'symlink-agent', 'hardlink-agent', 'permissive-agent', 'release-at-guard-agent'] : [])]
  for (const scenario of scenarios) {
    test(`${mode} hydration: ${scenario}`, async () => {
      const scratch = await mkdtemp(join(tmpdir(), 'hydration-lease-'))
      const child = Bun.spawn([process.execPath, join(import.meta.dir, 'sessionStorage.hydration.child.ts'), mode, scenario], {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: scratch,
          CLAUDE_CONFIG_DIR: join(scratch, 'config'),
          NODE_ENV: 'test',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const [exit, stdout, stderr] = await Promise.race([
          Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              child.kill()
              reject(new Error(`Hydration probe ${mode}/${scenario} timed out`))
            }, 20_000)
          }),
        ])
        expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
        expect(stdout).toContain('PASS')
      } finally {
        if (timer) clearTimeout(timer)
        if (child.exitCode === null) { child.kill(); await child.exited }
        await rm(scratch, { recursive: true, force: true })
      }
    }, 25_000)
  }
}
