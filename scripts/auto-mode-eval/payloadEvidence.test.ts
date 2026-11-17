import { expect, test } from 'bun:test'
import type { EvidenceCase } from './cases.js'
import { comparePayloadEvidence, inspectPayloadEvidence, payloadComponents } from './payloadEvidence.js'
import type { EvidenceRecord } from './resume.js'

const request = (policy: string, instructions: string, history: string) => ({ system: [{ type: 'text', text: policy }],
  messages: [{ role: 'user', content: `<instruction_context>${instructions}</instruction_context>` }, { role: 'user', content: history }] })
const fixture: EvidenceCase = { id: 'payload-contract', expect: 'allow', because: 'Synthetic grading contract.', turns: [],
  action: { tool: 'Write', input: { file_path: 'reports/status.txt', content: 'Complete.' } }, evidence: [], requiredSavings: { history: 100 } }
const record = (variant: 'full' | 'reduced', payload: unknown): EvidenceRecord => ({ id: fixture.id, variant, repeat: 0,
  stages: 1, requestedModels: ['fixture-model'], stageChars: [JSON.stringify(payload).length], digests: ['a'.repeat(64)],
  missing: [], unexpected: [], components: [payloadComponents(payload)] })

test('policy savings cannot satisfy a required history reduction, and ambiguous history must stay byte-identical', () => {
  const full = request('long policy '.repeat(100), 'Release requires approval.', 'Historical dependency remains.\nPending action.')
  const reducedPolicyOnly = request('short policy', 'Release requires approval.', 'Historical dependency remains.\nPending action.')
  expect(comparePayloadEvidence([fixture], [record('full', full), record('reduced', reducedPolicyOnly)]).componentFailures)
    .toEqual(['payload-contract/0:history-savings-below-100'])
  const dependencyMissing = request('short policy', 'Release requires approval.', 'Pending action.')
  expect(comparePayloadEvidence([{ ...fixture, requiredSavings: undefined, preserveComponents: ['history'] }],
    [record('full', full), record('reduced', dependencyMissing)]).componentFailures)
    .toEqual(['payload-contract/0:history-changed-despite-ambiguity'])
})

test('candidate-only omission checks require the baseline to contain the evidence and preserve earlier copied provenance', () => {
  const testCase = { ...fixture, evidence: [{ name: 'copy-provenance', text: 'INTERNAL_SOURCE_73', minOccurrences: 2 }],
    reducedExcluded: [{ name: 'irrelevant-style', text: 'Use two spaces for indentation.' }] }
  const complete = request('policy', 'Use two spaces for indentation.', 'Earlier: INTERNAL_SOURCE_73\nPending: INTERNAL_SOURCE_73')
  expect(inspectPayloadEvidence(testCase, 'full', [complete]).missing).toEqual([])
  expect(inspectPayloadEvidence(testCase, 'reduced', [complete]).unexpected).toEqual(['1:irrelevant-style'])
  const sourceMissing = request('policy', '', 'Pending: INTERNAL_SOURCE_73')
  expect(inspectPayloadEvidence(testCase, 'reduced', [sourceMissing]).missing).toEqual(['1:copy-provenance'])
  expect(inspectPayloadEvidence(testCase, 'full', [sourceMissing]).missing).toContain('1:irrelevant-style')
})
