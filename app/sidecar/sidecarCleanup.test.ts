import { afterAll, afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  connectToServer,
  disposeServerConnection,
  resetMcpConnectionAcquisitionStateForTest,
} from '../../src/services/mcp/client.js'
import type { ScopedMcpServerConfig } from '../../src/services/mcp/types.js'
import {
  createSidecarCleanup,
  SIDECAR_CLEANUP_DEADLINE_MS,
} from './sidecarCleanup.js'

const tempDirs: string[] = []
const macroState = globalThis as typeof globalThis & {
  MACRO?: { VERSION: string; FEEDBACK_CHANNEL: string }
}
const originalMacro = macroState.MACRO
macroState.MACRO = {
  VERSION: 'test',
  FEEDBACK_CHANNEL: 'test',
}

afterEach(async () => {
  await resetMcpConnectionAcquisitionStateForTest()
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

afterAll(() => {
  macroState.MACRO = originalMacro
})

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 5_000
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`fixture did not create ${path}`)
    }
    await Bun.sleep(10)
  }
  return await Bun.file(path).text()
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (true) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    if (Date.now() >= deadline) {
      throw new Error(`owned fixture process ${pid} did not exit`)
    }
    await Bun.sleep(10)
  }
}

test('runs lifecycle disposal before lease release and exits once for repeated triggers', async () => {
  const calls: string[] = []
  const exits: number[] = []
  const cleanup = createSidecarCleanup({
    disposeMcpLifecycle: async () => {
      calls.push('lifecycle')
    },
    closeSocket: () => {
      calls.push('socket')
    },
    runRegisteredCleanup: async () => {
      calls.push('registry')
      return { rejected: 0 }
    },
    releaseTranscriptLease: async () => {
      calls.push('lease')
    },
    onDiagnostic: () => {
      calls.push('diagnostic')
    },
    exit: code => {
      exits.push(code)
    },
  })

  await Promise.all([cleanup.exit(12), cleanup.exit(0)])

  expect(calls).toEqual(['lifecycle', 'socket', 'registry', 'lease'])
  expect(exits).toEqual([12])
})

test('exits at the internal deadline when registered cleanup hangs', async () => {
  const diagnostics: string[] = []
  const exits: number[] = []
  const cleanup = createSidecarCleanup({
    disposeMcpLifecycle: async () => {},
    closeSocket: () => {},
    runRegisteredCleanup: () => new Promise(() => {}),
    releaseTranscriptLease: async () => {},
    onDiagnostic: diagnostic => {
      diagnostics.push(diagnostic.reason)
    },
    exit: code => {
      exits.push(code)
    },
  })

  const startedAt = Date.now()
  await cleanup.exit(0)
  const elapsedMs = Date.now() - startedAt

  expect(elapsedMs).toBeGreaterThanOrEqual(SIDECAR_CLEANUP_DEADLINE_MS - 100)
  expect(elapsedMs).toBeLessThan(2_000)
  expect(diagnostics).toEqual(['cleanup_timeout'])
  expect(exits).toEqual([0])
})

test('does not let a hung transcript-lease release outlive the cleanup deadline', async () => {
  const diagnostics: string[] = []
  const exits: number[] = []
  const cleanup = createSidecarCleanup({
    disposeMcpLifecycle: async () => {},
    closeSocket: () => {},
    runRegisteredCleanup: async () => ({ rejected: 0 }),
    releaseTranscriptLease: () => new Promise(() => {}),
    onDiagnostic: diagnostic => {
      diagnostics.push(diagnostic.reason)
    },
    exit: code => {
      exits.push(code)
    },
  })

  const startedAt = Date.now()
  await cleanup.exit(0)
  const elapsedMs = Date.now() - startedAt

  expect(elapsedMs).toBeGreaterThanOrEqual(SIDECAR_CLEANUP_DEADLINE_MS - 100)
  expect(elapsedMs).toBeLessThan(2_000)
  expect(diagnostics).toEqual(['cleanup_timeout'])
  expect(exits).toEqual([0])
})

test('disposes a pending MCP child through the sidecar cleanup path', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'catcode-sidecar-cleanup-'))
  tempDirs.push(directory)
  const pidPath = join(directory, 'mcp.pid')
  const name = 'sidecar-cleanup-pending'
  const config = {
    type: 'stdio',
    command: process.execPath,
    args: [
      '-e',
      `await Bun.write(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000)`,
    ],
    scope: 'local',
  } satisfies ScopedMcpServerConfig
  const connection = connectToServer(name, config)
  const pid = Number(await waitForFile(pidPath))
  const cleanup = createSidecarCleanup({
    disposeMcpLifecycle: () => disposeServerConnection(name, config),
    closeSocket: () => {},
    runRegisteredCleanup: async () => ({ rejected: 0 }),
    releaseTranscriptLease: async () => {},
    onDiagnostic: () => {},
    exit: () => {},
  })

  await cleanup.exit(0)
  await connection
  await waitForProcessExit(pid)
})
