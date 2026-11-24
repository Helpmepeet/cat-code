export function getEnterWorktreeToolPrompt(): string {
  return `Create an isolated workspace for this attempt. Worktrees keep the main workspace untouched while isolated work runs.

## When to Use

- Use isolation for parallel edits, risky edits, broad refactors, experiments, or an implementation attempt that should not touch the main workspace yet
- The user explicitly asks to work in a worktree
- A task already has an existing sibling worktree, especially one with an in-progress merge. Enter that checkout before assigning workers; creating it with Git alone does not move the session.

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

- In a git repository: creates a new git worktree inside \`.cat-code/worktrees/\` with a new branch based on HEAD
- Outside a git repository: delegates to WorktreeCreate/WorktreeRemove hooks for VCS-agnostic isolation
- Switches the session's working directory to the isolated workspace
- With a path, enters that exact checkout after user approval. It does not create a worktree, change its branch, or take ownership of its cleanup.
- Use ExitWorktree to leave mid-session. Only a worktree Cat Code manages can be removed on exit. A worktree entered by path remains on disk.
- When the shell sandbox is enabled in an existing worktree, stage and commit with separate foreground commands: git add -- path and git commit -m 'message'. Each needs user approval for its Git metadata writes. Do not disable the sandbox.

## Parameters

- \`name\` (optional): A stable name for the isolated attempt. If not provided, a random name is generated.
- \`path\` (optional, instead of name): The absolute path to a registered sibling worktree of the same repository. Use this to preserve the existing files and index.
`
}
