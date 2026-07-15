# Agent Mode recovery authority model

**Status:** Specification (approved source of truth for a later rewrite of
`src/agent-mode/orchestratorPrompt.ts` and
`src/skills/bundled/agent-mode-compaction-recovery/SKILL.md`). No source files
change with this doc.

**Problem:** a worker's identity and status can be recorded in up to six
places at once, and each can look individually valid while contradicting the
others. Today there is no ruling on which plane wins. The orchestrator prompt
generally prefers resuming a relevant worker
(`orchestratorPrompt.ts:126`, `:154`); the compaction-recovery skill prefers
respawning unless prior context is clearly load-bearing (`SKILL.md` §4). Both
were written independently and can point in opposite directions for the same
interrupted session. Picking the wrong authority silently produces duplicated
work, stale-context reuse, false "done" signals, or lost user intent — with no
crash to flag it.

This doc defines: (1) what each plane actually records and how it goes stale,
(2) an authority lattice — per-question, with explicit shift conditions,
(3) a decision table over the merged picture, (4) adjudicated fixtures, and
(5) the doctrine reconciliation the two prompt surfaces must be rewritten to.

All mechanics below were verified against source on 2026-07-11; `file:line`
citations are to that state of the tree.

---

## 1. The six planes — what each records, and how each lies

### P1 — Filesystem and worktree state

What it is: `git status` / `git diff` in the worker's `worktreePath` or the
main tree; the bytes of any artifacts on disk.

Truth properties: **never wrong about content** — if a diff exists, that work
product exists; if a worktree is gone, its uncommitted work is gone. Resume
already treats it that way: a missing worktree silently falls back to parent
cwd (`resumeAgent.ts:134-149`), meaning any uncommitted edits in it are
unrecoverable.

How it lies: it is mute about **provenance and completeness**. A dirty
worktree cannot tell you whether the worker wrote those hunks, whether the
user touched them afterward, or whether they represent 10% or 95% of the
assignment. Filesystem answers "what exists," never "who/why/how far."

### P2 — Durable Agent Mode session state

What it is: `<sessionId>.agent-mode-state.json` next to the session
transcript (`sessionState.ts:65-72`). `knownWorkers` keyed by agentId with
`status: running|completed|failed|killed`, `synthesisStatus:
pending|synthesized`, `resumable`, `worktreePath`, `lastResultAt/Summary`,
`lastSynthesizedAt`, `reuseBlockedReason` (`sessionState.ts:18-44`). Writes
are atomic (tmp + rename) and serialized **per process** only
(`sessionState.ts:222-255`). Prior-session workers are merged in read-time
(up to 12 recent sessions, `completed && resumable` only, transcript
existence re-checked and downgraded to `reuseBlockedReason` when missing —
`sessionState.ts:353-433`).

Truth properties: the only plane that records **identity, scope, and
consumption**: role, description, objective linkage, and `synthesisStatus`.
Terminal statuses (`completed|failed|killed`) are written by the lifecycle
that observed the terminal event (`agentToolUtils.ts:891-945, 1011-1019,
1050-1059`) and are durable facts.

How it lies — three distinct ways:

1. **`running` is a claim, not a fact.** Nothing updates durable state at
   process exit. A killed process leaves every in-flight worker `running`
   forever. (Graceful exit writes a `stall-detected` row to the *parent
   transcript*, plane P3 — `cleanupRegistry.ts:62-101` — but never touches
   this file; SIGKILL writes nothing anywhere.) Downstream, one stale
   `running` poisons the derived picture: `deriveCurrentPhase` reports
   `executing` (`sessionState.ts:158-178`) and `getActiveWorker` selects the
   ghost as the active worker (`sessionState.ts:136-156`).
2. **Cross-process last-writer-wins.** The write chain is in-memory; two
   engine processes sharing a state file can clobber each other's whole-file
   writes.
