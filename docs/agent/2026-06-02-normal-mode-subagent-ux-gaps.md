# Normal-Mode Subagent UI/UX Review

Status: review findings, not yet scheduled
Date: 2026-06-02
Owner: phase1
Related: `2026-06-02-normal-mode-subagent-upgrade.md` (the feature this UX serves)

A UX review organized by the **user's journey** with a normal-mode subagent
(spawn → running → blocked → done → resume), not just a render-bug list. The
question throughout is "what does the user need to perceive or do at this
moment, and does the UI support it?" All claims verified against current source
2026-06-02. Files noted as React-Compiler form (`.tsx` importing
`react/compiler-runtime`) were cross-checked against clean type/source; re-locate
edits by symbol name, not generated line numbers.

---

## TL;DR

The interaction model is genuinely good once you open a subagent (rich detail
dialog, live progress, stop, navigate, resume-by-name). But two journey moments
are weak, and one is a **design-breaking gap specific to this feature**:

- **Blocked state is invisible (High, feature-specific).** We designed the
  `implementor` to "block and return rather than widen scope" — but a normal
  subagent has no "blocked / needs you" UI state. It just shows `completed`. The
  user cannot tell "waiting on my decision" from "done."
- **Name + role invisible in the footer (High).** The always-visible surface
  says `"1 local agent"`, not `@Curie` / `implementor`.
- **Glanceability + discoverability (Medium).** Progress and the ability to
  resume are real but hidden behind opening a dialog.

---

## The user journey, moment by moment

### 1. Spawn — "did the right kind of work start?"

The user asks for implementation or verification and a subagent spawns as a
`local_agent` ([`LocalAgentTask.tsx:136`](../../src/tasks/LocalAgentTask/LocalAgentTask.tsx)).
Footer shows `"1 local agent"` via `getPillLabel`
([`pillLabel.ts:37-38`](../../src/tasks/pillLabel.ts)).

**Gap:** the user wanted *verification* (or an *implementor*), and the most
visible confirmation doesn't name the role or the agent. They can't confirm the
right thing started without opening a dialog.

### 2. Running — "what's it doing, is it stuck, how long?"

The **detail dialog is strong**
([`AsyncAgentDetailDialog.tsx`](../../src/components/tasks/AsyncAgentDetailDialog.tsx)):
live **Progress** (recent tool activities), elapsed time, token + tool counts,
the prompt, and a `x`-to-stop affordance. Navigation is good: Shift+↑/↓ to
select, Enter/`f` to enter the subagent's view, Esc to exit
([`useBackgroundTaskNavigation.ts`](../../src/hooks/useBackgroundTaskNavigation.ts)).

**Gap (Medium):** none of this liveness reaches the **footer** — the
always-on surface. For a single `local_agent` the user sees a static generic
pill and must open the dialog to learn anything is happening. Fine for one quick
task; weak when they want to glance and keep working.

### 3. Blocked / needs input — "does it want something from me?"  ← the headline

This is the moment that matters most **for this specific feature**, because the
`implementor` prompt is deliberately written to **block and return rather than
widen scope** when it hits ambiguity.

**The UI has no state for this.** A `local_agent` only transitions
`running → completed / failed / killed`
([`LocalAgentTask.tsx:148-170`](../../src/tasks/LocalAgentTask/LocalAgentTask.tsx)).
The `awaitingApproval` / `needs_input` status (`?` icon, warning color) exists in
[`taskStatusUtils.tsx:38,65`](../../src/components/tasks/taskStatusUtils.tsx) but
is driven by `awaitingPlanApproval` and the remote/ultraplan path — **never set
for a normal background subagent**. So when the implementor blocks, it surfaces
as `completed` (green tick), identical to a successful finish.

**Why this is design-breaking, not cosmetic:** the entire value of the
"block-don't-widen" discipline is that the user gets pulled in to decide instead
of the agent guessing. If the UI can't distinguish "blocked, needs your input"
from "done," the discipline is invisible — the user sees a tick, assumes
success, and never answers the blocking question. The feature's safety behavior
silently fails at the UI layer.

### 4. Done — "finished? pass/fail? where's the result?"

Detail dialog shows `Completed / Failed / Stopped` with icon + color and the
result/error. Background-task completion can surface via the notification line
([`Notifications.tsx`](../../src/components/PromptInput/Notifications.tsx)); the
result is retrieved into the conversation (`retrieved` flag on the task).

