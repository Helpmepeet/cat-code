import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFERRED_CONTINUATION_LAUNCH_AGENT_LABEL,
  DEFERRED_CONTINUATION_WORKER_ARGUMENT,
  getDeferredContinuationBackgroundStatus,
  renderDeferredContinuationLaunchAgent,
} from './deferredContinuationLaunchAgent.js'

const cleanup: string[] = []

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