3. **Optimistic flags.** `synthesisStatus: 'synthesized'` records that
   `markWorkerResultSynthesized` was called (`sessionState.ts:638-660`), not
   that the synthesis product actually landed anywhere.

### P3 — Worker transcript and metadata

What it is: `agent-<id>.jsonl` (the worker's full message history — the
actual resumable context) plus `agent-<id>.meta.json` (`agentType`,
`agentName`, `worktreePath`, `description`, `parentSessionId`, `spawnedAt` —
`sessionStorage.ts:333-367`). Plus sidecar rows in the **parent** transcript:
`subagent-spawned` / `subagent-terminal` (`sessionStorage.ts:438-454`),
including the exit-time `stall-detected` terminal
(`cleanupRegistry.ts:62-101`).

Truth properties: the transcript **is** the worker's context — resume is
mechanically "replay transcript + append new user message"
(`resumeAgent.ts:122-126, 233-235`) and hard-requires it
(`TranscriptNotFoundError`, `resumeAgent.ts:119-121`). `meta.json` is the
identity fallback when durable state is missing (it independently records
role, worktree, and parentage). Parent-transcript terminal rows can be
**fresher than P2**: graceful exit writes `stall-detected` here while P2
still says `running`.

How it lies: transcripts and metadata can be cleaned/absent (P2's continuity
read already handles this: `reuseBlockedReason: 'original worker transcript
is unavailable'`, `sessionState.ts:427`). Metadata fields are optional on
older files. A transcript shows what the worker *saw and said*, not whether
its edits survived on disk.

### P4 — Task output and completion notifications

What it is: the worker's final output written to
`<projectTempDir>/<sessionId>/tasks/<agentId>.output`
(`diskOutput.ts:49-54, 73-75`), read by `GetWorkerResultTool`
(`GetWorkerResultTool.ts:55`); plus in-memory completion notifications
(`enqueueAgentNotification`) delivered to the parent turn loop.

Truth properties: when the output file exists, it is the highest-fidelity
record of **what the worker produced**.

How it lies: this is the **most ephemeral plane**. The output lives in a
temp directory and the dir path is memoized per-process at first call
(`diskOutput.ts:49-54`); notifications are pure in-memory state, lost on
process death. Absence of a notification proves nothing. Partial output is
byte-indistinguishable from complete output without a terminal marker —
which is why both existing doctrines already say "partial output is
evidence, not completion." Note the tool's own fallback: a result can be
marked synthesized from P2's `lastResultSummary` even when the output file
is gone (`GetWorkerResultTool.ts:59-62`).

### P5 — Compaction summary

Lossy prose reconstruction of the orchestrator's own history. Useful for
conversational continuity only. Both existing surfaces already subordinate
it to P2 (`orchestratorPrompt.ts:75-77, 87`; `SKILL.md` §3). This doc keeps
that ruling and bounds it further (§2, shift S4).

### P6 — Transcript inference

The orchestrator inferring worker state from its own (possibly compacted)
conversation. Weakest plane; the roster tools exist specifically to replace
it (`ListWorkers` reads P2 with continuity, `ListWorkersTool.ts:44`;
`orchestratorPrompt.ts:66`). Never authoritative over anything except P5's
narrative gaps.

---

## 2. The authority lattice

There is no fixed total order. Authority is **per question**: each question
about a worker has one plane that owns the answer, with defined fallbacks and
defined conditions under which precedence shifts.

### Q1 — What work product exists right now?

**P1 always.** No plane overrides bytes on disk: not a durable
`completed` (fixture F7b — durable claims of work are refuted by an absent
worktree), not a worker's own handoff text, not a summary. The only nuance is
interpretive: P1 cannot attribute the bytes (see S2).

### Q2 — Who is this worker; what was it for? (identity, role, scope)

