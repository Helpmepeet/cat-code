# Skill Re-Invocation Transcript Audit: Corrected Session-Level Finding

**Date:** 2026-08-23  
**Scope:** Stored Cat Code and Claude Code transcripts; Cat Code transcript
persistence and Skill-tool prompt source.

## Status

This report corrects two earlier overstatements:

1. **Retracted:** Cat Code does not show repeated distinct Skill calls inside
   one assistant response or one user task. The original apparent outlier was
   duplicate sidechain transcript serialization.
2. **Confirmed:** Cat Code does repeatedly inject byte-identical full skill
   bodies later in the same pre-compaction session history. That is a real
   context-growth signal, even though the calls occur in separate user tasks.

The two questions have different correctness criteria. A same-task duplicate
would be a direct invocation defect. A same-session repeated body may be valid
skill lifecycle behavior, but it still consumes stored context and needs a
separate product decision.

## Stable Tool-Call Measurement

The corrected call-level scan uses stable `(transcript path, tool_use.id)`
identity, rather than one JSONL record per call. It records the containing
assistant response and the most recent user task record.

| Metric | Cat Code | Claude Code |
| --- | ---: | ---: |
| Raw serialized `Skill` tool-use blocks | 988 | 303 |
| Distinct Skill tool-use IDs | 953 | 303 |
| Files containing duplicate UUID records | 124 | 0 |
| Distinct calls repeated in one assistant response | **0** | **0** |
| Distinct calls repeated in one user task | **0** | **0** |
| Same `(thread, skill)` across distinct user tasks | 32 groups | 0 groups |

The last row is not a same-task defect. Cat Code's 32 groups are separated by
real user task records. Claude Code's zero is an observation about this corpus,
not evidence of a product guarantee: the corpora have different work, skill
catalogs, and subagent usage.

## Former Outlier: Serialization Artifact

The former outlier is:

```text
~/.cat-code/projects/-Users-pt-cat-code/2927630a-1693-4be5-8428-0bd62fdf89f4/subagents/agent-a445b2e24e227d1ad.jsonl
```

Its 877 serialized records collapse to 212 distinct UUIDs. All duplicate UUID
records in this file are byte-identical. The apparent 21
`cat-code-cold-review` calls collapse to six distinct tool-use IDs; the
`6 + 5 + 4 + 3 + 2 + 1` shape is older transcript history being re-appended
more often.

Each genuine call is preceded by a distinct delegated user task: the initial
review and five explicit re-review requests. This is valid later-task
reinvocation, not a six-call same-turn defect.

The writer behavior is deliberate. In
[`src/utils/sessionStorage.ts`](../../src/utils/sessionStorage.ts), local
agent-sidechain writes bypass UUID deduplication so fork-inherited messages
that share UUIDs with the main transcript are retained for sidechain resume.
That persistence behavior must not be changed to solve skill context growth.

## Confirmed Session-Level Body Duplication

A separate scan follows the actual meta user message injected after a Skill
call. It counts only messages that:

- are linked to a stable `sourceToolUseID`;
- begin with `Base directory for this skill:`;
- contain a complete loaded skill body;
- have not already been counted for that same tool-use ID.

For a conservative active-history estimate, the scan splits each transcript at
`isCompactSummary: true` boundaries. It then counts only byte-identical skill
bodies that recur before the next compaction boundary. This avoids treating a
changed `SKILL.md` as redundant and avoids carrying pre-compaction history into
a later compacted context epoch.

| Metric | Cat Code | Claude Code |
| --- | ---: | ---: |
| Tool-linked full-skill body messages | 918 | 299 |
| `(thread, skill)` pairs with multiple body injections | 31 | 0 |
| Excess body injections across a full transcript | 50 | 0 |
| Identical-body groups before their next compaction | 15 | 0 |
| Excess identical bodies before their next compaction | **22** | **0** |
| Excess characters in those identical Cat Code bodies | **109,784** | **0** |
| Approximate excess tokens (`characters / 4`) | **27,446** | **0** |

The 22 excess identical-body messages are the strongest confirmed signal. They
are not duplicate JSONL rows, they occur under distinct tool-use IDs, and they
remain in the same persisted pre-compaction history epoch.

This is a lower bound on context growth, not a billing claim. The measurement
does not prove that every duplicate was included in every provider request,
nor does it establish whether reasserting the skill body improves later-task
adherence. Provider payload capture or prompt dumps would be needed to answer
those questions.

## Prompt Guard

Cat Code’s Skill-tool prompt has a current-turn guard: if a
`<command-name>` marker is already in the current conversation turn, the model
should follow the loaded instructions rather than invoke the skill again. Both
prompt variants are in
[`src/tools/SkillTool/prompt.ts`](../../src/tools/SkillTool/prompt.ts).

The skill-loading metadata places `<command-message>` and `<command-name>` in
the same message in
[`src/utils/processUserInput/processSlashCommand.tsx`](../../src/utils/processUserInput/processSlashCommand.tsx).
`SkillTool` then filters that command-message record before returning the full
skill body in
[`src/tools/SkillTool/SkillTool.ts`](../../src/tools/SkillTool/SkillTool.ts).

This is not evidence of a same-turn defect in the measured data. It does,
however, mean the model has no durable marker saying that an identical skill
body remains available later in the same session history.

## Correct Design Question

The supported conclusion is not "never invoke a skill twice in one session."
Skills can change, user tasks can need a fresh activation, and external Codex
research supplied during this audit describes a turn-scoped lifecycle rather
than persistent session activation.

The design question is narrower:

> When the exact same full skill body is already present after the most recent
> compaction boundary, should a later task receive another copy, or should the
> runtime provide a lightweight reactivation marker that reuses the existing
> body?

The transcript evidence justifies investigating that question. It does not yet
justify a source change: the required behavior and any effect on model
adherence, prompt caching, and compaction must be established first.

No source changes were made by this audit.
