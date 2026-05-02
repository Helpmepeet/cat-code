import { describe, expect, test } from 'bun:test'

// Temporary source-level assertions: importing the runtime prompt builders in
// this repo snapshot currently trips a pre-existing initialization issue in the
// broader tool graph, so this file verifies prompt doctrine presence only.
const promptSource = await Bun.file(
  new URL('./rolePrompts.ts', import.meta.url),
).text()

describe('Agent Mode role prompts', () => {
  test('coding worker treats worktree lifecycle as orchestrator-owned', () => {
    expect(promptSource).toContain('worktree or isolation lifecycle is orchestrator-owned')
    expect(promptSource).toContain('Do not ask the user to manage worktree cleanup')
    expect(promptSource).toContain('ready for orchestrator synthesis')
  })

  test('worker role descriptions make coding and verification defaults concrete', () => {
    expect(promptSource).toContain('default implementation owner once a patch stops being a tiny single-file tweak')
    expect(promptSource).toContain('default review path for non-trivial implementation batches')
    expect(promptSource).toContain('especially when prompt, session-state, worker-control, or orchestration behavior changed')
  })

  test('verifier judges isolated worktree result safety', () => {
    expect(promptSource).toContain('If verifying an isolated worktree result')
    expect(promptSource).toContain('safe to apply')
    expect(promptSource).toContain('should be discarded')
    expect(promptSource).toContain('Do not expose raw paths unless needed for evidence')
  })
})