**P2**, fallback **P3 `meta.json`** when the durable entry is missing or
corrupt. P5/P6 never override identity — a compaction summary that
contradicts durable worker identity is wrong by definition. Where P2 and
`meta.json` disagree on identity fields, P2 wins (it is the actively
maintained record; `meta.json` is spawn-time and never updated except on
resume re-persist, `resumeAgent.ts:257-259`), except when P2's entry was
back-filled by `createStateIfMissing` ("Worker ended before spawn was
recorded", `sessionState.ts:614-618`) — then `meta.json` is the richer
record.

### Q3 — Is the worker actually running?

**Live process reality only** (the in-process task registry / an actually
streaming task). Durable `running` is a claim with a decay rule:

> **Decay rule:** after any process restart, every P2 `running` entry is
> reinterpreted as **`interrupted` (unknown progress)** — not running, not
> terminal. A P3 `stall-detected` terminal row confirms the same thing
> explicitly. P2 *terminal* statuses do not decay; they were written by a
> lifecycle that observed the terminal event.

This single rule removes the biggest lie in the system (§1-P2 item 1) and is
the qualifier that `orchestratorPrompt.ts`'s "Session state is the control
plane... trust it over transcript inference" (`orchestratorPrompt.ts:6`)
must be rewritten to carry.

### Q4 — What did the worker produce?

**P4 output file** when present → **P2 `lastResultSummary`** → **P3
transcript tail** (the worker's last real assistant text, same order
`finalizeAgentTool` uses when salvaging partial content,
`agentToolUtils.ts:527-541`). Notification presence/absence is a delivery
hint, never the record.

### Q5 — Has the result been consumed (synthesized)?

**P2 `synthesisStatus`**, subject to an artifact cross-check:
`synthesized` is trusted **unless** the product that synthesis should have
produced (the report section, the merged decision, the user-facing summary)
is demonstrably absent from planes 1/3. Then treat as `pending` and re-read.
Rationale: re-reading is cheap and idempotent (`GetWorkerResultTool` read is
read-only unless marking); wrongly trusting `synthesized` produces a false
"done." Asymmetric cost rules the tiebreak. The reverse asymmetry also
holds: `pending` is *always* trusted — never assume synthesis happened
without the flag.

### Q6 — What does the user want now? (relevance)

**Live user turn** → **P2 objective** → **P5 summary** → **P6 inference**.
The user's latest instruction beats every status field for *relevance*
decisions: a worker can be perfectly healthy and perfectly obsolete.
Relevance is evaluated before any lifecycle decision (§3 step 1).

### Precedence shifts

- **S1 — Process restart:** Q3 decay rule fires; all P2 `running` become
  `interrupted`. Everything else in P2 keeps its authority.
- **S2 — User-touched artifacts:** when there is evidence the user manually
  modified a worker's worktree or output (user says so, or edits appear that
  no worker lifecycle explains), P2 keeps *identity* authority and P1 keeps
  *content* authority, but **disposition** authority escalates to the user:
  never discard, overwrite, or auto-apply that state; never resume a worker
  *into* it without telling the user.
- **S3 — Durable state missing/corrupt:** reconstruct identity from P3
  `meta.json` + transcripts; P1 constrains what work exists. Adopt the
  reconstruction into P2 going forward (spawn-record back-fill), don't keep
  re-deriving.
- **S4 — Post-compaction:** P2 > P5 > P6 (existing rule, kept). Addition:
  before acting on an *optimistic* P2 claim (`synthesized`, `completed`)
  with an expensive or user-facing action, verify it against P1/P3/P4
  first. Pessimistic claims (`pending`, `failed`) need no verification.
- **S5 — P2 vs P3 terminal conflict:** the later-evidenced record wins. In
  practice: `stall-detected` (P3) beats stale `running` (P2); a P2 terminal
  written by the lifecycle beats an older P3 row. Both are append-only
  records of observed events, so "later" is well-defined by timestamps.

---

## 3. Decision procedure and table

### Inputs (computed via the lattice, in this order)

1. **Relevance** (Q6): `aligned` | `drifted` (same topic, scope/direction
   changed) | `unrelated`.
