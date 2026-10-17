import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { createOwnedCommandBudget } from './ownedCommandBudget.js'

test('owned cancellation before spawn does not execute the command', async () => {
  const budget = createOwnedCommandBudget(1000)
  budget.dispose()
  const result = await execFileNoThrowWithCwd(process.execPath, ['-e', 'process.exit(0)'], budget.commandOptions())
  expect(result).toMatchObject({ code: 1, error: 'Command aborted' })
})

test('owned cancellation kills descendants holding captured pipes', async () => {
  if (process.platform === 'win32') return
  const root = mkdtempSync(join(tmpdir(), 'exec-file-abort-'))
  const pidFile = join(root, 'child.pid')
  const budget = createOwnedCommandBudget(5000)
  // Do not inherit desktop launch identifiers, operational descriptors or auth.
  const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root }
  const command = execFileNoThrowWithCwd(process.execPath, ['-e', `
    const child = Bun.spawn([process.execPath, '-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdout: 'inherit', stderr: 'inherit' });
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    setInterval(() => {}, 1000);
  `], { ...budget.commandOptions(), cwd: root, env })
  try {
    const readyDeadline = performance.now() + 2000
    while (!existsSync(pidFile) && performance.now() < readyDeadline) await Bun.sleep(10)
    expect(existsSync(pidFile)).toBe(true)
    budget.dispose()
    expect(await command).toMatchObject({ code: 1, error: 'Command aborted' })
    const pid = Number(readFileSync(pidFile, 'utf8'))
    const state = Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(pid)]).stdout.toString().trim()
    expect(state === '' || state.startsWith('Z')).toBe(true)
  } finally {
    budget.dispose()
    await command
    rmSync(root, { recursive: true, force: true })
  }
}, 6000)

test('owned budget shares remaining time and can dispose after completion', async () => {
  const budget = createOwnedCommandBudget(2000)
  try {
    const first = budget.commandOptions().timeout
    const result = await execFileNoThrowWithCwd(process.execPath, ['-e', 'process.exit(0)'], {
      ...budget.commandOptions(), env: { PATH: process.env.PATH },
    })
    expect(result.code).toBe(0)
    expect(budget.commandOptions().timeout).toBeLessThan(first)
  } finally {
    budget.dispose()
  }
})

test('total budget aborts running work and refuses subsequent spawns', async () => {
  const budget = createOwnedCommandBudget(100)
  try {
    const result = await execFileNoThrowWithCwd(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      ...budget.commandOptions(), env: { PATH: process.env.PATH },
    })
    expect(result.code).not.toBe(0)
    expect(budget.signal.aborted).toBe(true)
    expect(await execFileNoThrowWithCwd(process.execPath, ['-e', 'process.exit(0)'], budget.commandOptions()))
      .toMatchObject({ code: 1, error: 'Command aborted' })
  } finally {
    budget.dispose()
  }
})

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
        env: { PATH: process.env.PATH, HOME: root },
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
      { timeout: 100, killSignal: 'SIGTERM', cwd: root, env: { PATH: process.env.PATH, HOME: root } },
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
        env: { PATH: process.env.PATH, HOME: root },
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
