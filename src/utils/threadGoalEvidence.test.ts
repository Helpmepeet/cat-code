import { describe, expect, test } from 'bun:test'
import {
  appendThreadGoalEvidence,
  evaluateThreadGoalCompletion,
  evaluateThreadGoalCriteria,
  hashThreadGoalContract,
  MAX_THREAD_GOAL_EVIDENCE,
  parseThreadGoalContract,
  parseThreadGoalEvidence,
  type ThreadGoalContract,
  type ThreadGoalEvidence,
} from './threadGoalEvidence.js'
import {
  UNKNOWN_WORKSPACE_EVIDENCE_TTL_MS,
  UNKNOWN_WORKSPACE_FINGERPRINT,
} from './threadGoalWorkspace.js'

const DIGEST = 'contract-digest-1'
const FINGERPRINT = 'workspace-abc'

function contract(
  overrides: Partial<ThreadGoalContract> = {},
): ThreadGoalContract {
  return {
    criteria: [
      { id: 'tests', description: 'the suite passes', required: true },
      { id: 'docs', description: 'the map is updated', required: false },
    ],
    constraints: [],
    boundaries: [],
    stopConditions: [],
    ...overrides,
  }
}

function evidence(
  overrides: Partial<ThreadGoalEvidence> = {},
): ThreadGoalEvidence {
  return {
    evidenceId: 'ev-1',
    source: 'command',
    sourceDigest: 'cmd-digest-1',
    label: 'test suite',
    sessionId: 'session-1',
    contractDigest: DIGEST,
    workspaceFingerprint: FINGERPRINT,
    outcome: 'pass',
    exitCode: 0,
    outputDigest: 'out-1',
    recordedAtMs: 1_000,
    coversCriterionIds: ['tests'],
    ...overrides,
  }
}

describe('the completion gate', () => {
  test('a goal with no required criteria is not gated', () => {
    // Additive: a goal created from a plain objective must keep behaving as it
    // did, or this retroactively blocks goals already in flight.
    const check = evaluateThreadGoalCompletion({
      contract: contract({ criteria: [] }),
      evidence: [],
      contractDigest: DIGEST,
      workspaceFingerprint: FINGERPRINT,
    })
    expect(check).toEqual({
      allowed: true,
      reason: 'no_contract',
      criterionIds: [],
    })
  })

  test('a red required gate blocks completion', () => {
    const check = evaluateThreadGoalCompletion({
      contract: contract(),
      evidence: [evidence({ outcome: 'fail', exitCode: 1 })],
      contractDigest: DIGEST,
      workspaceFingerprint: FINGERPRINT,
    })
    expect(check.allowed).toBe(false)
    expect(check).toMatchObject({
      reason: 'required_gate_failed',
      criterionIds: ['tests'],
    })
  })

  test('a required criterion with no evidence stays unverified and blocks', () => {
    const check = evaluateThreadGoalCompletion({
      contract: contract(),
      evidence: [],
      contractDigest: DIGEST,
      workspaceFingerprint: FINGERPRINT,
    })
    expect(check).toMatchObject({
      allowed: false,
      reason: 'unverified_criteria',
      criterionIds: ['tests'],
    })
  })

  test('a green gate proves only the criteria it covers', () => {
    const check = evaluateThreadGoalCompletion({
      contract: contract({
        criteria: [
          { id: 'tests', description: 'suite passes', required: true },
          { id: 'deploy', description: 'deployed', required: true },
        ],
      }),
      // Passes, but says nothing about `deploy`.
      evidence: [evidence({ coversCriterionIds: ['tests'] })],
      contractDigest: DIGEST,
      workspaceFingerprint: FINGERPRINT,
    })
    expect(check).toMatchObject({
      allowed: false,
      reason: 'unverified_criteria',
      criterionIds: ['deploy'],
    })
  })

  test('claiming coverage of a criterion that does not exist proves nothing', () => {
    // The maker's only influence is `coversCriterionIds`, and it is
    // intersected with the contract rather than trusted.
    const check = evaluateThreadGoalCompletion({
      contract: contract(),
      evidence: [
        evidence({ coversCriterionIds: ['tests-but-not-really', 'everything'] }),
      ],
      contractDigest: DIGEST,
      workspaceFingerprint: FINGERPRINT,
    })
    expect(check).toMatchObject({
      allowed: false,
      reason: 'unverified_criteria',
      criterionIds: ['tests'],
    })
  })

  test('all required criteria proven allows completion', () => {
    const check = evaluateThreadGoalCompletion({
      contract: contract(),
      evidence: [evidence()],
      contractDigest: DIGEST,
      workspaceFingerprint: FINGERPRINT,
    })
    expect(check).toEqual({
      allowed: true,
      reason: 'all_required_proven',
      criterionIds: [],
    })
  })

  test('an optional criterion never blocks completion', () => {
    const check = evaluateThreadGoalCompletion({
      contract: contract(),
      evidence: [
        evidence(),
        evidence({
          evidenceId: 'ev-2',
          outcome: 'fail',
          coversCriterionIds: ['docs'],
        }),
      ],
      contractDigest: DIGEST,
      workspaceFingerprint: FINGERPRINT,
    })
    expect(check.allowed).toBe(true)
  })
})