2. **Liveness** (Q3 + decay rule): `live` | `interrupted` |
   `terminal-completed` | `terminal-failed/killed`.
3. **Result state** (Q4/Q5): `none` | `partial` | `complete-unread`
   (synthesis pending) | `synthesized`.
4. **Unique-state ownership** (Q1): does this worker own unmerged state —
   a dirty worktree with coherent work, and/or unread output that no other
   plane has absorbed? `yes` | `no`.
5. **Context value** (P3): is the worker's accumulated transcript context an
   asset for the next slice (`load-bearing`), neutral, or a liability
   (stale/wrong direction)? Resumability requires the transcript to exist at
   all (`reuseBlockedReason` ⇒ not resumable, ever).

### Actions

`resume` and `steer` are the same mechanism — `resumeAgentBackground` with a
prompt (`resumeAgent.ts:79-91`); steer = resume + corrective instruction.
`respawn` = fresh worker, with a briefing distilled from the predecessor's
salvageable evidence. `cancel` = CancelWorker / bookkeeping closure.
`synthesize` = GetWorkerResult → judge → mark synthesized. `ignore` = leave
recorded, with a reason.

### Decision table

| # | Relevance | Liveness | Result / unique state | Decision |
|---|---|---|---|---|
| D1 | unrelated | any | any | **Ignore** (record reason). Cancel only if it is actually consuming resources. Its dirty worktree, if any, falls under I4 — never delete without the user. |
| D2 | aligned | live, on-track | — | **Wait / let run.** |
| D3 | aligned | live, off-track but salvageable | — | **Steer.** |
| D4 | any | live, obsolete or conflicting with current direction | — | **Cancel**, then disposition of its worktree per I4. |
| D5 | aligned | terminal-completed | complete-unread | **Synthesize.** Mandatory before spawning same-topic work or reporting done (I2, I3). |
| D6 | aligned | terminal-completed | synthesized, artifact present | **Ignore** (closed). |
| D7 | aligned | terminal-completed | synthesized, artifact absent | **Synthesize** (re-read; Q5 cross-check demoted the flag). |
| D8 | aligned | terminal-failed/killed | any | **Inspect first** (P1 diff, P3 tail, P4 partial). Then: resume-to-repair if context load-bearing and scope aligned; respawn-with-briefing otherwise. After two failed repair attempts, report blocker (existing doctrine, kept — `orchestratorPrompt.ts:51`). |
| D9 | aligned | interrupted | unique state = yes | **Resume** in place (same worker, same worktree). The unmerged state is exactly the asset resume preserves. |
| D10 | aligned | interrupted | unique state = no | **Respawn**, briefed from the durable description + any P4/P3 scraps. Close the old entry as superseded. |
| D11 | drifted | any non-live | any | **Respawn fresh** for the new direction — but only after D5/D9-style absorption of any unique state the old worker owns (I2). Cancel/close the old entry. |
| D12 | aligned | blocked on a permission/question (live or interrupted) | — | **Surface to the user** if the question is still relevant; the answer is user authority (I6). If the question is moot, treat as D4/D11. Never self-answer. |

### The resume-vs-respawn tiebreak (the doctrine merge)

The two existing doctrines are both right — about different regimes:

- **Resume-preference** (`orchestratorPrompt.ts:126, 154`) governs the
  *coherent-session* regime: the orchestrator's own context is intact, it
  knows what the worker knows, and the worker's accumulated context is the
  asset. Within that regime, D2/D3/D9 apply: steer or resume before
  spawning duplicates.
- **Respawn-preference** (`SKILL.md` §4) governs the *post-compaction /
  post-interruption uncertainty* regime: the orchestrator can no longer
  verify what the worker's context contains, so stale-context reuse risk
  dominates. Within that regime, D10/D11 apply.

Both are subordinated to one new invariant that neither surface states
today:

