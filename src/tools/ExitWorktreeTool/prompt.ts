export function getExitWorktreeToolPrompt(): string {
  return `Exit an isolated worktree session created by EnterWorktree and return to the original working directory. In Agent Mode, the orchestrator owns worktree lifecycle.

## Scope

This tool ONLY operates on worktrees created by EnterWorktree in this session. It will NOT touch:
- Worktrees created manually with \`git worktree add\`
- Worktrees from a previous session
- The directory you're in if EnterWorktree was never called

If called outside an EnterWorktree session, the tool is a no-op: it reports that no worktree session is active and takes no filesystem action.

## When to Use

- The isolated attempt is complete and the session should return to the main workspace
- The isolated attempt is obsolete, conflicting, unsafe, or no longer useful
- The user explicitly asks to exit or leave the worktree

## Agent Responsibilities

- Treat this as apply, discard, or keep decision support for the isolated result
- Do not make the user manage cleanup mechanics or remember paths and branch names
- Confirm before discarding non-empty work
- If the isolated result should be applied to the main workspace, ask for that semantic approval before applying changes through the appropriate workflow; this tool only exits or removes the isolated workspace

## Parameters

- \`action\` (required): \`"keep"\` or \`"remove"\`
  - \`"keep"\` preserves the isolated result for later. Use this when the result may still be useful or the user asks to keep it.
  - \`"remove"\` deletes the isolated workspace and branch. Use this when the result is clean, obsolete, abandoned, or already safely incorporated.
- \`discard_changes\` (optional, default false): only meaningful with \`action: "remove"\`. If the worktree has uncommitted files or commits not on the original branch, the tool refuses to remove it unless this is true. If the tool reports changes, confirm with the user before re-invoking with \`discard_changes: true\`.

## Behavior

- Restores the session's working directory to where it was before EnterWorktree
- Clears CWD-dependent caches so prompt context reflects the original directory
- If a tmux session was attached to the worktree: killed on \`remove\`, left running on \`keep\`
- Once exited, EnterWorktree can be called again for a fresh isolated attempt
`
}
