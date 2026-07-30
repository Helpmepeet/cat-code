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

  test('gives each worker-control tool exactly one owning rule', () => {
    // C3: the four rules were stated twice, once under a "Worker convergence"
    // heading and once under "Worker control tools", with drifted wording.
    const prompt = getOrchestratorSystemPrompt()

    for (const tool of [
      'ListWorkers',
      'WaitWorkers',
      'GetWorkerResult',
      'CancelWorker',
    ]) {
      expect(prompt.split(tool).length - 1).toBe(1)
    }
    expect(prompt).not.toContain('## Worker convergence')
  })

  test('states the Skill boundary as role-dependent rather than a blanket denial', () => {
    // C10: the doctrine claimed no worker has Skill access while the worker
    // capability context claimed every worker does.
    const prompt = getOrchestratorSystemPrompt()

    expect(prompt).toContain('Only the orchestrator invokes skills')
    expect(prompt).toContain(
      'no Skill access unless its own agent definition explicitly grants it',
    )
    expect(prompt).not.toContain('workers do not have Skill tool access')
  })

  test('pushes post-spawn orchestration and concrete worker thresholds', () => {
    const prompt = getOrchestratorSystemPrompt()

    expect(prompt).toContain('After spawning Explore workers, do not keep doing overlapping repo reads, greps, or file tours on the main thread')
    expect(prompt).toContain('Do not both spawn Explore and then keep investigating the same area yourself')
    expect(prompt).toContain('Either gather one narrow blocking fact needed immediately to steer another worker, or wait and synthesize')
    expect(prompt).toContain('touch more than one file')
    expect(prompt).toContain('more than one meaningful edit or command cycle')
    expect(prompt).toContain('behavioral or user-visible logic')
    expect(prompt).toContain('prompt, session-state, worker-control, or orchestration surfaces')
    expect(prompt).toContain('changed prompt, session-state, worker-control, or orchestration behavior')
    expect(prompt).toContain('If a coding worker changed more than one file')
  })

  test('makes agent mode more aggressive than normal chat in delegation posture', () => {
    const prompt = getOrchestratorSystemPrompt()

    expect(prompt).toContain('Agent Mode should feel different from normal chat because execution pressure moves outward sooner')
    expect(prompt).toContain('Default toward a worker unless the task is truly tiny')
    expect(prompt).toContain('A real implementation phase should usually belong to a coding worker, not the orchestrator')
    expect(prompt).toContain('Do not let the orchestrator drift into being the primary implementor or verifier')
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
