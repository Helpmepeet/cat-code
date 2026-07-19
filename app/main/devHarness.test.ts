import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionDescriptor } from '../shared/hostApi.js'
import {
  atomicWriteJson0600,
  createDevPickerBypass,
  createDebouncedAction,
  createReadinessLatch,
  parseDebugSnapshot,
  resolveDevHarnessConfig,
  resolvePickerDefaultPath,
} from './devHarness.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'catcode-dev-harness-'))
}

function descriptor(input: Partial<SessionDescriptor> & { appSessionId: string; cwd: string }): SessionDescriptor {
  return {
    engineSessionId: null,
    title: null,
    status: 'ready',
    restorable: false,
    createdAt: 1,
    lastAttachedAt: 1,
    lastMessageSentAt: null,
    ...input,
  }
}

test('dev cwd allowlist is resolved once, frozen, and cycles through validated dirs', () => {
  const a = tempDir()
  const b = tempDir()
  const logs: string[] = []
  const config = resolveDevHarnessConfig({
    isPackaged: false,
    env: { CATCODE_TEST_CWD_ALLOWLIST: `${a}:${b}` },
    validateCwd: cwd => ({ ok: true, realpath: cwd }),
    log: line => logs.push(line),
  })

  expect(Object.isFrozen(config)).toBe(true)
  expect(config.picker.kind).toBe('ready')
  const picker = createDevPickerBypass(config, {
    validateCwd: cwd => ({ ok: true, realpath: cwd }),
    log: line => logs.push(line),
  })
  expect(picker.pick()).toBe(a)
  expect(picker.pick()).toBe(b)
  expect(picker.pick()).toBe(a)
  expect(logs.some(line => line.includes('CATCODE_TEST_CWD_ALLOWLIST'))).toBe(true)
})

test('invalid allowlist fails closed: null picks, loud logs, no skip ahead', () => {
  const valid = tempDir()
  const logs: string[] = []
  const config = resolveDevHarnessConfig({
    isPackaged: false,
    env: { CATCODE_TEST_CWD_ALLOWLIST: `/missing:${valid}` },
    validateCwd: cwd => (cwd === valid ? { ok: true, realpath: cwd } : { ok: false }),
    log: line => logs.push(line),
  })
  const picker = createDevPickerBypass(config, {
    validateCwd: cwd => ({ ok: true, realpath: cwd }),
    log: line => logs.push(line),
  })

  expect(config.picker.kind).toBe('broken')
  expect(picker.pick()).toBeNull()
  expect(picker.pick()).toBeNull()
  expect(logs.join('\n')).toContain('broken')
})

test('vanished allowlist entry returns null and does not advance the cursor', () => {
  const a = tempDir()
  const b = tempDir()
  const logs: string[] = []
  const config = resolveDevHarnessConfig({
    isPackaged: false,
    env: { CATCODE_TEST_CWD_ALLOWLIST: `${a}:${b}` },
    validateCwd: cwd => ({ ok: true, realpath: cwd }),
    log: line => logs.push(line),
  })
  const vanished = new Set([a])
  const picker = createDevPickerBypass(config, {
    validateCwd: cwd => (vanished.has(cwd) ? { ok: false } : { ok: true, realpath: cwd }),
    log: line => logs.push(line),
  })

  expect(picker.pick()).toBeNull()
  vanished.clear()
  expect(picker.pick()).toBe(a)
  expect(picker.pick()).toBe(b)
  expect(logs.join('\n')).toContain('failed')
})

test('packaged builds disable all dev harness flags regardless of env', () => {
  const dir = tempDir()
  const config = resolveDevHarnessConfig({
    isPackaged: true,
    env: {
      CATCODE_TEST_CWD_ALLOWLIST: dir,
      CATCODE_INITIAL_CWD: dir,
      CATCODE_DEBUG_STATE: '1',
    },
    validateCwd: cwd => ({ ok: true, realpath: cwd }),
    log: () => {},
  })

  expect(config.picker.kind).toBe('disabled')
  expect(config.initialCwd).toBeNull()
  expect(config.debugState).toBe(false)
})

test('readiness latch logs exactly once in either event order', () => {
  const lines: string[] = []
  const a = createReadinessLatch(() => lines.push('ready'))
  a.rendererReady()
  a.rendererReady()
  a.windowReady()
  a.windowReady()

  const b = createReadinessLatch(() => lines.push('ready'))
  b.windowReady()
  b.rendererReady()
  b.rendererReady()

  expect(lines).toEqual(['ready', 'ready'])
})

test('parseDebugSnapshot rejects unknown keys, bad enums, and oversize strings', () => {
  const valid = {
    debugStateVersion: 1,
    rendererStateAt: 123,
    renderer: {
      activeSessionId: null,
      tabs: [],
      sidebar: [],
      permissions: {},
    },
  }
  expect(parseDebugSnapshot(valid).ok).toBe(true)
  expect(parseDebugSnapshot({ ...valid, extra: true }).ok).toBe(false)
  expect(parseDebugSnapshot({
    ...valid,
    renderer: { ...valid.renderer, tabs: [{ appSessionId: 's', title: 't', label: 'x', tone: 'purple', restartable: false, needsAttention: false }] },
  }).ok).toBe(false)
  expect(parseDebugSnapshot({
    ...valid,
    renderer: { ...valid.renderer, tabs: [{ appSessionId: 's', title: 'x'.repeat(2000), label: 'ready', tone: 'live', restartable: false, needsAttention: false }] },
  }).ok).toBe(false)
})

test('picker defaultPath honors a valid active id hint, then recency fallback', () => {
  const a = descriptor({ appSessionId: '00000000-0000-4000-8000-000000000001', cwd: '/a', lastAttachedAt: 1 })
  const b = descriptor({ appSessionId: '00000000-0000-4000-8000-000000000002', cwd: '/b', lastAttachedAt: 5 })
  const closed = descriptor({ appSessionId: '00000000-0000-4000-8000-000000000003', cwd: '/closed', restorable: true, lastAttachedAt: 99 })

  expect(resolvePickerDefaultPath([a, b, closed], a.appSessionId)).toBe('/a')
  expect(resolvePickerDefaultPath([a, b, closed], 'not-a-uuid')).toBe('/b')
  expect(resolvePickerDefaultPath([closed], '00000000-0000-4000-8000-000000000099')).toBeUndefined()
})

test('atomic debug-state writer creates a 0700 dir and 0600 JSON file', () => {
  const root = tempDir()
  const debugDir = join(root, 'desktop', 'debug')
  const target = join(debugDir, 'state.json')
  atomicWriteJson0600(target, { ok: true })

  expect((statSync(debugDir).mode & 0o777)).toBe(0o700)
  expect((statSync(target).mode & 0o777)).toBe(0o600)
  rmSync(root, { recursive: true, force: true })
})

test('debounced action coalesces repeated export requests until the timer fires', () => {
  const callbacks: Array<() => void> = []
  let cleared = 0
  let calls = 0
  const action = createDebouncedAction(() => {
    calls++
  }, {
    delayMs: 250,
    setTimer: callback => {
      callbacks.push(callback)
      return callbacks.length
    },
    clearTimer: () => {
      cleared++
    },
  })

  action.schedule()
  action.schedule()
  action.schedule()

  expect(calls).toBe(0)
  expect(cleared).toBe(2)
  expect(callbacks).toHaveLength(3)

  callbacks[2]?.()
  expect(calls).toBe(1)

  action.schedule()
  callbacks[3]?.()
  expect(calls).toBe(2)
})
