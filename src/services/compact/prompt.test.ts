import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readSessionState } from '../../agent-mode/sessionState.js'
import {
  getCompactUserSummaryMessage,
  toAgentModeCompactState,
} from './prompt.js'

describe('compact prompt Agent Mode summary', () => {
  test('marks Agent Mode run state as authoritative and keeps resume wording', () => {
    const summary = getCompactUserSummaryMessage(
      '<analysis>draft</analysis><summary>summary prose that should stay secondary</summary>',
      true,
      '/tmp/transcript.jsonl',
      false,
      'openai' as any,
      {
        objective: 'Implement ask_orchestrator.',
        planSummary: 'Add the tool and keep the worker alive.',
        currentPhase: 'executing',
        approvalStatus: 'approved',
        approvalReason: null,
        blockedReason: null,
        executionTarget: 'workspace',
        latestVerifierVerdict: null,
        handoff: {
          summary: 'Keep the same worker alive after the question.',
          open_questions: ['Need the follow-up answer.'],
          resume_hint: 'Resume the same worker session.',
        },
        nextAction: 'continue the same worker',
        sessionState: {
          objective: 'Implement ask_orchestrator.',
          currentPhase: 'executing',
          activeWorker: {
            agentId: 'worker-1',
            role: 'implementor',
            description: 'Implement approved plan',
            status: 'running',
            worktreePath: null,
          },
          knownWorkers: [
            {
              agentId: 'worker-1',
              role: 'implementor',
              description: 'Implement approved plan',
              status: 'running',
              worktreePath: null,
            },
          ],
          nextAction: 'continue the same worker',
        },
      } as any,
    )

    expect(summary).toContain('Agent Mode Run State (authoritative):')
    expect(summary).toContain(
      'The structured Agent Mode run state below is authoritative; the summary below is preserved continuity context only.',
    )
    expect(summary).toContain(
      'Resume directly from the last task. Do not acknowledge the summary, do not recap prior work, and do not ask the user to restate context.',
    )
    expect(summary).toContain('- Objective: Implement ask_orchestrator.')
    expect(summary).toContain('Agent Mode session state:')
    expect(
      summary.indexOf('Agent Mode Run State (authoritative):'),
    ).toBeLessThan(summary.indexOf('Summary:'))
  })

  test('keeps generic compaction wording when no Agent Mode state is present', () => {
    const summary = getCompactUserSummaryMessage(
      '<analysis>draft</analysis><summary>plain summary</summary>',
      true,
      undefined,
      false,
      'openai' as any,
    )

    expect(summary).toContain(
      'This session is continuing after context compaction. The summary below covers the earlier portion of the conversation and should be treated as preserved context for continuing the work.',
    )
    expect(summary).toContain(
      'Continue as if the interruption never happened.',
    )
    expect(summary).not.toContain('Agent Mode Run State (authoritative):')
    expect(summary).not.toContain('Agent Mode session state:')
  })

  test('omits Agent Mode session state when no durable session state is provided', () => {
    const summary = getCompactUserSummaryMessage(
      '<analysis>draft</analysis><summary>summary prose</summary>',
      true,
      undefined,
      undefined,
      'openai',
      {
        objective: 'Implement ask_orchestrator.',
        planSummary: 'Keep recovery state durable.',
        currentPhase: 'executing',
        approvalStatus: 'approved',
        approvalReason: null,
        blockedReason: null,
        executionTarget: 'workspace',
        latestVerifierVerdict: null,
        handoff: null,
        nextAction: 'continue from the ledger',
      } as any,
    )

    expect(summary).toContain('Agent Mode Run State (authoritative):')
    expect(summary).not.toContain('Agent Mode session state:')
  })
})

// The cases above hand-build AgentModeCompactState and cast it `as any`, which
// is what let compact.ts pass the narrow readSessionState() result straight
// through: the worker roster silently vanished from the post-compact summary.
// These drive the real reader into the real formatter, with no cast.
describe('compact prompt Agent Mode state wiring (live path)', () => {
  let stateDir: string | null = null

  afterEach(async () => {
    if (stateDir) {
      await rm(stateDir, { recursive: true, force: true })
      stateDir = null
    }
  })

  async function writeSessionStateFixture(): Promise<string> {
    stateDir = await mkdtemp(join(tmpdir(), 'cat-compact-state-'))
    const statePath = join(stateDir, 'session.agent-mode-state.json')
    await writeFile(
      statePath,
      JSON.stringify({
        sessionId: 'session-under-test',
        mode: 'agent',
        objective: 'Ship reactive compaction.',
        activeWorkers: {
          'worker-1': { agentId: 'worker-1' },
        },
        knownWorkers: {
          'worker-1': {
            agentId: 'worker-1',
            role: 'implementor',
            description: 'Implement approved plan',
            status: 'running',
            worktreePath: null,
          },
          'worker-2': {
            agentId: 'worker-2',
            role: 'verifier',
            description: 'Verify the implementation',
            status: 'completed',
            worktreePath: null,
          },
        },
      }),
      'utf-8',
    )
    return statePath
  }

  test('carries the worker roster from readSessionState into the summary', async () => {
    const statePath = await writeSessionStateFixture()
    const sessionState = await readSessionState('session-under-test', statePath)
    expect(sessionState).not.toBeNull()

    const summary = getCompactUserSummaryMessage(
      '<summary>continuity prose</summary>',
      true,
      '/tmp/transcript.jsonl',
      false,
      'anthropic',
      toAgentModeCompactState(sessionState),
    )

    expect(summary).toContain('Agent Mode session state:')
    expect(summary).toContain('Ship reactive compaction.')
    // Both workers survive, not just the active one.
    expect(summary).toContain('Known workers:')
    expect(summary).toContain('Implement approved plan')
    expect(summary).toContain('Verify the implementation')
    expect(summary).toContain('- Active worker: implementor')
    // The run-state block has no producer on this path; emitting it would print
    // placeholders and one literal `undefined` for fields nobody supplied.
    expect(summary).not.toContain('Agent Mode Run State (authoritative):')
    expect(summary).not.toContain('undefined')
  })

  test('omits the Agent Mode block when no session state is persisted', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'cat-compact-state-'))
    const missingPath = join(stateDir, 'absent.agent-mode-state.json')
    const sessionState = await readSessionState('session-under-test', missingPath)
    expect(sessionState).toBeNull()
    expect(toAgentModeCompactState(sessionState)).toBeUndefined()

    const summary = getCompactUserSummaryMessage(
      '<summary>continuity prose</summary>',
      true,
      '/tmp/transcript.jsonl',
      false,
      'anthropic',
      toAgentModeCompactState(sessionState),
    )

    expect(summary).not.toContain('Agent Mode session state:')
    expect(summary).not.toContain('Agent Mode Run State (authoritative):')
  })
})
