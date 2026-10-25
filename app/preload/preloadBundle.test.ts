import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

test('packaged preload strips debug-state sender while dev preload contains it', () => {
  const build = spawnSync('bun', ['run', 'scripts/build-electron.ts'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    timeout: 90_000,
  })
  if (build.error) throw build.error
  if (build.status !== 0) throw new Error(`Electron build failed (${build.status}): ${build.stderr || build.stdout}`)
  expect(build.status).toBe(0)

  const packaged = new URL('./preload.cjs', import.meta.url)
  const dev = new URL('./preload.dev.cjs', import.meta.url)
  expect(existsSync(packaged)).toBe(true)
  expect(existsSync(dev)).toBe(true)
  expect(readFileSync(packaged, 'utf8')).not.toContain('catcode:debug:')
  expect(readFileSync(dev, 'utf8')).toContain('catcode:debug:shell-state')
}, 120_000)
