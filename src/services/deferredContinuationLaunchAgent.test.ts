import { afterEach, describe, expect, test } from 'bun:test'
import { access, chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFERRED_CONTINUATION_LAUNCH_AGENT_LABEL,
  DEFERRED_CONTINUATION_WORKER_ARGUMENT,
  getDeferredContinuationBackgroundStatus,
  installDeferredContinuationLaunchAgent,
  renderDeferredContinuationLaunchAgent,
  uninstallDeferredContinuationLaunchAgent,
  type LaunchctlExecutor,
  type LaunchctlRunResult,
} from './deferredContinuationLaunchAgent.js'

const cleanup: string[] = []

// Never invokes the real launchctl: every case drives the injected executor.
function fakeLaunchctl(
  responses: { bootout: LaunchctlRunResult; print: LaunchctlRunResult },
): { run: LaunchctlExecutor; calls: string[][] } {
  const calls: string[][] = []
  const run: LaunchctlExecutor = async args => {
    calls.push(args)
    return args[0] === 'bootout' ? responses.bootout : responses.print
  }
  return { run, calls }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function writePlist(): Promise<string> {
  const root = await mkdtemp('/tmp/cat-code-launch-agent-uninstall-')
  cleanup.push(root)
  const plistPath = join(root, 'agent.plist')
  await writeFile(plistPath, renderDeferredContinuationLaunchAgent('/missing/cat-code'), {
    mode: 0o600,
  })
  return plistPath
}

async function installFixture(withExistingPlist = true): Promise<{
  oldContents: string
  oldExecutable: string
  newExecutable: string
  plistPath: string
}> {
  const root = await mkdtemp('/tmp/cat-code-launch-agent-install-')
  cleanup.push(root)
  const oldExecutable = join(root, 'cat-code-old')
  const newExecutable = join(root, 'cat-code-new')
  await writeFile(oldExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  await writeFile(newExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  const plistPath = join(root, 'agent.plist')
  const oldContents = renderDeferredContinuationLaunchAgent(oldExecutable)
  if (withExistingPlist) {
    await writeFile(plistPath, oldContents, { mode: 0o600 })
  }
  return { oldContents, oldExecutable, newExecutable, plistPath }
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('deferred continuation LaunchAgent', () => {
  test('renders a bounded one-shot periodic worker without queue or shell semantics', () => {
    const plist = renderDeferredContinuationLaunchAgent('/Applications/Cat Code.app/Contents/MacOS/cat-code')
    expect(plist).toContain(DEFERRED_CONTINUATION_LAUNCH_AGENT_LABEL)
    expect(plist).toContain(DEFERRED_CONTINUATION_WORKER_ARGUMENT)
    expect(plist).toContain('<key>RunAtLoad</key>')
    expect(plist).toContain('<key>StartInterval</key>\n  <integer>60</integer>')
    expect(plist).toContain('<string>/dev/null</string>')
    expect(plist).not.toContain('QueueDirectories')
    expect(plist).not.toContain('KeepAlive')
    expect(plist).not.toContain('/bin/sh')
  })

  test('rejects a relative executable path', () => {
    expect(() => renderDeferredContinuationLaunchAgent('cat-code')).toThrow('absolute')
  })

  test('escapes the executable path and includes no queue, prompt, or credential fields', () => {
    const plist = renderDeferredContinuationLaunchAgent('/Applications/Cat & Code.app/Contents/MacOS/cat-code')
    expect(plist).toContain('Cat &amp; Code.app')
    expect(plist).not.toMatch(/QueueDirectories|prompt|token|credential|account/i)
  })

  test('reports absent and stale executable configurations without loading them', async () => {
    const root = await mkdtemp('/tmp/cat-code-launch-agent-')
    cleanup.push(root)
    const plistPath = join(root, 'agent.plist')
    expect(await getDeferredContinuationBackgroundStatus(plistPath)).toEqual({ state: 'disabled' })
    await writeFile(plistPath, renderDeferredContinuationLaunchAgent('/missing/cat-code'), { mode: 0o600 })
    expect(await getDeferredContinuationBackgroundStatus(plistPath)).toEqual({ state: 'needs_repair', executablePath: '/missing/cat-code' })
  })

  test('treats background continuation as disabled when getuid is unavailable off macOS', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    const getuidDescriptor = Object.getOwnPropertyDescriptor(process, 'getuid')
    const root = await mkdtemp('/tmp/cat-code-launch-agent-non-darwin-')
    cleanup.push(root)
    const { run, calls } = fakeLaunchctl({
      bootout: { outcome: 'ok' },
      print: { outcome: 'ok' },
    })

    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      Object.defineProperty(process, 'getuid', { value: undefined })

      expect(await getDeferredContinuationBackgroundStatus(join(root, 'agent.plist'))).toEqual({
        state: 'disabled',
      })
      expect(await uninstallDeferredContinuationLaunchAgent(join(root, 'agent.plist'), run)).toBe(false)
      expect(calls).toEqual([])
    } finally {
      if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
      if (getuidDescriptor) Object.defineProperty(process, 'getuid', getuidDescriptor)
      else delete (process as { getuid?: unknown }).getuid
    }
  })

  test('install keeps the previous plist when unload cannot be confirmed', async () => {
    const fixture = await installFixture()
    const calls: string[][] = []
    const run: LaunchctlExecutor = async args => {
      calls.push(args)
      if (args[0] === 'bootout') return { outcome: 'exit', code: 5 }
      if (args[0] === 'print') return { outcome: 'ok' }
      throw new Error('bootstrap must not run while the old job is loaded')
    }

    await expect(
      installDeferredContinuationLaunchAgent(
        fixture.newExecutable,
        fixture.plistPath,
        run,
      ),
    ).rejects.toThrow(/still loaded/)
    expect(await readFile(fixture.plistPath, 'utf8')).toBe(fixture.oldContents)
    expect(calls.map(args => args[0])).toEqual(['bootout', 'print'])
  })

  test('install restores and reloads the previous plist when new bootstrap fails', async () => {
    const fixture = await installFixture()
    const calls: string[][] = []
    let bootstrapCalls = 0
    const run: LaunchctlExecutor = async args => {
      calls.push(args)
      if (args[0] === 'bootout') return { outcome: 'ok' }
      if (args[0] === 'print') return { outcome: 'exit', code: 113 }
      bootstrapCalls++
      return bootstrapCalls === 1
        ? { outcome: 'exit', code: 5 }
        : { outcome: 'ok' }
    }

    await expect(
      installDeferredContinuationLaunchAgent(
        fixture.newExecutable,
        fixture.plistPath,
        run,
      ),
    ).rejects.toThrow(/previous plist was restored and reloaded/)
    expect(await readFile(fixture.plistPath, 'utf8')).toBe(fixture.oldContents)
    expect(calls.map(args => args[0])).toEqual([
      'bootout',
      'print',
      'bootstrap',
      'bootstrap',
    ])
  })

  test('first-install bootstrap failure keeps the new plist for repair', async () => {
    const fixture = await installFixture(false)
    const calls: string[][] = []
    const run: LaunchctlExecutor = async args => {
      calls.push(args)
      if (args[0] === 'bootout') return { outcome: 'exit', code: 5 }
      if (args[0] === 'print') return { outcome: 'exit', code: 113 }
      return { outcome: 'exit', code: 5 }
    }

    await expect(
      installDeferredContinuationLaunchAgent(
        fixture.newExecutable,
        fixture.plistPath,
        run,
      ),
    ).rejects.toThrow(/new plist was kept on disk for repair/)
    expect(await readFile(fixture.plistPath, 'utf8')).toContain(
      fixture.newExecutable,
    )
    expect(calls.map(args => args[0])).toEqual([
      'bootout',
      'print',
      'bootstrap',
    ])
  })

  // F6: a swallowed bootout failure used to delete the plist and report success,
  // leaving a loaded job firing with no on-disk record to repair from.
  test('keeps the plist and reports failure when the job survives bootout', async () => {
    const plistPath = await writePlist()
    // bootout fails, and the job is still loaded afterwards (print exits 0).
    const { run, calls } = fakeLaunchctl({
      bootout: { outcome: 'exit', code: 5 },
      print: { outcome: 'ok' },
    })
    await expect(uninstallDeferredContinuationLaunchAgent(plistPath, run)).rejects.toThrow(
      /still loaded/,
    )
    expect(await exists(plistPath)).toBe(true)
    expect(calls.map(args => args[0])).toEqual(['bootout', 'print'])
  })

  test('keeps the plist when the loaded state cannot be verified', async () => {
    const plistPath = await writePlist()
    const { run } = fakeLaunchctl({
      bootout: { outcome: 'exit', code: 5 },
      print: { outcome: 'unavailable' },
    })
    await expect(uninstallDeferredContinuationLaunchAgent(plistPath, run)).rejects.toThrow(
      /unable to verify/,
    )
    expect(await exists(plistPath)).toBe(true)
  })

  // bootout exits non-zero for a plist that was never loaded, so a failed bootout
  // alone must not block removal once the job is confirmed gone.
  test('removes the plist when bootout fails but the job is not loaded', async () => {
    const plistPath = await writePlist()
    const { run } = fakeLaunchctl({
      bootout: { outcome: 'exit', code: 5 },
      print: { outcome: 'exit', code: 113 },
    })
    expect(await uninstallDeferredContinuationLaunchAgent(plistPath, run)).toBe(true)
    expect(await exists(plistPath)).toBe(false)
  })

  test('removes the plist after a successful bootout', async () => {
    const plistPath = await writePlist()
    const { run } = fakeLaunchctl({
      bootout: { outcome: 'ok' },
      print: { outcome: 'exit', code: 113 },
    })
    expect(await uninstallDeferredContinuationLaunchAgent(plistPath, run)).toBe(true)
    expect(await exists(plistPath)).toBe(false)
  })

  // F3: an absent plist is only "already disabled" once the DOMAIN agrees. The
  // load state must still be queried — this previously returned false without
  // calling launchctl at all, which is the case below.
  test('reports an absent plist as already disabled once the domain agrees', async () => {
    const root = await mkdtemp('/tmp/cat-code-launch-agent-absent-')
    cleanup.push(root)
    const { run, calls } = fakeLaunchctl({
      bootout: { outcome: 'ok' },
      print: { outcome: 'exit', code: 113 },
    })
    expect(
      await uninstallDeferredContinuationLaunchAgent(join(root, 'missing.plist'), run),
    ).toBe(false)
    expect(calls.map(args => args[0])).toEqual(['print'])
  })

  // F3: launchd keeps a loaded job in the domain after its plist is deleted —
  // by hand, or by an install that failed after bootstrap. Reporting "already
  // disabled" there leaves the timer firing unattended turns with no on-disk
  // record to repair from.
  test('boots out a loaded job whose plist is already gone', async () => {
    const root = await mkdtemp('/tmp/cat-code-launch-agent-orphan-')
    cleanup.push(root)
    let booted = false
    const calls: string[][] = []
    const run: LaunchctlExecutor = async args => {
      calls.push(args)
      if (args[0] === 'bootout') {
        booted = true
        return { outcome: 'ok' }
      }
      return booted ? { outcome: 'exit', code: 113 } : { outcome: 'ok' }
    }
    expect(
      await uninstallDeferredContinuationLaunchAgent(join(root, 'missing.plist'), run),
    ).toBe(true)
    // Booted out BY LABEL — there is no plist path left to name.
    expect(calls.map(args => args[0])).toEqual(['print', 'bootout', 'print'])
    expect(calls[1]![1]).toContain(DEFERRED_CONTINUATION_LAUNCH_AGENT_LABEL)
  })

  test('refuses to claim a disable when an orphaned job will not unload', async () => {
    const root = await mkdtemp('/tmp/cat-code-launch-agent-orphan-stuck-')
    cleanup.push(root)
    const { run } = fakeLaunchctl({
      bootout: { outcome: 'exit', code: 5 },
      print: { outcome: 'ok' },
    })
    await expect(
      uninstallDeferredContinuationLaunchAgent(join(root, 'missing.plist'), run),
    ).rejects.toThrow(/loaded but .* is missing/)
  })

  test('rejects broad-mode and symlinked plist records as needing repair', async () => {
    const root = await mkdtemp('/tmp/cat-code-launch-agent-boundary-')
    cleanup.push(root)
    const contents = renderDeferredContinuationLaunchAgent('/missing/cat-code')
    const target = join(root, 'target.plist')
    const plistPath = join(root, 'agent.plist')
    await writeFile(target, contents, { mode: 0o644 })
    expect(await getDeferredContinuationBackgroundStatus(target)).toEqual({ state: 'needs_repair' })
    await chmod(target, 0o600)
    await symlink(target, plistPath)
    expect(await getDeferredContinuationBackgroundStatus(plistPath)).toEqual({ state: 'needs_repair' })
  })
})
