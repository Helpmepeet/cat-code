import { z } from 'zod/v4'
import { createHash } from 'node:crypto'
import type { EvidenceCase } from './cases.js'
import { isEvaluated, type VerdictSample } from './grade.js'

const sampleSchema = z.object({ id: z.string(), expect: z.enum(['allow', 'block']), variant: z.enum(['full', 'reduced']),
  repeat: z.number().int().nonnegative(), shouldBlock: z.boolean(), unavailable: z.boolean(), invalid: z.boolean(),
  model: z.string(), requestedModel: z.string(), durationMs: z.number().finite().nonnegative(), error: z.string().optional(),
  reason: z.string().max(600).optional(), stageDecisions: z.array(z.union([
    z.object({ stage: z.enum(['fast', 'thinking']), shouldBlock: z.boolean(), reason: z.string().max(600).optional() }),
    z.object({ stage: z.enum(['fast', 'thinking']), failure: z.enum(['unavailable', 'invalid_response', 'context_limit', 'interrupted']) }),
  ])).max(2).optional() })
const evidenceSchema = z.object({ id: z.string(), variant: z.enum(['full', 'reduced']), repeat: z.number().int().nonnegative().optional(),
  stages: z.number().int().nonnegative(), requestedModels: z.array(z.string()), stageChars: z.array(z.number().int().nonnegative()),
  digests: z.array(z.string().regex(/^[a-f0-9]{64}$/)), missing: z.array(z.string()), unexpected: z.array(z.string()),
  components: z.array(z.object({ instructionsChars: z.number().int().nonnegative(), historyChars: z.number().int().nonnegative(),
    instructionsDigest: z.string().regex(/^[a-f0-9]{64}$/), historyDigest: z.string().regex(/^[a-f0-9]{64}$/) })).optional() })
export type EvidenceRecord = z.infer<typeof evidenceSchema> & { repeat: number }
const reportSchema = z.object({ schema: z.literal(1), mode: z.literal('live'), cases: z.number().int().positive(),
  repeats: z.number().int().positive(), model: z.string(),
  account: z.object({ reference: z.string(), alias: z.string().nullable(), idPrefix: z.string() }),
  backendSends: z.number().int().nonnegative(), reviewerRequestsAttempted: z.number().int().nonnegative(),
  samples: z.array(sampleSchema), evidence: z.array(evidenceSchema), transportFailures: z.array(z.unknown()),
  stoppedEarly: z.string().nullable(), authorizedMaxRequests: z.number().int().positive(),
  corpusDigest: z.string().regex(/^[a-f0-9]{64}$/), caseManifest: z.array(z.object({ id: z.string(), expect: z.enum(['allow', 'block']) })).min(1),
  resumeHistory: z.array(z.unknown()).optional() })

export function sampleKey(sample: Pick<VerdictSample, 'id' | 'repeat' | 'variant'>): string {
  return `${sample.id}/${sample.repeat}/${sample.variant}`
}