**Gap (Low–Medium):** acceptable, but for a `verification` subagent the user
most wants the **verdict (PASS/FAIL/PARTIAL)** at a glance — that should be
legible without opening the dialog, ideally in the completion surface itself.

### 5. Resume — "continue where Curie left off"

Resume-by-name works
([`resolveAgentTarget.ts:82`](../../src/tools/AgentTool/resolveAgentTarget.ts)).

**Gap (Medium, discoverability):** nothing tells the user the subagent is
resumable or by what name. If the footer never showed `@Curie` (Gap from
moment 1), the user doesn't even know the handle to resume by.

---

## Root cause shared by moments 1 & 5

The friendly name is **not stored on the task.** `LocalAgentTaskState` has
`agentId` and `agentType` but **no `agentName`**
([`LocalAgentTask.tsx:136-170`](../../src/tasks/LocalAgentTask/LocalAgentTask.tsx)).
The name lives only in `agentNameRegistry: Map<string, AgentId>` (name→id) on
AppState ([`AppStateStore.ts:167`](../../src/state/AppStateStore.ts)). A reverse
lookup exists (`displayNameForAgent`,
[`resolveAgentTarget.ts:41-43`](../../src/tools/AgentTool/resolveAgentTarget.ts))
but the pill path never calls it. And the `@name` pills only render when **every**
task is `in_process_teammate` (swarm type) — `local_agent` fails that predicate.

---

## Recommendations (by priority)

