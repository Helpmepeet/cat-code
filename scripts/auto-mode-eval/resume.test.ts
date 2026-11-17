import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { EVIDENCE_CASES } from './cases.js'
import { prepareResume, verifyRetainedRequest } from './resume.js'

const fixtureCase = EVIDENCE_CASES.find(c => c.id === 'ordinary-build')!
const identity = { reference: 'fixture-reference', alias: 'fixture-main', idPrefix: 'fixture-' }
const sample = { id: fixtureCase.id, expect: fixtureCase.expect, variant: 'full' as const, repeat: 0,
  shouldBlock: true, unavailable: false, invalid: false, model: 'gpt-6-luna', requestedModel: 'gpt-6-luna', durationMs: 777 }
const evidence = { id: fixtureCase.id, variant: 'full' as const, stages: 1, requestedModels: ['gpt-6-luna'],
  stageChars: [100], digests: ['a'.repeat(64)], missing: [], unexpected: [] }
const digest = (cases: unknown) => createHash('sha256').update(JSON.stringify(cases)).digest('hex')
const expected = { cases: [fixtureCase], repeats: 1, model: 'gpt-6-luna', account: identity, maxRequests: 4, corpusDigest: digest([fixtureCase]) }
const report = () => ({ schema: 1, mode: 'live', cases: 1, repeats: 1, model: 'gpt-6-luna', account: identity,
  backendSends: 3, reviewerRequestsAttempted: 3, stoppedEarly: 'connection reset', transportFailures: [{ code: 'ECONNRESET' }],
  authorizedMaxRequests: 4, corpusDigest: digest([fixtureCase]), caseManifest: [{ id: fixtureCase.id, expect: fixtureCase.expect }],
  samples: [sample, { ...sample, variant: 'reduced', unavailable: true, model: 'sonnet' }],
  evidence: [evidence, { ...evidence, variant: 'reduced' }] })

test('resume preserves evaluated wrong decisions and retries only unavailable or missing samples within the remaining cap', () => {
  const plan = prepareResume(report(), expected)
  expect(plan).toMatchObject({ pending: 1, remainingRequests: 1, priorBackendSends: 3, priorAttempts: 3 })
  const retained = [...plan.retained.values()]
  expect(retained).toHaveLength(1)
  expect(retained[0]!.sample).toMatchObject({ shouldBlock: true, durationMs: 777 })
  expect(plan.resumeHistory[0]).toMatchObject({ addedCaseIds: [], failedSamples: [{ sample: { unavailable: true } }] })
  verifyRetainedRequest(retained[0]!, ['a'.repeat(64), 'b'.repeat(64)])
  expect(() => verifyRetainedRequest(retained[0]!, ['c'.repeat(64)])).toThrow('policy or request changed')
})

test('resume accepts only additive corpus extensions with identical prior case bodies, labels and order', () => {
  const newCase = { ...fixtureCase, id: 'new-independent-control', because: 'Additional synthetic coverage.' }
  const extended = { ...expected, cases: [fixtureCase, newCase], corpusDigest: digest([fixtureCase, newCase]) }
  const plan = prepareResume(report(), extended)
  expect(plan).toMatchObject({ remainingRequests: 1, pending: 3, addedCaseIds: ['new-independent-control'] })
  expect(plan.retained.size).toBe(1)
  expect(plan.resumeHistory[0]).toMatchObject({ previousCases: 1, currentCases: 2, addedCaseIds: ['new-independent-control'] })
  for (const changed of [
    { ...extended, cases: [{ ...fixtureCase, because: 'Changed historical body.' }, newCase], corpusDigest: digest([{ ...fixtureCase, because: 'Changed historical body.' }, newCase]) },
    { ...extended, cases: [{ ...fixtureCase, expect: 'block' as const }, newCase], corpusDigest: digest([{ ...fixtureCase, expect: 'block' }, newCase]) },
    { ...extended, cases: [newCase], corpusDigest: digest([newCase]) },
  ]) expect(() => prepareResume(report(), changed)).toThrow()
  for (const changed of [
    { ...report(), caseManifest: undefined }, { ...report(), corpusDigest: undefined },
    { ...report(), cases: 2 }, { ...report(), caseManifest: [report().caseManifest[0], report().caseManifest[0]], cases: 2 },
  ]) expect(() => prepareResume(changed, extended)).toThrow()
  const oldBoth = { ...report(), cases: 2, caseManifest: [report().caseManifest[0], { id: newCase.id, expect: newCase.expect }],
    corpusDigest: digest([fixtureCase, newCase]) }
  expect(() => prepareResume(oldBoth, { ...extended, cases: [newCase, fixtureCase], corpusDigest: digest([newCase, fixtureCase]) })).toThrow()
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
