import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'

test('opt-in hard timeout kills a descendant holding captured output open', async () => {
  if (process.platform === 'win32') return

  const root = mkdtempSync(join(tmpdir(), 'exec-file-timeout-'))
  const pidFile = join(root, 'child.pid')
  const childScript = `
    const { writeFileSync } = require('node:fs');
    const child = Bun.spawn([process.execPath, '-e', "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 5000)"], {
      stdout: 'inherit',
      stderr: 'inherit',
    });
    writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `

  try {
    const started = performance.now()
    const result = await execFileNoThrowWithCwd(
      process.execPath,
      ['-e', childScript],
      {
        timeout: 1000,
        killSignal: 'SIGTERM',
        killProcessGroupOnTimeout: true,
        cwd: root,
      },
    )
    const elapsed = performance.now() - started

    expect(result.code).not.toBe(0)
    expect(elapsed).toBeGreaterThanOrEqual(1000)
    expect(elapsed).toBeLessThan(2000)
    expect(existsSync(pidFile)).toBe(true)
    const childPid = Number(readFileSync(pidFile, 'utf8'))
    const childState = Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(childPid)])
      .stdout.toString()
      .trim()
    expect(childState === '' || childState.startsWith('Z')).toBe(true)
  } finally {
    if (existsSync(pidFile)) {
      const childPid = Number(readFileSync(pidFile, 'utf8'))
      try {
        process.kill(childPid, 'SIGKILL')
      } catch {
        // The invocation's process group already exited.
      }
    }
    rmSync(root, { recursive: true, force: true })
  }
}, 6000)

test('default timeout leaves a finite descendant outside process-group cleanup', async () => {
  if (process.platform === 'win32') return

  const root = mkdtempSync(join(tmpdir(), 'exec-file-default-timeout-'))
  const pidFile = join(root, 'child.pid')
  const childScript = `
    const { writeFileSync } = require('node:fs');
    const child = Bun.spawn([process.execPath, '-e', "setTimeout(() => process.exit(0), 500)"], {
      stdout: 'inherit',
      stderr: 'inherit',
    });
    writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
  `

  try {
    const started = performance.now()
    const result = await execFileNoThrowWithCwd(
      process.execPath,
      ['-e', childScript],
      { timeout: 100, killSignal: 'SIGTERM', cwd: root },
    )

    expect(result.code).toBe(0)
    expect(performance.now() - started).toBeGreaterThanOrEqual(400)
    expect(existsSync(pidFile)).toBe(true)
    const childPid = Number(readFileSync(pidFile, 'utf8'))
    expect(() => process.kill(childPid, 0)).toThrow()
  } finally {
    if (existsSync(pidFile)) {
      const childPid = Number(readFileSync(pidFile, 'utf8'))
      try {
        process.kill(childPid, 'SIGKILL')
      } catch {
        // The finite fixture child already exited.
      }
    }
    rmSync(root, { recursive: true, force: true })
  }
}, 6000)

test('opt-in timeout settles when a descendant has detached from its process group', async () => {
  if (process.platform === 'win32') return

  const root = mkdtempSync(join(tmpdir(), 'exec-file-detached-timeout-'))
  const pidFile = join(root, 'child.pid')
  const childScript = `
    const { writeFileSync } = require('node:fs');
    const child = Bun.spawn([process.execPath, '-e', "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 5000)"], {
      detached: true,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `

  try {
    const started = performance.now()
    const result = await execFileNoThrowWithCwd(
      process.execPath,
      ['-e', childScript],
      {
        timeout: 1000,
        killSignal: 'SIGTERM',
        killProcessGroupOnTimeout: true,
        cwd: root,
      },
    )

    expect(result.code).not.toBe(0)
    expect(performance.now() - started).toBeLessThan(2000)
    expect(existsSync(pidFile)).toBe(true)
    const childPid = Number(readFileSync(pidFile, 'utf8'))
    expect(() => process.kill(childPid, 0)).not.toThrow()
  } finally {
    if (existsSync(pidFile)) {
      const childPid = Number(readFileSync(pidFile, 'utf8'))
      try {
        process.kill(childPid, 'SIGKILL')
      } catch {
        // The finite fixture child already exited.
      }
    }
    rmSync(root, { recursive: true, force: true })
  }
}, 6000)
