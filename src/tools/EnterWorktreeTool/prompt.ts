export function getEnterWorktreeToolPrompt(): string {
  return `Create an isolated workspace for this attempt. In Agent Mode, worktrees are execution backends: the main workspace stays untouched while isolated work runs.

## When to Use

- Agent Mode needs isolation for parallel edits, risky edits, broad refactors, experiments, or an implementation attempt that should not touch the main workspace yet
- The user explicitly asks to work in a worktree

## When NOT to Use

- The task is tiny and safe to do directly
- The next step depends on a prior answer and parallel isolation would add synthesis overhead
- Another active worker already owns the same files or subsystem
- The user only asks to create or switch branches; use normal git commands for branch-only requests

## Agent Responsibilities

- Treat the worktree as internal execution state, not user-facing task state
- Do not ask the user to remember the worktree path or branch
- Track the worktree path as worker/session metadata and expose it only when needed for debugging or explicit user request
- Before asking the user to apply, discard, or keep work, inspect and summarize the isolated result

## Requirements

- Must be in a git repository, OR have WorktreeCreate/WorktreeRemove hooks configured in settings.json
- Must not already be in a worktree

## Behavior

- In a git repository: creates a new git worktree inside \`.claude/worktrees/\` with a new branch based on HEAD
- Outside a git repository: delegates to WorktreeCreate/WorktreeRemove hooks for VCS-agnostic isolation
- Switches the session's working directory to the isolated workspace
- Use ExitWorktree to leave mid-session. On session exit, if still in the worktree, the user will be prompted only for the meaningful outcome: apply, discard, or keep the isolated result.

## Parameters

- \`name\` (optional): A stable name for the isolated attempt. If not provided, a random name is generated.
`
}
