/** Reproducible resource probes for desktop background reads and usage timezones. */
import { mkdtemp, rm } from 'node:fs/promises'
import type { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createVisibilityGatedRefresh } from '../../app/main/refreshActivityGate.js'
import { runSessionsCatalogWorker } from '../../app/main/sessionsCatalogRunner.js'
import { inspectSessionsCatalogSources } from '../../app/shared/sessionsCatalogFingerprint.js'
import { localDateKey } from '../../src/utils/usageWindow.js'

const NativeDateTimeFormat = Intl.DateTimeFormat
let cachedFormatterConstructions = 0
Intl.DateTimeFormat = new Proxy(NativeDateTimeFormat, {
  construct(target, args, newTarget) {
    cachedFormatterConstructions++
    return Reflect.construct(target, args, newTarget)
  },
}) as typeof Intl.DateTimeFormat

const timeZone = 'America/New_York'
const timestamps = Array.from(
  { length: 30_000 },
  (_, index) => Date.UTC(2025, 0, 1) + index * 3_600_000,
)
const oldConvert = (timestamp: number): string => {
  const parts = Object.fromEntries(
    new NativeDateTimeFormat('en-CA', {
      timeZone,
      era: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(timestamp)
      .map(part => [part.type, part.value]),
  )
  const year = Number(parts.year) + (parts.era === 'BC' ? -1 : 0)
  return `${String(year).padStart(4, '0')}-${parts.month}-${parts.day}`
}
const oldStarted = performance.now()
const oldOutputs: string[] = []
for (const timestamp of timestamps) oldOutputs.push(oldConvert(timestamp))
const oldMs = performance.now() - oldStarted
const oldConstructions = timestamps.length

const cachedStarted = performance.now()
const cachedOutputs: string[] = []
for (const timestamp of timestamps) cachedOutputs.push(localDateKey(timestamp, timeZone))
const cachedMs = performance.now() - cachedStarted
const outputsMatch = oldOutputs.length === cachedOutputs.length && oldOutputs.every((value, index) => value === cachedOutputs[index])
if (!outputsMatch) throw new Error('timezone conversion output changed')

const configHome = await mkdtemp(join(tmpdir(), 'catcode-background-probe-'))
const previousConfigHome = process.env.CLAUDE_CONFIG_DIR
try {
  process.env.CLAUDE_CONFIG_DIR = configHome
  const coldCatalog = await inspectSessionsCatalogSources()
  if (coldCatalog.unchanged) throw new Error('empty isolated catalog unexpectedly had a cache')
  const workerPath = join(import.meta.dir, '../../app/sidecar/sessionsCatalogWorker.ts')
  const coldOutcome = await runSessionsCatalogWorker({
    command: process.execPath,
    args: ['run', workerPath, '--bare'],
    cwd: process.cwd(),
    onCatalog: () => {},
  })
  if (coldOutcome !== 'delivered') throw new Error(`cold catalog worker returned ${coldOutcome}`)
  const warmCatalog = await inspectSessionsCatalogSources()
  if (!warmCatalog.unchanged) throw new Error('stable empty catalog was not recognized')
  let catalogSpawnAttempts = 0
  const warmOutcome = await runSessionsCatalogWorker({
    command: process.execPath,
    args: ['run', workerPath, '--bare'],
    cwd: process.cwd(),
    shouldSkip: async () => (await inspectSessionsCatalogSources()).unchanged,
    spawnWorker: (() => { catalogSpawnAttempts++; throw new Error('unchanged catalog should not spawn') }) as unknown as typeof spawn,
    onCatalog: () => {},
  })
  if (warmOutcome !== 'unchanged' || catalogSpawnAttempts !== 0) throw new Error('warm catalog started a worker')

  // Model the driver cadence with its actual activity gate; timer callbacks
  // continue while hidden, but the wrapped worker function stays cold.
  const visibleStarts = { accounts: 0, catalog: 0, usage: 0 }
  let visible = true
  const drivers = Object.fromEntries(
    Object.keys(visibleStarts).map(name => [
      name,
      createVisibilityGatedRefresh(async () => { visibleStarts[name as keyof typeof visibleStarts]++ }, () => visible),
    ]),
  ) as Record<keyof typeof visibleStarts, ReturnType<typeof createVisibilityGatedRefresh>>
  await Promise.all(Object.values(drivers).map(driver => driver.run()))
  const coldStarts = { ...visibleStarts }
  visible = false
  for (let tick = 0; tick < 60; tick++) {
    await Promise.all(Object.values(drivers).map(driver => driver.run()))
  }
  const hiddenStarts = { ...visibleStarts }
  const skipped = Object.values(drivers).map(driver => driver.takeSkippedInterval())
  visible = true
  await Promise.all(Object.values(drivers).map(driver => driver.run()))
  process.stdout.write(
    `${JSON.stringify({
      timezone: {
        conversions: timestamps.length,
        oldFormatterConstructions: oldConstructions,
        cachedFormatterConstructions,
        oldMs: Math.round(oldMs),
        cachedMs: Math.round(cachedMs),
        outputsMatch,
      },
      backgroundGate: {
        oneColdStartEachWhileVisible: coldStarts,
        workerStartsDuringSixtyHiddenTicks: {
          accounts: hiddenStarts.accounts - coldStarts.accounts,
          catalog: hiddenStarts.catalog - coldStarts.catalog,
          usage: hiddenStarts.usage - coldStarts.usage,
        },
        skippedIntervals: skipped.filter(Boolean).length,
        visibleStartsAfterReturn: visibleStarts,
      },
      catalogCache: {
        coldWorkerOutcome: coldOutcome,
        warmWorkerOutcome: warmOutcome,
        warmSpawnAttempts: catalogSpawnAttempts,
      },
    })}\n`,
  )
} finally {
  Intl.DateTimeFormat = NativeDateTimeFormat
  if (previousConfigHome === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigHome
  await rm(configHome, { recursive: true, force: true })
}