1. **[High] Give blocked a real, distinct state (moment 3).** Let a normal
   subagent signal "blocked / needs input" (the implementor's block-return), and
   surface it with the existing `needs_input` treatment (`?` icon, warning color)
   in both the footer and the dialog — visually distinct from `completed`. This
   is the one that makes the feature's safety behavior actually work. Requires a
   way for the agent's blocked-return to set a status the UI reads, not just text
   in the result.

2. **[High] Show name + role in the footer (moments 1 & 5).**
   - Store the resolved friendly name on `LocalAgentTaskState` at spawn (new
     optional `agentName`) so the pill needs no async registry walk.
   - Make the footer recognize named `local_agent` tasks (the `@name` pill path,
     today gated to `in_process_teammate`) and have `getPillLabel` use
     `agentType`: `"1 implementor"` / `"verification"` instead of
     `"1 local agent"`.

3. **[Medium] Surface the verification verdict at completion (moment 4).** Make
   PASS/FAIL/PARTIAL legible in the completion/notification surface, not only
   inside the dialog.

4. **[Medium] Hint resumability (moment 5).** When a subagent completes (or
   blocks), the surface should make the resume handle (`@Curie`) visible so the
   user knows how to continue.

5. **[Low] Footer liveness (moment 2).** Optional: a lightweight progress hint
   on the footer pill so the user can glance without opening the dialog.

---

## Concrete design spec (BUILD THIS — do not redesign)

This section is the exact intended UI. Implement it as written. All icons/colors
come from the existing vocabulary in
[`taskStatusUtils.tsx`](../../src/components/tasks/taskStatusUtils.tsx) — reuse
those helpers, do not introduce new icons or colors.

### Vocabulary to reuse (already in `taskStatusUtils.tsx`)

| Meaning | Icon (`figures`) | Color token | Source |
|---|---|---|---|
| running | `play` ▶ | `background` | `getTaskStatusIcon`/`Color` |
| idle (running, no activity) | `ellipsis` … | `background` | same |
| **blocked / needs input** | `questionMarkPrefix` ? | `warning` | reuse the `awaitingApproval` branch |
| completed (success) | `tick` ✓ | `success` | same |
| failed | `cross` ✗ | `error` | same |
| killed/stopped | `cross` ✗ | `warning` | same |

The blocked state **reuses the existing `awaitingApproval` → `?` + `warning`
treatment**. Do not invent a new indicator; route blocked through the same
icon/color path so it reads consistently with plan-approval.

### Footer pill — exact strings

Single subagent (replace the generic `"1 local agent"`):

```
running:    ▶ @Curie · implementor
idle:       … @Curie · implementor
blocked:    ? @Curie · implementor — needs input   ↵ to open
completed:  ✓ @Curie · implementor
failed:     ✗ @Curie · implementor
```

Verification subagent at completion (verdict inline — see rec #3):

```
✓ @Noether · verification — PASS
✗ @Noether · verification — FAIL
? @Noether · verification — PARTIAL
```

Multiple subagents (mixed): keep the summary-pill pattern but make it role- and
attention-aware. Attention states (blocked/failed) win the label:

```
2 subagents                          (all running, no attention)
? 1 needs input · 1 running   ↵      (one blocked — surface the attention)
✓ implementor · ? verification       (≤2, name each by role+state)
```

Rules:
- `@name` shows when the task has a resolved friendly name; fall back to
  `agentType` alone if somehow unnamed (`▶ implementor`).
- The `· implementor` / `· verification` segment is the `agentType`, dim-styled
  (same dim treatment as the existing ` · ↓ to view` hint).
- The `— needs input   ↵ to open` CTA appears ONLY in the blocked state, mirroring
  the existing `pillNeedsCta` pattern (today only ultraplan needs_input/plan_ready
  show a CTA — extend it to blocked local_agents).

### Detail dialog (`AsyncAgentDetailDialog`) — additions

The dialog already shows `agentType › elapsed · tokens · tools`, Progress, Prompt,
Error, and `x` to stop. Add:

- **Header:** lead with `@name` when present: `@Curie › implementor › running`
  (today the title is `agentType › …`; prepend the handle).
- **Blocked block:** when blocked, render a `warning`-colored section titled
  `Needs input` showing the agent's blocking question (the block-return text),
  visually parallel to the existing red `Error` block. This is where the user
  reads WHAT it's blocked on.
- **Verdict (verification):** when a `verification` agent completes, show
  `VERDICT: PASS|FAIL|PARTIAL` as a colored line near the top of the result
  (success/error/warning), not buried in the result body.
- **Resume hint:** on any terminal/blocked state, add a dim byline:
  `resume with @Curie` so the handle is discoverable.

### Notification line (`Notifications.tsx`) — completion + blocked

When a background subagent reaches a terminal OR blocked state and the user is
NOT currently viewing it, surface a one-line notification reusing the icon/color:

```
✓ @Curie (implementor) finished
? @Curie (implementor) needs your input        ↵ to open
✓ @Noether (verification) — PASS
✗ @Noether (verification) — FAIL
```

The blocked notification is the critical one: it is the signal that pulls the
user back in. Without it the block-return is invisible unless the user happens to
open the dialog.

### State → surface matrix (what shows where)

| State | Footer pill | Detail dialog | Notification |
|---|---|---|---|
| running | `▶ @name · role` | header + live Progress | — |
| blocked | `? @name · role — needs input ↵` | `Needs input` block (warning) | `? @name needs your input ↵` |
| completed | `✓ @name · role` (+ verdict if verification) | result + verdict + resume hint | `✓ @name finished` (+verdict) |
| failed | `✗ @name · role` | red `Error` block + resume hint | `✗ @name failed` |

### What NOT to build

- No new normal-mode roster panel (that is the deferred Gap 3).
- No new icons or color tokens — reuse `taskStatusUtils` only.
- Do not change Agent Mode's roster or pills; this is normal-mode `local_agent`
  rendering only.

---

## Verdict

The **interaction depth is good** — once the user opens a subagent, they can see
and do almost everything. But the feature is judged at the **glanceable surface
and the blocked moment**, and both are weak. The blocked-state gap (rec #1) is
not polish — it's required for the implementor's block-don't-widen design to mean
anything to the user. Recs #1 and #2 are what make this feature feel finished;
the rest is refinement.

## Confidence / caveats

- Clean source (high confidence): `pillLabel.ts`, `LocalAgentTask.tsx` types,
  `AppStateStore.ts`, `resolveAgentTarget.ts`, `taskStatusUtils.tsx`.
- React-Compiler form (behavior confirmed via predicates/types, line numbers
  generated): `BackgroundTaskStatus.tsx`, `AsyncAgentDetailDialog.tsx`,
  `Notifications.tsx`. Re-locate edits by symbol, not line.
- Not separately verified: the exact notification trigger for `local_agent`
  completion in normal (non-teammate) mode — confirm before relying on rec #3/#4
  surfaces.
