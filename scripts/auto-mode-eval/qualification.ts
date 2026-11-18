import { z } from 'zod/v4'
import type { EvidenceCase } from './cases.js'
import { sampleKey, type EvidenceRecord } from './resume.js'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const recordSchema = z.object({ schema: z.literal(1), model: z.string().startsWith('gpt-'), corpusDigest: digest, policyDigest: digest,
  repeats: z.number().int().min(1).max(10), requests: z.array(z.object({ id: z.string(), variant: z.enum(['full', 'reduced']),
    repeat: z.number().int().nonnegative(), shouldBlock: z.boolean(), digests: z.array(digest).min(1).max(2) })) })

export function parseQualification(value: unknown) {
  return value === null ? null : recordSchema.parse(value)
}

export function verifyQualification(record: NonNullable<ReturnType<typeof parseQualification>>, expected: {
  cases: readonly EvidenceCase[]; corpusDigest: string; policyDigest: string; evidence: readonly EvidenceRecord[]
}) {
  if (record.corpusDigest !== expected.corpusDigest || record.policyDigest !== expected.policyDigest ||
    record.requests.length !== expected.cases.length * record.repeats * 2) throw new Error('Auto Mode reduction qualification is stale or incomplete')
  const evaluated = new Set<string>()
  const cases = new Map(expected.cases.map(testCase => [testCase.id, testCase]))
  const currentEvidence = new Map(expected.evidence.map(record => [sampleKey(record), record]))
  for (const sample of record.requests) {
    const key = sampleKey(sample)
    const testCase = cases.get(sample.id)
    // Offline captures both possible stages; a valid fast allow uses only the
    // first. Every evaluated stage must still have precisely the same digest.
    const evidence = currentEvidence.get(sampleKey({ ...sample, repeat: 0 }))
    if (!testCase || evaluated.has(key) || sample.repeat >= record.repeats || sample.shouldBlock !== (testCase.expect === 'block') ||
      (sample.shouldBlock && sample.digests.length !== 2) || !evidence || evidence.missing.length || evidence.unexpected.length ||
      evidence.requestedModels.some(model => model !== record.model) ||
      sample.digests.some((hash, index) => hash !== evidence.digests[index])) {
      throw new Error(`Auto Mode reduction qualification changed for ${key}`)
    }
    evaluated.add(key)
  }
}
