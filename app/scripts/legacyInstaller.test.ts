import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('legacy installer exits without installing into the recipient home', () => {
  const home = mkdtempSync(join(tmpdir(), 'catcode-retired-installer-'))
  try {
    const result = Bun.spawnSync(['/bin/bash', new URL('../../install.sh', import.meta.url).pathname], {
      cwd: home,
      env: { HOME: home, PATH: '/usr/bin:/bin' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('legacy installer is retired')
    expect(result.stderr.toString()).toContain('README.md')
    expect(readdirSync(home)).toEqual([])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
