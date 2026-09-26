/** Main-side read of a single disposable, project-aware Settings inventory. */
import type { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'

import { scanForSecrets } from '../shared/secretGuard.js'
import {
  MAX_SETTINGS_INVENTORY_WORKER_RECORD_BYTES,
  parseSettingsInventoryWorkerResult,
  type SettingsInventory,
} from '../shared/settingsInventoryWorker.js'
import { runNdjsonWorker, type WorkerProcessLifecycle } from './ndjsonWorker.js'

export const SETTINGS_INVENTORY_WORKER_TIMEOUT_MS = 30_000

export type SettingsInventoryRunOptions = {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
  spawnWorker?: typeof spawn
  onInventory: (inventory: SettingsInventory) => void
  onWorkerLifecycle?: (event: WorkerProcessLifecycle) => void
  log?: (line: string) => void
}

export type SettingsInventoryRunOutcome = 'delivered' | 'failure'

/** A failed read leaves any prior inventory untouched; malformed output fails closed. */
export async function runSettingsInventoryWorker(
  options: SettingsInventoryRunOptions,
): Promise<SettingsInventoryRunOutcome> {
  let seen = false
  let error: string | null = null
  let result: SettingsInventory | null = null
  let workerFailure = false
  const expectedCwd = realpathSync(options.cwd)

  const terminal = await runNdjsonWorker({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? SETTINGS_INVENTORY_WORKER_TIMEOUT_MS,
    spawnWorker: options.spawnWorker,
    simpleMode: false,
    maxRecordBytes: MAX_SETTINGS_INVENTORY_WORKER_RECORD_BYTES,
    onWorkerLifecycle: options.onWorkerLifecycle,
    log: options.log,
    onOversizeRecord: () => { error = 'settings inventory worker record exceeds size limit' },
    onRecord: line => {
      if (seen) {
        error = 'settings inventory worker emitted more than one record'
        return 'stop'
      }
      seen = true
      let raw: unknown
      try {
        raw = JSON.parse(line.toString('utf8'))
      } catch {
        error = 'settings inventory worker record is not valid JSON'
        return 'stop'
      }
      const parsed = parseSettingsInventoryWorkerResult(raw)
      if (!parsed || !scanForSecrets(parsed).ok) {
        error = 'settings inventory worker record failed validation'
        return 'stop'
      }
      if (parsed.type === 'failure') {
        workerFailure = true
        return 'continue'
      }
      if (parsed.cwd !== expectedCwd) {
        error = 'settings inventory worker cwd mismatch'
        return 'stop'
      }
      result = {
        cwd: parsed.cwd,
        extensions: parsed.extensions,
        agents: parsed.agents,
        settings: parsed.settings,
        memory: parsed.memory,
      }
      return 'continue'
    },
  })
  if (terminal.aborted) throw new Error('settings inventory worker aborted')
  if (terminal.timedOut) throw new Error('settings inventory worker timed out')
  if (terminal.stdinError !== null) throw new Error('settings inventory worker stdin failed', { cause: terminal.stdinError })
  if (error !== null) throw new Error(error)
  if (terminal.code !== 0) {
    throw new Error(`settings inventory worker failed (code=${String(terminal.code)} signal=${String(terminal.signal)})`)
  }
  if (terminal.trailingBytes !== 0 || !seen) {
    throw new Error('settings inventory worker ended without a valid result record')
  }
  if (workerFailure || result === null) return 'failure'
  try {
    options.onInventory(result)
  } catch (cause) {
    throw new Error('settings inventory worker result callback failed', { cause })
  }
  return 'delivered'
}