> **I2 (absorb-before-replace):** never respawn or spawn same-topic work
> while the predecessor owns unmerged unique state — a pending-synthesis
> result, meaningful partial output, or a coherent dirty worktree. Absorb it
> (synthesize / resume-to-finish / explicitly adopt the diff) or explicitly
> discard it (user approval if destructive) first.

Consequently the skill's "if context freshness is uncertain, respawn" is
rewritten as: **uncertainty resolves to respawn only when unique-state
ownership = no. When unique state exists, uncertainty resolves to
inspect-first (git diff, read output, read transcript tail), never to a
blind respawn.** This is what kills the duplicated-work and lost-work
failure modes simultaneously.

### Invariants

- **I1:** Partial output is evidence, never completion (kept from both
  surfaces).
- **I2:** Absorb-before-replace (above).
- **I3:** Every known worker ends in exactly one of: synthesized /
  ignored-with-reason / failed-and-recovered-or-reported / cancelled
  (kept from `orchestratorPrompt.ts:123`).
- **I4:** Destructive disposition (deleting a dirty worktree, discarding
  partial output, overwriting user-touched state) requires user approval.
- **I5:** Never fabricate liveness. After a restart, no worker is "still
  working"; report `interrupted`, not `running`.
- **I6:** Permission/question answers directed at a blocked worker come from
  the user, never synthesized by the orchestrator.

---

## 4. Adjudicated fixtures

Each fixture: what the planes say → ruling → decision, citing the driving
lattice entries.

### F1 — Mid-research worker; process killed and restarted

Planes: P2 `running` (stale). P3 transcript exists with substantial gathered
evidence; possibly a `stall-detected` row if exit was graceful. P1 clean (a
research worker writes nothing). P4 empty or scraps.

Ruling: S1 decay ⇒ `interrupted`. Unique state: the transcript's accumulated
research **is** unique state (context value = load-bearing) even though the
filesystem is clean — hours of gathered evidence live only in P3.

Decision: **D9 — resume**, with a prompt of the form "report findings so
far, then continue with <current objective slice>." Driving planes: P3
(context asset exists and is resumable) over P2 (`running` decayed).
If the research question itself has drifted (Q6), D11: respawn — but only
after a cheap resume-for-summary or transcript-tail read salvages what was
gathered (I2).

### F2 — Mid-implementation worker; dirty worktree diverging from durable state

Planes: P2 says `running` (stale) or `completed` with a summary that doesn't
match reality. P1: `git -C <worktreePath> diff` shows uncommitted hunks the
P2 summary doesn't describe. P3 transcript exists.

Ruling: P1 owns Q1 — the diff is the truth about what exists. P2 keeps Q2
(whose worktree, what assignment). Inspect the diff (D8/D9 inspect-first).
Two sub-cases:

- Diff is coherent partial progress on the assignment ⇒ unique state = yes ⇒
  **D9: resume the same worker in the same worktree** to finish; its context
  explains its own half-done diff better than any respawn briefing could.
- Diff contains changes no worker lifecycle explains, or the user says they
  touched it ⇒ **S2 fires**: stop, report the divergence, and let the user
  rule on disposition. Never resume a worker into user-touched state
  silently, never `git checkout --` anything (I4).

Driving planes: P1 for content, P2 for identity, S2 for disposition.

### F3 — Blocked handoff (worker waiting on permission/question) after a long gap

Planes: P3/P6 show the worker asked something and never got an answer. P2
likely `running` (stale if the process restarted). P4 empty.

Ruling: the block is a **user-authority** point (I6). First Q6: is the
question still relevant under current direction?

- Still relevant ⇒ **D12: surface the question to the user now**, then
  resume the worker with the answer. Its context (the reasoning that led to
  the question) is load-bearing — a respawn would just re-derive and re-ask.
- Moot (direction changed, or the gap itself invalidated the premise) ⇒
  **D4/D11: cancel**, respawn for the new direction if the task itself
  survives, briefing the replacement with why the old question no longer
  applies.

Driving planes: Q6 (live user intent) decides; P3 supplies the question; P2
`running` is ignored per S1. The gap length alone decides nothing — a
blocked worker doesn't rot by waiting; only its *question* rots.