describe('evidence freshness', () => {
  test('evidence for a different contract cannot complete the new one', () => {
    // The objective or criteria changed under it, so a green result recorded
    // against the old contract proves nothing about this one.
    const check = evaluateThreadGoalCompletion({
      contract: contract(),
      evidence: [evidence({ contractDigest: 'an-older-contract' })],
      contractDigest: DIGEST,
      workspaceFingerprint: FINGERPRINT,
    })
    expect(check).toMatchObject({
      allowed: false,
      reason: 'unverified_criteria',
    })
  })

  test('evidence from a different workspace state is stale', () => {
    const check = evaluateThreadGoalCompletion({
      contract: contract(),
      evidence: [evidence({ workspaceFingerprint: 'workspace-moved' })],
      contractDigest: DIGEST,
      workspaceFingerprint: FINGERPRINT,
    })
    expect(check).toMatchObject({
      allowed: false,
      reason: 'unverified_criteria',
    })
  })

  test('the newest fresh record decides, so a later green supersedes a red', () => {
    const states = evaluateThreadGoalCriteria({
      contract: contract(),
      evidence: [
        evidence({ evidenceId: 'ev-red', outcome: 'fail', recordedAtMs: 1_000 }),
        evidence({ evidenceId: 'ev-green', outcome: 'pass', recordedAtMs: 2_000 }),
      ],
      contractDigest: DIGEST,
      workspaceFingerprint: FINGERPRINT,
    })
    expect(states.find(s => s.criterion.id === 'tests')!.verdict).toBe('proven')
  })

  test('a later red supersedes an earlier green', () => {
    const states = evaluateThreadGoalCriteria({
      contract: contract(),
      evidence: [
        evidence({ evidenceId: 'ev-green', outcome: 'pass', recordedAtMs: 1_000 }),
        evidence({ evidenceId: 'ev-red', outcome: 'fail', recordedAtMs: 2_000 }),
      ],
      contractDigest: DIGEST,
      workspaceFingerprint: FINGERPRINT,
    })
    expect(states.find(s => s.criterion.id === 'tests')!.verdict).toBe('failed')
  })

  test('a contract digest changes when the objective changes', () => {
    const c = contract()
    expect(hashThreadGoalContract('ship it', c)).toBe(
      hashThreadGoalContract('ship it', c),
    )
    expect(hashThreadGoalContract('ship it', c)).not.toBe(
      hashThreadGoalContract('ship something else', c),
    )
    expect(hashThreadGoalContract('ship it', c)).not.toBe(
      hashThreadGoalContract(
        'ship it',
        contract({
          criteria: [{ id: 'tests', description: 'changed', required: true }],
        }),
      ),
    )
  })
})

