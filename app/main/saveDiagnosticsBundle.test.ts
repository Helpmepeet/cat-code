import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { saveDiagnosticsBundle } from './saveDiagnosticsBundle.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-save-diagnostics-'))
  roots.push(root)
  const logsDirectory = join(root, 'logs')
  mkdirSync(logsDirectory)
  return {
    root,
    bundleOptions: { logsDirectory, appVersion: 'test', currentLaunchId: 'launch' },
  }
}

test('saved means the selected file contains the real allowlisted diagnostics bundle', async () => {
  const { root, bundleOptions } = fixture()
  const filePath = join(root, 'diagnostics.json')
  writeFileSync(join(bundleOptions.logsDirectory, 'settings.json'), 'private-settings-marker')
  const failures: unknown[] = []
  const result = await saveDiagnosticsBundle({
    chooseDestination: async () => ({ canceled: false, filePath }),
    bundleOptions,
    onFailure: error => failures.push(error),
  })
  expect(result).toBe('saved')
  const text = readFileSync(filePath, 'utf8')
  expect(JSON.parse(text).format).toBe('cat-code-diagnostics-v2')
  expect(text).not.toContain('private-settings-marker')
  expect(failures).toEqual([])
})

test('cancellation skips reading the bundle source and writing a destination', async () => {
  const { root, bundleOptions } = fixture()
  const invalidLogs = join(root, 'not-a-directory')
  writeFileSync(invalidLogs, 'private-source-marker')
  const failures: unknown[] = []
  const cancelled = await saveDiagnosticsBundle({
    chooseDestination: async () => ({ canceled: true, filePath: join(root, 'unused.json') }),
    bundleOptions: { ...bundleOptions, logsDirectory: invalidLogs },
    onFailure: error => failures.push(error),
  })
  expect(cancelled).toBe('cancelled')
  expect(failures).toEqual([])
})

for (const failure of ['picker', 'source', 'write'] as const) {
  test(`${failure} failure returns a bounded failed result instead of cancellation or a rejection`, async () => {
    const { root, bundleOptions } = fixture()
    const invalidLogs = join(root, 'not-a-directory')
    writeFileSync(invalidLogs, 'private-source-marker')
    const failures: unknown[] = []
    const result = await saveDiagnosticsBundle({
      chooseDestination: async () => {
        if (failure === 'picker') throw new Error('private-picker-marker')
        return { canceled: false, filePath: failure === 'write' ? root : join(root, 'invalid.json') }
      },
      bundleOptions: failure === 'source' ? { ...bundleOptions, logsDirectory: invalidLogs } : bundleOptions,
      onFailure: error => failures.push(error),
    })
    expect(result).toBe('failed')
    expect(failures).toHaveLength(1)
  })
}

test('a non-cancelled picker response without a destination is a failure', async () => {
  const { bundleOptions } = fixture()
  expect(await saveDiagnosticsBundle({
    chooseDestination: async () => ({ canceled: false }), bundleOptions,
    onFailure() {},
  })).toBe('failed')
})