/** A valid wrong decision is retained too; retries must never select for better scores. */
export function prepareResume(value: unknown, expected: {
  cases: readonly EvidenceCase[]; repeats: number; model: string; account: { reference: string; alias: string | null; idPrefix: string };
  maxRequests: number; corpusDigest: string; reservedBackendSends?: number
}) {
  const report = reportSchema.parse(value)
  const cases = new Map(expected.cases.map(c => [c.id, c]))
  const indexes = new Map(expected.cases.map((c, index) => [c.id, index]))
  if (cases.size !== expected.cases.length) throw new Error('Current corpus contains duplicate case IDs')
  if (report.model !== expected.model) throw new Error('Resume model does not match the authorized model')
  if (JSON.stringify(report.account) !== JSON.stringify(expected.account)) throw new Error('Resume account identity does not match the authorized account')
  if (report.cases !== report.caseManifest.length || report.repeats !== expected.repeats) throw new Error('Resume case count or repeats do not match')
  const previousIds = new Set<string>()
  const previousCases: EvidenceCase[] = []
  let previousIndex = -1
  for (const entry of report.caseManifest) {
    const testCase = cases.get(entry.id), index = indexes.get(entry.id)
    if (!testCase || index === undefined || index <= previousIndex || previousIds.has(entry.id) || testCase.expect !== entry.expect) {
      throw new Error('Resume corpus must preserve all prior case IDs, labels and order')
    }
    previousIndex = index
    previousIds.add(entry.id)
    previousCases.push(testCase)
  }
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  if (digest(previousCases) !== report.corpusDigest || digest(expected.cases) !== expected.corpusDigest) throw new Error('Resume prior case bodies changed')
  const addedCaseIds = expected.cases.filter(c => !previousIds.has(c.id)).map(c => c.id)
  if (report.authorizedMaxRequests !== expected.maxRequests) throw new Error('Resume authorization limit changed')
  if (report.backendSends > expected.maxRequests || report.backendSends > report.reviewerRequestsAttempted) throw new Error('Resume request accounting is invalid')
  const reservedBackendSends = expected.reservedBackendSends ?? report.backendSends
  if (reservedBackendSends < report.backendSends || reservedBackendSends > expected.maxRequests) throw new Error('Durable request accounting is invalid')
  if (report.samples.length !== report.evidence.length) throw new Error('Resume samples and evidence are not aligned')
  const retained = new Map<string, { sample: VerdictSample; evidence: EvidenceRecord }>()
  const failed: { sample: VerdictSample; evidence: EvidenceRecord }[] = []
  const seen = new Set<string>()
  for (let i = 0; i < report.samples.length; i++) {
    const sample = report.samples[i]!
    const evidence = { ...report.evidence[i]!, repeat: report.evidence[i]!.repeat ?? sample.repeat }
    const testCase = cases.get(sample.id)
    const key = sampleKey(sample)
    if (!testCase || !previousIds.has(sample.id) || sample.expect !== testCase.expect || sample.repeat >= expected.repeats || sample.requestedModel !== expected.model) throw new Error('Resume sample identity or label is invalid')
    if (seen.has(key)) throw new Error('Resume contains a duplicate sample')
    seen.add(key)
    if (evidence.id !== sample.id || evidence.variant !== sample.variant || evidence.repeat !== sample.repeat ||
      evidence.stages !== evidence.digests.length || evidence.stages !== evidence.stageChars.length || evidence.stages !== evidence.requestedModels.length) throw new Error('Resume evidence does not match its sample')
    if (isEvaluated(sample)) {
      if (sample.model !== expected.model || evidence.stages === 0 || evidence.missing.length || evidence.unexpected.length ||
        evidence.requestedModels.some(model => model !== expected.model)) throw new Error('Resume evaluated sample has invalid model or evidence')
      retained.set(key, { sample, evidence })
    } else failed.push({ sample, evidence })
  }
  const pending = expected.cases.length * expected.repeats * 2 - retained.size
  const remainingRequests = expected.maxRequests - reservedBackendSends
  if (pending && remainingRequests === 0) throw new Error('No authorized backend sends remain for unfinished cases')
  return { retained, pending, remainingRequests, addedCaseIds, priorBackendSends: report.backendSends, priorAttempts: report.reviewerRequestsAttempted,
    priorTransportFailures: report.transportFailures,
    resumeHistory: [...(report.resumeHistory ?? []), { backendSends: report.backendSends, reviewerRequestsAttempted: report.reviewerRequestsAttempted,
      stoppedEarly: report.stoppedEarly, transportFailures: report.transportFailures, failedSamples: failed,
      previousCases: report.cases, currentCases: expected.cases.length, addedCaseIds }] }
}

export function verifyRetainedRequest(record: { sample: VerdictSample; evidence: EvidenceRecord }, currentDigests: readonly string[]): void {
  if (record.evidence.digests.length > currentDigests.length ||
    record.evidence.digests.some((digest, index) => digest !== currentDigests[index])) {
    throw new Error(`Resume policy or request changed for ${sampleKey(record.sample)}`)
  }
}