describe('evidence recorded where git cannot report freshness', () => {
  // UNKNOWN_WORKSPACE_FINGERPRINT is one constant for every workspace state,
  // so matching it proves only that git could not answer then and cannot
  // answer now. Without a time bound a single pass satisfied the gate forever.
  const unknown = (recordedAtMs: number) =>
    evidence({
      workspaceFingerprint: UNKNOWN_WORKSPACE_FINGERPRINT,
      coversCriterionIds: ['tests'],
      recordedAtMs,
    })

  test('a fresh record still completes, so a non-git workspace stays usable', () => {
    const check = evaluateThreadGoalCompletion({
      contract: contract(),
      evidence: [unknown(1_000)],
      contractDigest: DIGEST,
      workspaceFingerprint: UNKNOWN_WORKSPACE_FINGERPRINT,
      nowMs: 1_000 + UNKNOWN_WORKSPACE_EVIDENCE_TTL_MS - 1,
    })
    expect(check.allowed).toBe(true)
  })

  test('the same record expires, rather than proving the criterion forever', () => {
    const check = evaluateThreadGoalCompletion({
      contract: contract(),
      evidence: [unknown(1_000)],
      contractDigest: DIGEST,
      workspaceFingerprint: UNKNOWN_WORKSPACE_FINGERPRINT,
      nowMs: 1_000 + UNKNOWN_WORKSPACE_EVIDENCE_TTL_MS + 1,
    })
    expect(check.allowed).toBe(false)
    expect(check.reason).toBe('unverified_criteria')
  })

  test('a real git fingerprint is compared exactly and never ages out', () => {
    const check = evaluateThreadGoalCompletion({
      contract: contract(),
      evidence: [evidence({ coversCriterionIds: ['tests'], recordedAtMs: 1 })],
      contractDigest: DIGEST,
      workspaceFingerprint: FINGERPRINT,
      nowMs: 1 + UNKNOWN_WORKSPACE_EVIDENCE_TTL_MS * 1000,
    })
    expect(check.allowed).toBe(true)
  })
})

describe('persistence', () => {
  test('the ledger stays bounded, dropping oldest first', () => {
    let ledger: ThreadGoalEvidence[] = []
    for (let i = 0; i < MAX_THREAD_GOAL_EVIDENCE + 5; i++) {
      ledger = appendThreadGoalEvidence(
        ledger,
        evidence({ evidenceId: `ev-${i}`, recordedAtMs: i }),
      )
    }
    expect(ledger).toHaveLength(MAX_THREAD_GOAL_EVIDENCE)
    expect(ledger[0]!.evidenceId).toBe('ev-5')
  })

  test('an unreadable criterion defaults to required', () => {
    // A criterion that silently became optional is how a gate stops gating.
    const parsed = parseThreadGoalContract({
      criteria: [
        { id: 'a', description: 'x', required: 'yes-please' },
        { id: 'b', description: 'y', required: false },
        { id: 'c' },
      ],
    })
    expect(parsed.criteria).toHaveLength(2)
    expect(parsed.criteria[0]).toEqual({
      id: 'a',
      description: 'x',
      required: true,
    })
    expect(parsed.criteria[1]!.required).toBe(false)
  })

  test('malformed evidence is dropped rather than half-read', () => {
    const parsed = parseThreadGoalEvidence([
      evidence(),
      { evidenceId: 'broken' },
      { ...evidence({ evidenceId: 'ev-bad-outcome' }), outcome: 'maybe' },
      null,
    ])
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.evidenceId).toBe('ev-1')
  })

  test('evidence round-trips through JSON', () => {
    const record = evidence()
    expect(parseThreadGoalEvidence(JSON.parse(JSON.stringify([record])))).toEqual([
      record,
    ])
  })
})
