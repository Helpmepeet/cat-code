import { afterAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const CHILD = join(import.meta.dir, 'transcriptLease.probe.child.ts')
const scratch = mkdtempSync(join(tmpdir(), 'transcript-lease-'))
const sessionId = '11111111-1111-4111-8111-111111111111'
const secondSessionId = '22222222-2222-4222-8222-222222222222'

type ChildResult = {
  role: string
  pid: number
  outcome: 'acquired' | 'in_use' | 'error'
  message?: string
  configPath?: string
  configExists?: boolean
  nodeEnv?: string
  appendHealthRejected?: boolean
  compromiseCode?: string
  transitionedSessionId?: string
}

function spawnRole(
  role: 'desktop' | 'terminal',
  options: {
    readyFile?: string
    releaseFile?: string
    action?: 'lease' | 'cleanup' | 'config' | 'compromise'
    sessionId?: string
    secondSessionId?: string
  } = {},
) {
  const proc = Bun.spawn({
    cmd: [process.execPath, 'run', CHILD],
    env: {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'development',
      CLAUDE_CONFIG_DIR: join(scratch, 'config'),
      PROBE_SESSION_ID: options.sessionId ?? sessionId,
      PROBE_ROLE: role,
      PROBE_ACTION: options.action ?? 'lease',
      ...(options.secondSessionId
        ? { PROBE_SECOND_SESSION_ID: options.secondSessionId }
        : {}),
      ...(options.readyFile ? { PROBE_READY_FILE: options.readyFile } : {}),
      ...(options.releaseFile ? { PROBE_RELEASE_FILE: options.releaseFile } : {}),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const pid = proc.pid
  const result = (async (): Promise<ChildResult> => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const exited = Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const [exitCode, stdout, stderr] = await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            proc.kill()
            reject(new Error(`${role} PID ${pid} timed out`))
          }, options.action === 'compromise' ? 40_000 : 30_000)
        }),
      ])
      const line = stdout.split('\n').find(value => value.startsWith('RESULT:'))
      if (!line) {
        throw new Error(
          `${role} PID ${pid} printed no result (exit ${exitCode})\nstdout: ${stdout}\nstderr: ${stderr}`,
        )
      }
      const parsed = JSON.parse(line.slice('RESULT:'.length)) as ChildResult
      expect(parsed.pid).toBe(pid)
      return parsed
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  })()
  return { pid, result }
}