### F4 — Verification worker whose result was never read

Planes: P2 `completed`, `synthesisStatus: pending`, `lastResultSummary`
present. P4 output file present (or evicted — then P2 summary stands in,
`GetWorkerResultTool.ts:59-62`).

Ruling: `pending` is always trusted (Q5). Unread verification is unresolved
evidence, not closure — the single most dangerous false-"done" source,
because the unread result may be a FAIL verdict.

Decision: **D5 — synthesize.** Read via GetWorkerResult, judge, mark
synthesized. Never respawn verification that already ran; never report the
objective complete past it (I3). Driving plane: P2 (Q5), content from P4→P2
fallback chain (Q4).

### F5 — Marked `synthesized` in durable state, but no read event in the transcript

Planes: P2 `synthesized` + `lastSynthesizedAt`. P6/P3: the orchestrator
transcript shows no GetWorkerResult call and no trace of the result in any
downstream artifact (compaction may have eaten the evidence, or another
process wrote the flag).

Ruling: Q5's cross-check. Two sub-cases:

- The synthesis **product** is findable (final report references the
  finding, the merged decision reflects it) ⇒ trust P2, **D6: ignore**.
  Absence of the *read event* alone (e.g. compacted away) does not demote
  the flag — P2 exists precisely to survive transcript loss.
- No product found anywhere ⇒ demote to `pending`, **D7: re-read and
  re-synthesize**. Re-reading is cheap and idempotent; a false `synthesized`
  is a silent false-done.

Driving planes: P2 holds presumptive authority; P1/P3 artifact absence is
the only thing that overrides it. P6 ("I don't remember reading it") alone
overrides nothing.

### F6 — Partial task output, no completion notification

Planes: P4 output file has content. P2 `running` (stale) — no terminal was
recorded. P3 has no terminal row (hard kill) or `stall-detected` (graceful).

Ruling: S1 ⇒ `interrupted`. I1: the partial output is evidence, not
completion — notifications are a delivery hint (Q4), and their absence here
is expected, not informative. Assess the partial output plus P1:

- Output/diff shows near-complete work ⇒ unique state = yes ⇒ **D9: resume**
  to finish and hand off properly.
- Early scraps only ⇒ **D10: respawn**, pasting the salvageable scraps into
  the briefing so the replacement doesn't start cold (I2 satisfied by
  absorption-into-briefing).

Driving planes: P4 (what was produced) + P1 (what landed), over P2's stale
liveness.

### F7 — Worktree present but durable entry missing; and the reverse

**(a) Worktree exists, no P2 entry.** S3 fires: recover identity from P3 —
`meta.json` independently records `worktreePath`, role, description,
parentage (`sessionStorage.ts:333-349`). If metadata + transcript found ⇒
adopt the worker into P2 and proceed through the normal table (usually D9 if
its work is relevant). If no identity is recoverable: a **dirty** unclaimed
worktree goes to the user (S2/I4 — report it, never delete); a **clean** one
is disposable housekeeping (D1/ignore, cleanup allowed).

**(b) P2 entry with `worktreePath`, worktree missing.** P1 owns Q1: the
uncommitted work is gone, full stop. Resume mechanics already degrade this
way (fallback to parent cwd, `resumeAgent.ts:134-144`) — but degrading
*silently* is wrong at the policy level: mark the entry
non-resumable-in-place, and never claim its edits exist. If the task is
still needed ⇒ **D10/D11: respawn** with a briefing noting prior work was
lost. If P2 claimed `completed` on the strength of that worktree, treat the
completion claim as refuted for anything not also evidenced in P4/P3.

Driving planes: (a) P3 rescues identity, P1+user rule disposition;
(b) P1 refutes P2's implicit work claim.

### F8 — Stale prior worker from an earlier, unrelated task, still "active" in one plane

