import { existsSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  activateTranscriptLease,
  assertActiveTranscriptLease,
  releaseActiveTranscriptLease,
  TranscriptInUseError,
} from './transcriptLease.js'
import { getClaudeConfigHomeDir } from './envUtils.js'

const sessionId = process.env.PROBE_SESSION_ID
const role = process.env.PROBE_ROLE
const readyFile = process.env.PROBE_READY_FILE
const releaseFile = process.env.PROBE_RELEASE_FILE
const action = process.env.PROBE_ACTION ?? 'lease'
const secondSessionId = process.env.PROBE_SECOND_SESSION_ID

if (!sessionId || !role) throw new Error('Missing transcript lease probe input')

try {
  if (action === 'compromise') {
    if (!secondSessionId) {
      throw new Error('Compromise probe needs a second session ID')
    }
    await activateTranscriptLease(sessionId)
    rmSync(
      join(
        getClaudeConfigHomeDir(),
        'transcript-leases',
        `${sessionId}.lease.lock`,
      ),
      { recursive: true, force: true },
    )
    // The production updater is intentionally slow. Wait for proper-lockfile's
    // real heartbeat to mark the guard ECOMPROMISED; no test-only lock shim.
    await Bun.sleep(23_000)
    let appendHealthRejected = false
    let compromiseCode: string | undefined
    try {
      assertActiveTranscriptLease(sessionId)
    } catch (error) {
      appendHealthRejected = true
      compromiseCode = (error as NodeJS.ErrnoException).code
    }
    if (!appendHealthRejected) {
      throw new Error('Compromised transcript append health remained writable')
    }
    await activateTranscriptLease(secondSessionId)
    assertActiveTranscriptLease(secondSessionId)
    await releaseActiveTranscriptLease()
    process.stdout.write(
      `RESULT:${JSON.stringify({
        role,
        pid: process.pid,
        outcome: 'acquired',
        appendHealthRejected,
        compromiseCode,
        transitionedSessionId: secondSessionId,
      })}\n`,
    )
    process.exit(0)
  }
  if (action === 'cleanup') {
    const { enableConfigs } = await import('./config.js')
    const { cleanupOldSessionFiles } = await import('./cleanup.js')
    const { cleanupOldImageCaches } = await import('./imageStore.js')
    enableConfigs()
    const sessions = await cleanupOldSessionFiles()
    await cleanupOldImageCaches(new Date())
    process.stdout.write(
      `RESULT:${JSON.stringify({ role, pid: process.pid, outcome: 'acquired', sessions })}\n`,
    )
    process.exit(0)
  }
  if (action === 'config') {
    const { enableConfigs, getGlobalConfig, saveGlobalConfig } = await import(
      './config.js'
    )
    const { getGlobalClaudeFile } = await import('./env.js')
    enableConfigs()
    getGlobalConfig()
    if (readyFile) writeFileSync(readyFile, String(process.pid))
    if (!releaseFile) throw new Error('Config contender needs a release file')
    const startedAt = Date.now()
    while (!existsSync(releaseFile)) {
      if (Date.now() - startedAt > 30_000) {
        throw new Error(`${role} timed out waiting for config release`)
      }
      await Bun.sleep(20)
    }
    saveGlobalConfig(current =>
      role === 'desktop'
        ? { ...current, lastUsedProvider: 'anthropic' }
        : { ...current, autoUpdates: true },
    )
    process.stdout.write(
      `RESULT:${JSON.stringify({ role, pid: process.pid, outcome: 'acquired', configPath: getGlobalClaudeFile(), nodeEnv: process.env.NODE_ENV, configExists: existsSync(getGlobalClaudeFile()) })}\n`,
    )
    process.exit(0)
  }
  await activateTranscriptLease(sessionId)
  if (readyFile) writeFileSync(readyFile, String(process.pid))
  if (releaseFile) {
    const startedAt = Date.now()
    while (!existsSync(releaseFile)) {
      if (Date.now() - startedAt > 30_000) {
        throw new Error(`${role} timed out waiting for release`)
      }
      await Bun.sleep(20)
    }
  }
  await releaseActiveTranscriptLease()
  process.stdout.write(
    `RESULT:${JSON.stringify({ role, pid: process.pid, outcome: 'acquired' })}\n`,
  )
} catch (error) {
  process.stdout.write(
    `RESULT:${JSON.stringify({
      role,
      pid: process.pid,
      outcome: error instanceof TranscriptInUseError ? 'in_use' : 'error',
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  )
  if (!(error instanceof TranscriptInUseError)) process.exitCode = 1
}