async function waitForReady(path: string, expectedPid: number): Promise<void> {
  const startedAt = Date.now()
  while (!existsSync(path)) {
    if (Date.now() - startedAt > 30_000) {
      throw new Error(`PID ${expectedPid} did not publish readiness`)
    }
    await Bun.sleep(20)
  }
  expect(Number(readFileSync(path, 'utf8'))).toBe(expectedPid)
}

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('transcript lease coexistence (real desktop and terminal processes)', () => {
  test('the second owner is refused and can acquire after the first exits cleanly', async () => {
    const readyFile = join(scratch, 'desktop.ready')
    const releaseFile = join(scratch, 'desktop.release')
    const desktop = spawnRole('desktop', { readyFile, releaseFile })
    await waitForReady(readyFile, desktop.pid)

    const competingTerminal = spawnRole('terminal')
    expect(await competingTerminal.result).toMatchObject({
      role: 'terminal',
      outcome: 'in_use',
    })

    writeFileSync(releaseFile, 'release')
    expect(await desktop.result).toMatchObject({
      role: 'desktop',
      outcome: 'acquired',
    })

    const terminalAfterExit = spawnRole('terminal')
    expect(await terminalAfterExit.result).toMatchObject({
      role: 'terminal',
      outcome: 'acquired',
    })
  })

  /**
   * Regression evidence: scratchpad/wedge/child.ts reproduced the pre-fix
   * ERELEASED wedge after proper-lockfile's real 20-second updater marked A
   * compromised. The old transition released A before pinning B, threw, and
   * left the dead A guard active. This repository probe exercises that same
   * proper-lockfile heartbeat without a test shim.
   */
  test(
    'a compromised released guard rejects append health and transitions to a new lease',
    async () => {
      expect(
        await spawnRole('terminal', {
          action: 'compromise',
          secondSessionId,
        }).result,
      ).toMatchObject({
        outcome: 'acquired',
        appendHealthRejected: true,
        compromiseCode: 'ECOMPROMISED',
        transitionedSessionId: secondSessionId,
      })

      // The child released B. A fresh exact process can acquire it, proving the
      // recovered guard was not leaked during transition or shutdown.
      expect(
        await spawnRole('desktop', {
          sessionId: secondSessionId,
        }).result,
      ).toMatchObject({ outcome: 'acquired' })
    },
    45_000,
  )

  test('periodic cleanup preserves an active transcript and image cache', async () => {
    const configHome = join(scratch, 'config')
    const leaseTarget = join(
      configHome,
      'transcript-leases',
      `${sessionId}.lease`,
    )
    const transcript = join(
      configHome,
      'projects',
      'synthetic',
      `${sessionId}.jsonl`,
    )
    const toolResult = join(
      configHome,
      'projects',
      'synthetic',
      sessionId,
      'tool-results',
      'tool',
      'result.txt',
    )
    const image = join(
      configHome,
      'image-cache',
      sessionId,
      '1.png',
    )
    const cast = join(
      configHome,
      'projects',
      'synthetic',
      `${sessionId}-2026-01-01T00-00-00-000Z.cast`,
    )
    for (const path of [transcript, toolResult, image, cast]) {
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, 'synthetic')
      const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
      utimesSync(path, old, old)
    }
    const imageDir = join(configHome, 'image-cache', sessionId)
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    utimesSync(imageDir, old, old)

    const readyFile = join(scratch, 'cleanup-desktop.ready')
    const releaseFile = join(scratch, 'cleanup-desktop.release')
    const desktop = spawnRole('desktop', { readyFile, releaseFile })
    await waitForReady(readyFile, desktop.pid)

    expect(
      await spawnRole('terminal', { action: 'cleanup' }).result,
    ).toMatchObject({ outcome: 'acquired' })
    expect(existsSync(transcript)).toBe(true)
    expect(existsSync(toolResult)).toBe(true)
    expect(existsSync(image)).toBe(true)

    writeFileSync(releaseFile, 'release')
    await desktop.result

    expect(
      await spawnRole('terminal', { action: 'cleanup' }).result,
    ).toMatchObject({ outcome: 'acquired' })
    expect(existsSync(transcript)).toBe(false)
    expect(existsSync(cast)).toBe(false)
    expect(existsSync(toolResult)).toBe(false)
    expect(existsSync(image)).toBe(false)
    expect(existsSync(leaseTarget)).toBe(false)
  })

  test('terminal and desktop config updates merge from a fresh locked read', async () => {
    const desktopReady = join(scratch, 'config-desktop.ready')
    const terminalReady = join(scratch, 'config-terminal.ready')
    const releaseFile = join(scratch, 'config.release')
    const desktop = spawnRole('desktop', {
      action: 'config',
      readyFile: desktopReady,
      releaseFile,
    })
    const terminal = spawnRole('terminal', {
      action: 'config',
      readyFile: terminalReady,
      releaseFile,
    })
    await Promise.all([
      waitForReady(desktopReady, desktop.pid),
      waitForReady(terminalReady, terminal.pid),
    ])
    writeFileSync(releaseFile, 'release')
    const desktopResult = await desktop.result
    const terminalResult = await terminal.result
    expect(desktopResult).toMatchObject({ outcome: 'acquired' })
    expect(terminalResult).toMatchObject({ outcome: 'acquired' })
    expect(desktopResult.configPath).toBe(terminalResult.configPath)
    expect(typeof desktopResult.configPath).toBe('string')
    expect(desktopResult).toMatchObject({
      configExists: true,
      nodeEnv: 'development',
    })

    const written = JSON.parse(
      readFileSync(desktopResult.configPath!, 'utf8'),
    ) as Record<string, unknown>
    expect(written.lastUsedProvider).toBe('anthropic')
    expect(written.autoUpdates).toBe(true)
  })
})