Planes: P2 continuity read surfaces a prior-session worker as `resumable`
(`sessionState.ts:404-430`), or a current-session `running` ghost from an
old objective; `deriveNextAction` may even suggest resuming it
(`sessionState.ts:197-199`).

Ruling: **Q6 gates everything.** Relevance is evaluated before any lifecycle
state matters; `resumable` is a capability flag, not a recommendation. An
unrelated worker's status — however healthy — is not a work item.

Decision: **D1 — ignore**, with the reason recorded. Do not cancel-spam
prior-session bookkeeping; do not let its presence inflate the derived phase
(`deriveCurrentPhase` counting a stale `running` as `executing` is exactly
the P2 lie the decay rule neutralizes). Its worktree, if dirty, is untouched
per I4.

Driving plane: Q6 (current objective) over every status field in P2/P3.

---

## 5. Rewrite notes for the two prompt surfaces

When `orchestratorPrompt.ts` and the compaction-recovery skill are rewritten
from this spec (separate task), the specific deltas are:

1. `orchestratorPrompt.ts:6` "Session state is the control plane... trust it
   over transcript inference" — keep, but qualified by the **decay rule**
   (Q3): durable `running` is presumptive-stale after restart; terminal
   statuses and synthesis flags remain authoritative.
2. `orchestratorPrompt.ts:126` "Do not spawn another worker until checking
   whether an existing worker can be resumed or steered" — keep, and extend
   with **I2** so the check has teeth: pending synthesis / unmerged worktree
   blocks same-topic spawns.
3. `SKILL.md` §4 respawn-preference — rescope to the uncertainty regime and
   subordinate to I2: "if uncertain, respawn" only when the worker owns no
   unmerged unique state; otherwise inspect-first.
4. `SKILL.md` §2's reconcile-filesystem-first checklist — keep as-is; it is
   this spec's Q1/D8-D9 inspect-first step and stays the operational entry
   point.
5. Both surfaces should adopt the shared action vocabulary (resume / steer /
   respawn / cancel / synthesize / ignore) and the fixture rulings as worked
   examples, so neither re-derives policy.

Implementation-adjacent (out of scope here, flagged for the implementing
task): the decay rule is currently unenforceable purely in prompt text
against `deriveCurrentPhase`/`getActiveWorker`/`deriveNextAction`
(`sessionState.ts:136-204`), which surface stale `running` as
`executing`/active/"Continue <worker>". A small code change (e.g. marking
entries `interrupted` on session-restore, or deriving liveness from the live
task registry) would make P2's rendered header honest; until then the prompt
rewrite must carry the qualifier explicitly.

---

## 6. Unresolved uncertainties

- **Cross-process P2 clobbering** (§1-P2 item 2): this spec treats it as
  rare and resolves conflicts via S5 (later-evidenced wins), but no fixture
  exercises a genuinely interleaved two-orchestrator write. If Agent Mode
  ever runs two orchestrators against one session state file deliberately,
  the lattice needs a locking story (compare `src/codex-core/accounts.ts`
  for the repo's existing cross-process pattern), not just precedence.
- **P4 reachability after resume:** `getTaskOutputDir` memoizes
  `<projectTempDir>/<sessionId>/tasks` at first call (`diskOutput.ts:49-54`).
  Whether a resumed session always reconstructs the same path (same session
  id, temp dir not yet cleaned) was not verified end-to-end; the Q4 fallback
  chain (P4 → P2 summary → P3 tail) is designed so nothing in this spec
  depends on the answer.
- **Coordinator mode:** the same machinery serves `coordinator` mode
  (`resumeAgent.ts:222`). This spec was adjudicated for Agent Mode; the
  rulings look mode-agnostic, but coordinator-specific review was not done.
- **`stall-detected` coverage:** it is written only on graceful exit; SIGKILL
  leaves nothing. Both collapse to `interrupted` under the decay rule, so no
  decision in §3 depends on distinguishing them — noted so nobody later
  treats the *absence* of a stall row as evidence of health.
