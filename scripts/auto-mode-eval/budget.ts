import { randomUUID } from 'node:crypto'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomicDurable, writeFileAtomicDurableIfAbsent } from '../../src/utils/atomicFile.js'
import { getClaudeConfigHomeDir } from '../../src/utils/envUtils.js'
import { lock } from '../../src/utils/lockfile.js'

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SLOT_PREFIX = 'send-'

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
  const checkpoint = Bun.file(join(directory, 'checkpoint.json'))
  if (id && !(await checkpoint.exists())) throw new Error('Durable evaluation checkpoint unavailable in this configuration directory')
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
  let used = 0
  try { used = (await readdir(directory)).filter(entry => /^send-[1-9]\d*$/.test(entry)).length }
  catch (error) { await release?.(); throw error }
  return {
    id: runId,
    path: checkpoint.name!,
    get reservedBackendSends() { return used },
    close: async () => { await release?.() },
    readCheckpoint: () => checkpoint.json(),
    async saveCheckpoint(report: object) {
      assertLease()
      await writeFileAtomicDurable(checkpoint.name!, JSON.stringify(report), { mode: 0o600 })
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
