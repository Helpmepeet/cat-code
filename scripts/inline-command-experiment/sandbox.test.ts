import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPtyAttempt } from './pty'

for (const shell of ['bash', 'zsh'] as const) {
  test(`${shell}: real sandbox wrapper preserves PTY/status and refuses sibling writes/direct network`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'inline-sandbox-test-')))
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside')
    await mkdir(workspace)
    await mkdir(outside)
    let requests = 0
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
      requests++
      return new Response('owned-loopback-server')
    } })
    try {
      const target = `http://127.0.0.1:${server.port}/`
      const baseline = await runPtyAttempt({ shell, cwd: workspace, command: `/usr/bin/curl --noproxy '*' --silent --show-error --max-time 1 '${target}'` })
      expect(baseline.exitCode).toBe(0)
      expect(baseline.output).toContain('owned-loopback-server')
      expect(requests).toBe(1)
      const result = await runPtyAttempt({ shell, cwd: workspace, sandbox: true,
        prompt: 'SANDBOX-PROMPT> ', profile: 'printf "PROFILE\\n"',
        command: `test -t 0 && test -t 1 && printf 'TTY_OK\\n'
printf allowed > allowed.txt
printf denied > '${outside}/escape.txt'
write_status=$?
printf 'WRITE_STATUS=%s\\n' "$write_status"
/usr/bin/curl --noproxy '*' --silent --show-error --max-time 1 '${target}'
network_status=$?
printf 'NETWORK_STATUS=%s\\n' "$network_status"
false`, runTimeoutMs: 3000,
      })
      expect(result.sandboxWrapped).toBe(true)
      expect(result.lifecycle.containment).toBe('sandbox_envelope_not_job_ownership')
      expect(result.status).toBe('completed')
      expect(result.exitCode).toBe(1)
      expect(result.output).toContain('TTY_OK')
      expect(result.output).toContain('SANDBOX-PROMPT> ')
      expect(result.output.match(/PROFILE/g)?.length).toBe(1)
      expect(await readFile(join(workspace, 'allowed.txt'), 'utf8')).toBe('allowed')
      expect(await Bun.file(join(outside, 'escape.txt')).exists()).toBe(false)
      expect(result.output).toMatch(/WRITE_STATUS=[1-9][0-9]*/)
      expect(result.output).toMatch(/NETWORK_STATUS=[1-9][0-9]*/)
      expect(requests).toBe(1)
      expect(result.output).not.toContain('owned-loopback-server')
    } finally {
      await server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  }, 15000)
}
