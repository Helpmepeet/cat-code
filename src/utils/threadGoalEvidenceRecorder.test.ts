import { describe, expect, test } from 'bun:test'
import { createThreadGoal, type ThreadGoal } from './threadGoal.js'
import { recordThreadGoalCommandEvidence } from './threadGoalEvidenceRecorder.js'
import {
  evaluateThreadGoalCompletion,
  hashThreadGoalContract,
} from './threadGoalEvidence.js'
import { getThreadGoalWorkspaceFingerprint } from './threadGoalWorkspace.js'

function gatedGoal(verifyCommand = 'bun test app/'): ThreadGoal {
  const base = createThreadGoal('session-1', 'ship it', undefined, 100)
  return {
    ...base,
    contract: {
      criteria: [
        {
          id: 'tests',
          description: 'the suite passes',
          required: true,
          verifyCommand,
        },
      ],
      constraints: [],
      boundaries: [],
      stopConditions: [],
    },
  }
}

function recorder(goal: ThreadGoal | null) {
  let saved: ThreadGoal | null = null
  return {
    run: (outcome: {
      command: string
      exitCode: number
      interrupted?: boolean
      output?: string
    }) =>
      recordThreadGoalCommandEvidence({
        goal,
        outcome: {
          command: outcome.command,
          exitCode: outcome.exitCode,
          interrupted: outcome.interrupted ?? false,
          output: outcome.output ?? '',
        },
        saveGoal: next => {
          saved = next
        },
        now: () => 500,
      }),
    getSaved: () => saved,
  }
}

describe('recording command evidence', () => {
  test('a matching command that exits zero proves its criterion', async () => {
    const r = recorder(gatedGoal())
    const record = await r.run({ command: 'bun test app/', exitCode: 0 })

    expect(record).not.toBeNull()
    expect(record!.outcome).toBe('pass')
    expect(record!.coversCriterionIds).toEqual(['tests'])
    expect(r.getSaved()!.evidence).toHaveLength(1)
  })

  test('the exit code decides, so a failing run records a red', async () => {
    const r = recorder(gatedGoal())
    const record = await r.run({ command: 'bun test app/', exitCode: 1 })

    expect(record!.outcome).toBe('fail')
    expect(record!.exitCode).toBe(1)
  })

  test('a command nobody bound to a criterion records nothing', async () => {
    // This is the anti-forgery property: the maker cannot run `true` and have
    // it count, because coverage comes from the user's contract, not a claim.
    const r = recorder(gatedGoal())
    expect(await r.run({ command: 'true', exitCode: 0 })).toBeNull()
    expect(await r.run({ command: 'echo tests pass', exitCode: 0 })).toBeNull()
    expect(r.getSaved()).toBeNull()
  })

  test('whitespace differences still match the declared command', async () => {
    const r = recorder(gatedGoal('bun test app/'))
    const record = await r.run({ command: '  bun   test   app/  ', exitCode: 0 })
    expect(record).not.toBeNull()
  })

  test('an interrupted command proves nothing either way', async () => {
    // A stray ctrl-c must not mark a criterion red.
    const r = recorder(gatedGoal())
    expect(
      await r.run({ command: 'bun test app/', exitCode: 130, interrupted: true }),
    ).toBeNull()
    expect(r.getSaved()).toBeNull()
  })

  test('a session with no gated goal does no work', async () => {
    const plain = createThreadGoal('session-1', 'no criteria here', undefined, 100)
    expect(await recorder(plain).run({ command: 'bun test app/', exitCode: 0 })).toBeNull()
    expect(await recorder(null).run({ command: 'bun test app/', exitCode: 0 })).toBeNull()
  })

  test('raw output is never persisted, only its digest', async () => {
    const r = recorder(gatedGoal())
    const secret = 'ANTHROPIC_API_KEY=sk-should-never-be-stored'
    const record = await r.run({
      command: 'bun test app/',
      exitCode: 0,
      output: secret,
    })

    expect(JSON.stringify(record)).not.toContain('sk-should-never-be-stored')
    expect(record!.outputDigest).not.toContain(secret)
    expect(record!.outputDigest.length).toBeGreaterThan(0)
  })

  test('a failing command records a red verdict, not nothing', async () => {
    // BashTool throws on any non-zero exit. When the seam sat after that
    // throw, a failing check wrote NOTHING, so the gate refused with "no
    // evidence yet" instead of "this check is failing", and the
    // don't-rerun-a-red-gate path could never fire.
    const r = recorder(gatedGoal())
    const record = await r.run({ command: 'bun test app/', exitCode: 1 })

    expect(record).not.toBeNull()
    expect(record!.outcome).toBe('fail')
    expect(r.getSaved()!.evidence).toHaveLength(1)
  })

  test('evidence is visible to the gate through the store the gate reads', async () => {
    // The seam that was broken: the recorder persisted durably while the gate
    // read app state, so a passing check was invisible and then clobbered.
    // This mirrors the BashTool saveGoal, which writes BOTH.
    const goal = gatedGoal()
    let durable: ThreadGoal | null = null
    let appState: ThreadGoal | null = goal

    await recordThreadGoalCommandEvidence({
      goal: appState,
      outcome: {
        command: 'bun test app/',
        exitCode: 0,
        interrupted: false,
        output: '',
      },
      saveGoal: next => {
        durable = next
        appState = next
      },
      now: () => 500,
    })

    expect(durable).not.toBeNull()
    expect(appState!.evidence).toHaveLength(1)
    // Both stores agree, which is what stops the next accounting write from
    // spreading an empty ledger back over the durable record.
    expect(appState!.evidence).toEqual(durable!.evidence)

    const fingerprint = await getThreadGoalWorkspaceFingerprint()
    expect(
      evaluateThreadGoalCompletion({
        contract: appState!.contract,
        evidence: appState!.evidence,
        contractDigest: hashThreadGoalContract(goal.objective, goal.contract),
        workspaceFingerprint: fingerprint,
      }),
    ).toMatchObject({ allowed: true, reason: 'all_required_proven' })
  })

  test('a recorded pass actually unblocks the completion gate', async () => {
    // End to end: run the user's command, and the gate that previously refused
    // completion now allows it. Proves the ledger and the gate agree.
    const goal = gatedGoal()
    const fingerprint = await getThreadGoalWorkspaceFingerprint()
    const digest = hashThreadGoalContract(goal.objective, goal.contract)

    expect(
      evaluateThreadGoalCompletion({
        contract: goal.contract,
        evidence: goal.evidence,
        contractDigest: digest,
        workspaceFingerprint: fingerprint,
      }),
    ).toMatchObject({ allowed: false, reason: 'unverified_criteria' })

    const r = recorder(goal)
    await r.run({ command: 'bun test app/', exitCode: 0 })

    expect(
      evaluateThreadGoalCompletion({
        contract: goal.contract,
        evidence: r.getSaved()!.evidence,
        contractDigest: digest,
        workspaceFingerprint: fingerprint,
      }),
    ).toMatchObject({ allowed: true, reason: 'all_required_proven' })
  })
})
