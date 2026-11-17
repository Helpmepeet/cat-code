import { expect, test } from 'bun:test'
import { EVIDENCE_CASES } from './cases.js'
import { prepareResume, verifyRetainedRequest } from './resume.js'

const fixtureCase = EVIDENCE_CASES.find(c => c.id === 'ordinary-build')!
const identity = { reference: 'fixture-reference', alias: 'fixture-main', idPrefix: 'fixture-' }
const sample = { id: fixtureCase.id, expect: fixtureCase.expect, variant: 'full' as const, repeat: 0,
  shouldBlock: true, unavailable: false, invalid: false, model: 'gpt-6-luna', requestedModel: 'gpt-6-luna', durationMs: 777 }
const evidence = { id: fixtureCase.id, variant: 'full' as const, stages: 1, requestedModels: ['gpt-6-luna'],
  stageChars: [100], digests: ['a'.repeat(64)], missing: [], unexpected: [] }
const expected = { cases: [fixtureCase], repeats: 1, model: 'gpt-6-luna', account: identity, maxRequests: 4, corpusDigest: 'fixture-corpus' }
const report = () => ({ schema: 1, mode: 'live', cases: 1, repeats: 1, model: 'gpt-6-luna', account: identity,
  backendSends: 3, reviewerRequestsAttempted: 3, stoppedEarly: 'connection reset', transportFailures: [{ code: 'ECONNRESET' }],
  samples: [sample, { ...sample, variant: 'reduced', unavailable: true, model: 'sonnet' }],
  evidence: [evidence, { ...evidence, variant: 'reduced' }] })

test('resume preserves evaluated wrong decisions and retries only unavailable or missing samples within the remaining cap', () => {
  const plan = prepareResume(report(), expected)
  expect(plan).toMatchObject({ pending: 1, remainingRequests: 1, priorBackendSends: 3, priorAttempts: 3 })
  const retained = [...plan.retained.values()]
  expect(retained).toHaveLength(1)
  expect(retained[0]!.sample).toMatchObject({ shouldBlock: true, durationMs: 777 })
  expect(plan.resumeHistory[0]).toMatchObject({ legacyManifest: true, failedSamples: [{ sample: { unavailable: true } }] })
  verifyRetainedRequest(retained[0]!, ['a'.repeat(64), 'b'.repeat(64)])
  expect(() => verifyRetainedRequest(retained[0]!, ['c'.repeat(64)])).toThrow('policy or request changed')
})

test('resume rejects changed identities, labels, policy, repeats, duplicate results and overspent reports before sending', () => {
  for (const changed of [
    { ...report(), model: 'different-model' },
    { ...report(), account: { ...identity, reference: 'different-account' } },
    { ...report(), repeats: 2 },
    { ...report(), corpusDigest: 'different-corpus' },
    { ...report(), caseManifest: [{ id: fixtureCase.id, expect: 'block' }] },
    { ...report(), samples: [{ ...sample, expect: 'block' }], evidence: [evidence] },
    { ...report(), samples: [sample, sample], evidence: [evidence, evidence] },
    { ...report(), backendSends: 5 },
    { ...report(), authorizedMaxRequests: 5 },
    { ...report(), backendSends: 4, reviewerRequestsAttempted: 4 },
  ]) expect(() => prepareResume(changed, expected)).toThrow()
  const complete = { ...report(), backendSends: 4, reviewerRequestsAttempted: 4,
    samples: [sample, { ...sample, variant: 'reduced' }], evidence: [evidence, { ...evidence, variant: 'reduced' }] }
  expect(prepareResume(complete, expected)).toMatchObject({ pending: 0, remainingRequests: 0 })
})
