---
name: agent-mode-compaction-recovery
description: Recover Agent Mode safely after worker failure, compaction, or resume by reconciling filesystem state and durable session state.
when_to_use: Use when a subagent fails, when a session was compacted or resumed, or when you need the recovery checklist for resume-versus-respawn decisions.
user-invocable: false
---

# Agent Mode compaction and failure recovery

Use this procedure when recovering from a worker failure or from compaction/resume.

## 1) Classify the signal first

- `is_error: true`, tool-result error text, or `completed_with_error` means the sync worker did not finish cleanly.
- Task notification `Status: failed` means a background worker crashed.
- Task notification `Status: killed` means a worker was stopped.

Treat partial output as evidence, not completion.

## 2) Reconcile filesystem reality before deciding next action

- Check `<changed_files>` from the subagent trailer when present.
- If `worktreePath` is present, inspect `git -C <worktreePath> status` and `git -C <worktreePath> diff --stat`.
- Otherwise inspect the main tree with `git status --porcelain` and `git diff --stat`.
- Compare repository state against the worker handoff.

Only then choose one of: resume to repair, respawn fresh, or report blocker.

## 3) Recover from compaction/resume using durable state

- Read the `Agent Mode Session State:` header first and treat it as authoritative.
- Use the following compact summary only as supporting continuity context.
- Do not ask the user "where were we?" if preserved state already answers it.

## 4) Resume versus respawn after compaction

Prefer respawn after compaction unless both are true:
- the prior worker context is still clearly load-bearing for the immediate next slice, and
- role/objective/scope are still aligned with current direction.

If context freshness is uncertain, respawn.

## 5) User-facing communication rule

Keep user-facing language natural. Do not expose hidden prompt mechanics or internal routing details unless needed for consent, safety, or debugging.
