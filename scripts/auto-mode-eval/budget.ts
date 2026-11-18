import { randomUUID } from 'node:crypto'
import { mkdir, readdir, truncate } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomicDurableIfAbsent } from '../../src/utils/atomicFile.js'
import { getClaudeConfigHomeDir } from '../../src/utils/envUtils.js'
import { lock } from '../../src/utils/lockfile.js'

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SLOT_PREFIX = 'send-'
const CHECKPOINT_REVISION = /^checkpoint-([1-9]\d*)\.json$/

export function evaluationIdFromReport(report: unknown): string {
  const id = report && typeof report === 'object' && 'evaluationId' in report ? report.evaluationId : undefined
  if (typeof id !== 'string' || !RUN_ID.test(id)) {
    throw new Error('This report predates durable request accounting and cannot safely resume')
  }
  return id
}

/** The original report remains a resume handle. Progress and budget live under
 * a shared, per-run ID so copies and stale reports observe the same state. */
export async function openEvaluationLedger(id: string | undefined, verifyOnly: boolean) {
  const runId = id ?? randomUUID()
  const directory = join(getClaudeConfigHomeDir(), 'auto-mode-evaluations', runId)
  const resumePath = join(directory, 'checkpoint.json')
  const checkpointPath = (revision: number) => revision === 0
    ? resumePath
    : join(directory, `checkpoint-${revision}.json`)
  if (id && !(await Bun.file(resumePath).exists())) throw new Error('Durable evaluation checkpoint unavailable in this configuration directory')
  if (!id) await mkdir(directory, { recursive: true, mode: 0o700 })
  let leaseError: Error | undefined
  const release = verifyOnly ? undefined : await lock(directory, {
    realpath: true, stale: 10_000, update: 2_000,
    onCompromised(error) { leaseError = error },
  })
  const assertLease = () => {
    if (verifyOnly) throw new Error('Verification cannot mutate an evaluation ledger')
    if (leaseError) throw new Error('Evaluation ownership was lost', { cause: leaseError })
  }
  const countReservations = (entries: readonly string[]) => entries.filter(entry => /^send-[1-9]\d*$/.test(entry)).length
  let used = 0
  try { used = countReservations(await readdir(directory)) }
  catch (error) { await release?.(); throw error }
  let revision = id ? 0 : -1
  return {
    id: runId,
    path: resumePath,
    get reservedBackendSends() { return used },
    close: async () => { await release?.() },
    async readCheckpoint(): Promise<unknown> {
      let unreadable: { revision: number; error: unknown } | undefined
      for (;;) {
        const entries = await readdir(directory)
        const latest = entries.reduce((max, entry) => {
          const entryRevision = Number(CHECKPOINT_REVISION.exec(entry)?.[1])
          return Number.isSafeInteger(entryRevision) ? Math.max(max, entryRevision) : max
        }, 0)
        if (unreadable && latest <= unreadable.revision) throw unreadable.error
        let report: unknown
        try {
          report = await Bun.file(checkpointPath(latest)).json()
        } catch (error) {
          // A reader can race with cleanup of a superseded checkpoint. Only
          // retry when a newer revision exists; reject a corrupt latest file.
          unreadable = { revision: latest, error }
          continue
        }
        revision = latest
        if (verifyOnly) used = countReservations(await readdir(directory))
        return report
      }
    },
    async saveCheckpoint(report: object) {
      assertLease()
      const next = revision + 1
      // Never advance from a competing writer's progress. Even a process
      // paused past a lease takeover can only publish its exact next revision.
      const published = await writeFileAtomicDurableIfAbsent(checkpointPath(next), JSON.stringify(report), { mode: 0o600 })
      if (!published) throw new Error('Evaluation checkpoint advanced during a lease change; resume again')
      revision = next
      // Keep occupied revision names as fences. Only the two newest reports
      // need their bodies, plus the original resume handle for compatibility.
      if (next > 2) await truncate(checkpointPath(next - 2), 0).catch(() => {})
    },
    async reserveBackendSend(maxRequests: number) {
      for (let slot = used + 1; slot <= maxRequests; slot++) {
        assertLease()
        // Exclusive durable publication prevents duplicate claims even if a
        // process pauses long enough to lose its lease during this operation.
        const claimed = await writeFileAtomicDurableIfAbsent(join(directory, `${SLOT_PREFIX}${slot}`), '', { mode: 0o600 })
        used = Math.max(used, slot)
        if (claimed) return
      }
      throw new Error('Authorized backend send limit reached')
    },
  }
}
