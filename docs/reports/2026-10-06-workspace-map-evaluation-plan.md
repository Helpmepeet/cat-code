# Workspace Map: Small Paired Study

2026-10-06 · Draft; no evaluation runs approved.

## Decision first

Decide whether mandatory map-first improves orientation and results in this repo,
using **Cat Code only**. Fix these rules before running:

- **Keep:** repeated benefits across user requests and agent briefs outweigh extra
  reading and wrong turns, including when the brief already supplies orientation.
- **Loosen:** benefits recur when ownership or constraints are unclear, while
  already-oriented tasks mainly show overhead or no benefit. Let the agent judge
  whether orientation is unclear: this is effectively **maps optional, with
  guidance to read them when subsystem boundaries, rules, tests, or traps are uncertain**.
- **Drop mandatory reading:** benefits do not recur, or mistakes and wasted work
  outweigh them. Retain maps only where observed use justifies upkeep.
- **Ambiguous:** propose a few optional-map runs for separate approval.

“Repeated” means two distinct tasks; prioritize result quality, then effort.
This is a local decision, not a statistical estimate.

## Choose real work

Rebuild the frozen 935-task inventory from local Cat Code, Claude Code, and Codex
transcripts using `scripts/workspace-map-eval/taskInventory.ts` at commit
`3696f093`, with cutoff `2026-10-06T08:45:00Z`. Write its raw-prompt output outside
the repo. Kind labels are keyword hints: spot-check category/authorship labels
and manually validate each candidate before selection. Exclude chat,
tool self-tests, other apps, repo chores, and unrecoverable task inputs; log reasons.

Choose **16 tasks**. Reserve one place each for reviews, diagnosis, fixes,
understanding, and designs; allocate the remaining 11 proportionally using largest
remainders, ties alphabetical. Within each category, split places proportionally
between user requests and agent briefs using the same rounding rule. Take the
newest eligible prompts in each group, ties by source then session ID. Use
corrected deduplicated counts, not raw session counts. Freeze the list before
results; report briefs separately and keep every attempt, failure, neutral case,
and rerun. Do not silently substitute tasks after running.

## Reconstruct and isolate each pair

1. **Workspace:** use the recorded task-start commit; otherwise the last commit
   on the evidenced branch before the prompt timestamp. Recover required dirty
   files from contemporaneous patches or saved copies, never today's working tree.
   A timestamp alone does not prove the state. Exclude tasks whose relevant state
   cannot be reconstructed, or whose contemporaneous maps are unavailable; record
   the commit and restored-file hashes.
2. **Inputs:** preserve the first substantive request word for word, including
   its screenshots, pasted text, plans, and required skill instructions. Copy
   referenced Downloads/attachment files into the isolated environment, preserving
   paths where possible and documenting translations. For session diagnosis, copy
   only the referenced session's transcript/logs up to the request time. Exclude
   later diagnostic sessions and answers. Missing essential material means exclusion.
3. **Git:** tasks that do not need history get a history-free `git archive` export
   of the task-time commit, plus the recovered files. Only tasks genuinely needing
   history get filtered task-time history in both setups, with maps, map instructions,
   and routing-hook content removed from retained revisions. Restore task-time maps
   in the mandatory working copy. If filtering is too costly, exclude the task
   before selection and record why.
4. **Filesystem and detection:** use plain run copies with fresh HOME/config/cache/
   temp per run. After every no-map run, search the full transcript, including
   tool calls/results and delegated work, for access to `docs/maps`, `.worktrees`,
   `~/.codex/worktrees` (including expanded paths), or the live checkout. An access
   hit invalidates the run: retain the evidence, then rerun within the approved cap
   or exclude the task from comparison and record why. Add OS-level sandboxing
   only if detection shows real leaks.
5. **Engine and maps:** freeze today's Cat Code engine/build separately from each
   historical workspace. Use its production sidecar/session-controller path, identical
   model/settings/tools, and fresh processes. Load the snapshot's `CLAUDE.md` and
   other guidance. Mandatory maps replaces its map policy with today's and explicitly
   registers today's `.claude/hooks/map-routing-nudge.sh` and its helper; map content
   stays historical. Use identical reviewed non-map hooks in both, never blindly
   execute historical local config. No maps removes `docs/maps/`, map clauses/imports/
   links from loaded guidance and supplied material, and the routing hook's
   registration/script/helper. Record minimal prompt edits for map-directed briefs;
   retain other pointers and rules. Exclude cases where removal destroys task evidence.
6. **Verify before use:** with provider calls disabled, inspect effective prompts
   and registered hooks through that same Cat Code startup path, including enabled
   subagents. Exercise broad-search hook dispatch: a nudge in mandatory, none in
   no-map. Check no-map inputs contain no injected maps or map-first directions.
   These startup checks must pass before any model run.

## Read orientation and results together

Alternate setup order. Compare transcripts and outputs side by side: right
subsystem, respected boundaries/rules (including protocol versioning, security,
and applicable test commands), avoided wrong turns, and quality of the result.
Use the actual fixing commit or accepted review/diagnosis as withheld reference
material; verify against task-time source and allow other correct solutions.

Ask: relevant evidence sooner? Relationships the other run missed? Extra reading
without changing the result? Stale or irrelevant owner? Right files but wrong
explanation? Record help, harm, or no difference with excerpts, time, and tokens.

When a difference looks like model randomness, rerun that task once in both setups.
Check map accuracy/upkeep only if transcripts expose stale or misleading content.

## Approval before runs

Present the exact run list and inputs, snapshot/build IDs, model/settings,
credential arrangement, and quota cap, including reserved paired reruns and
per-run token/turn/time limits. Nothing using quota or logins runs before approval;
optional-map runs need separate approval. Do not commit until the user has read this.
