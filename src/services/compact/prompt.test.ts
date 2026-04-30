import { describe, expect, test } from 'bun:test'

import { getCompactUserSummaryMessage } from './prompt.js'

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
