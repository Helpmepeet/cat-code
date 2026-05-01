import { describe, expect, test } from 'bun:test'
import { getOrchestratorSystemPrompt } from './orchestratorPrompt.js'

describe('Agent Mode orchestrator prompt', () => {
  test('defines worker lifecycle and convergence rules', () => {
    const prompt = getOrchestratorSystemPrompt()

    expect(prompt).toContain('Worker lifecycle and convergence')
    expect(prompt).toContain('completed_pending_synthesis')
    expect(prompt).toContain('Worker completion is not objective completion')
    expect(prompt).toContain('intentionally ignored with a reason')
    expect(prompt).toContain('Do not let completed workers disappear as just "done"')
  })

  test('defines worker-control tool doctrine without raw IDs as normal UX', () => {
    const prompt = getOrchestratorSystemPrompt()

    expect(prompt).toContain('Worker control tools')
    expect(prompt).toContain('use ListWorkers')
    expect(prompt).toContain('Use WaitWorkers')
    expect(prompt).toContain('Use GetWorkerResult')
    expect(prompt).toContain('Use CancelWorker')
    expect(prompt).toContain('Prefer worker handles over raw task IDs or internal agent IDs')
  })

  test('defines multitask decomposition boundaries', () => {
    const prompt = getOrchestratorSystemPrompt()

    expect(prompt).toContain('Multitask and decomposition')
    expect(prompt).toContain('Split work only when ownership is clean')
    expect(prompt).toContain('Do not split when workers will compete over the same files')
    expect(prompt).toContain('Parallel workers should have explicit ownership and done conditions')
  })

  test('treats worktrees as agent-owned execution backends', () => {
    const prompt = getOrchestratorSystemPrompt()

    expect(prompt).toContain('Worktree isolation')
    expect(prompt).toContain('Worktrees are execution backends, not user-facing task state')
    expect(prompt).toContain('The orchestrator owns worktree lifecycle')
    expect(prompt).toContain('Do not ask the user to remember worktree paths, branches, or cleanup steps')
    expect(prompt).toContain('Ask the user only at semantic boundaries')
  })

  test('defines steering and recovery before duplicate spawning', () => {
    const prompt = getOrchestratorSystemPrompt()

    expect(prompt).toContain('Steering and recovery')
    expect(prompt).toContain('steer or resume it instead of spawning a duplicate')
    expect(prompt).toContain('Cancel only when the worker branch is obsolete, unsafe, conflicting, or no longer useful')
    expect(prompt).toContain('Failed or killed workers are evidence, not completion')
  })
})
