# Agent Mode V2 Plan

**Status:** Active — updated 2026-04-20 after full idea selection and contradiction resolution  
**Purpose:** Authoritative design baseline for V2 implementation.

---

## What V2 is trying to fix

The current Agent Mode is too centered on **"start a run with a task"** and too shaped like a bounded workflow.

V2 should feel more like a **real chat session** while still being clearly different from normal chat:
- stronger orchestration posture
- earlier and more natural subagent spawning
- optional end-to-end ownership when the user asks for it
- selective planning and review when it actually helps

The goal is **not** to turn every Agent Mode conversation into `plan -> approval -> execute -> verify`.

---

## Core product statement

**Agent Mode is the orchestration-focused chat session.**

Compared with normal chat, Agent Mode should:
- think more like an orchestrator
- spawn and manage subagents earlier and more naturally
- keep the same normal conversational feel
- drive tasks end to end when the user clearly asks for that

Normal chat stays strong. Agent Mode is a different session type, not a replacement.

---

## Session model

### Entry
- `/agent` starts a **fresh Agent Mode session**, clean with no conversation carryover.
- `--agent-mode` behaves the same as `/agent`.
- No task required at entry. No onboarding prompt. The session just starts under Agent Mode behavior.

### Inside the session
- Behaves like normal chat, but the orchestrator is always active.
- No mandatory workflow. No forced plan gate.

### Exit
- No special exit command. `/clear` is enough for a fresh session.

### UI indication
- Agent Mode clearly visible in the UI, but simple.
- Normal chat surface with a clear mode indicator — not a separate workflow console.

---

## Core behavioral difference from normal chat

1. **Earlier and more natural subagent spawning** — the most visible everyday difference
2. Stronger orchestration posture
3. End-to-end ownership when the user clearly asks for it

---

## Conversational stance

- Normal engineer-like communication, plain language
- No robotic workflow narration
- No internal jargon unless needed for consent, safety, or debugging
- Judgment-oriented style — doctrine and criteria, not brittle hard rules

---

## Ownership model

Agent Mode can drive tasks end to end, but does **not** assume that on every task.

End-to-end continuation triggers on clear user intent, including natural equivalents:
- "finish this"
- "take care of this"
- "go do it"
- "handle this end to end"

Otherwise, Agent Mode stays collaborative.

---

## Main agent role

The main agent is an **orchestrator first**.

### What the orchestrator does itself
- Talks naturally with the user
- Does shallow reads / framing when useful
- Planning — always inline, never delegated to a worker
- Synthesizes worker findings before assigning follow-up
- Approval routing and all user-facing communication
- Final outcome judgment (completed / blocked)
- Tiny, obvious, low-ambiguity code edits when delegation overhead outweighs value

### What the orchestrator delegates
- Real coding work → coding worker
- Broader investigation → research worker
- Post-implementation review of non-trivial batches → verification worker

### Orchestrator power moves
The orchestrator knows and can use these when the situation warrants — they are not hardcoded behavior, just available doctrine:
- **Divergent-convergent** — run two workers with different approaches, then converge via comparison
- **Council** — spawn multiple independent verification passes, take majority verdict for high-stakes calls
- **Debate** — two workers argue opposing positions, orchestrator adjudicates

---

## Worker model

### Two built-in roles
- **Coding worker** — bounded local investigation + implementation + local checks. Can spawn Explore agent when it needs deeper investigation.
- **Verification worker** — independent review, spawned for non-trivial implementation batches

No planning worker. Planning always stays inline with the orchestrator.
No research worker. The orchestrator or coding worker spawns the existing Explore agent directly when broader investigation is needed.

### New roles
Any new role can be created easily and stored in `.cat-code/roles/`. The system provides a pool of available names per role — assigned randomly at spawn. Names are ergonomic handles, not UUIDs.

### Named workers and session scope
- Names are **session-scoped** — "felix" exists for this session only
- Cross-run persistence lives in the **role file**, not the individual worker
- "Resume felix" means: continue the existing felix session — same agent, new turn. Not a respawn.
- When the session ends, the name is gone. The role file carries forward any learnings the worker wrote.

### Role files
Each role has a file in `.cat-code/roles/` — like `CLAUDE.md` but per role. This file:
- Injects as part of the worker's system prompt at spawn
- Accumulates learnings the worker writes during its run
- Documents its own location so the worker knows where to write
- Is the cross-run memory for that role

Fresh model instance every spawn. Persistent role file across all spawns.

### Coding worker tool surface
Read, Edit, Write, Bash, Glob, Grep, `ask_orchestrator`. No Agent spawning, no web access by default. A separate wider variant exists for tasks that genuinely need external access.

### Verification worker trigger
- Small / obvious changes → orchestrator reviews inline, no worker spawned
- Non-trivial implementation batches → verification worker spawned
- Timing is orchestrator judgment — wait for a batch to stabilize before reviewing

### Worker briefing shape
At spawn, always inject: role file + task + scope + list of available context files in `.cat-code/context/`.
Inject only when relevant: prior outputs, prior failed attempts.
Worker reads whichever context files it judges relevant to the task.
Worker uses `ask_orchestrator` if it needs more.

### Worker output shape
Hybrid: short natural summary + small structured skeleton with the fields the orchestrator needs. Not pure prose, not rigid schema-only.

---

## Planning model

Planning is **selective**, not the mandatory entrance fee for implementation.

- Light planning stays inline in chat
- Heavier planning uses EnterPlanMode selectively
- No approval required for every implementation task
- Approval reserved for: plan mode, real risk-boundary crossings, meaningful scope/approach shifts, destructive or irreversible actions

---

## Verification and audit model

- Strong default toward running an audit pass after delegated implementation
- Orchestrator decides when a batch has stabilized enough to review
- Tiny direct main-agent edits usually skip the audit
- Post-audit repair routing: orchestrator judgment (resume or fresh worker)

---

## Universal clarification tool (`ask_orchestrator`)

A real registered tool available to all workers. Subagents use it to:
- Ask a clarifying question before proceeding
- Request missing context
- Signal "I'm stuck" with evidence

Single tool — subagent decides whether to route to orchestrator or user.

---

## Persistence / state model

**Session-first, not run-artifact-first.**

- `.cat-code/runs/` is restructured — session-scoped storage replaces the run ledger as the user-visible abstraction
- The run ledger as a product artifact goes away; state lives on the session
- Moderate structured session state: mode identity, worker continuity, pending approvals, current orchestration context, resumable task state
- Typical session has **one main effort** — no foregrounded multi-thread task board

---

## Compaction

Rely on the existing Cat Code compaction mechanism — no new infrastructure needed.

The orchestrator prompt needs a dedicated compaction recovery section. Size may be small, medium, or large depending on how much doctrine is needed to make recovery reliable. The goal is that after compaction, the orchestrator continues the task seamlessly end to end without interrupting the user.

The recovery section should cover:
- How to detect that compaction has occurred
- Read session state to reorient on current objective, active named workers, last handoffs, and next intended action
- Use the compaction summary for conversational context
- If session state and compaction summary conflict, session state wins — it is the control plane
- Never ask the user "where were we?" — always reconstruct silently and continue
- Resume any in-progress worker coordination from where it left off

---

## Judgment over brittle rules

V2 keeps the design bias:
- provide doctrine
- provide useful criteria
- trust the orchestrator model's judgment

Model-driven decisions (not hardcoded):
- foreground vs background workers
- resume vs fresh worker
- worktree vs shared workspace
- audit timing
- repair routing after audit

---

## Decision ledger — fully resolved

### Product shape
- `/agent` → fresh clean Agent Mode session
- `--agent-mode` → same as `/agent`
- No special exit command; `/clear` for fresh session
- UI: clear mode indicator, normal chat feel
- Everyday difference: earlier, more natural subagent spawning
- End-to-end ownership: intent-sensitive, triggers on explicit wording + natural equivalents

### Orchestrator
- Orchestrator-first; direct coding only for tiny obvious edits
- Planning always inline — no planning worker
- Foreground/background, resume/fresh, worktree/workspace → orchestrator judgment
- Plain-language, non-robotic orchestration communication

### Workers
- Two built-in roles: coding, verification
- No research worker — orchestrator and coding worker spawn Explore agent directly
- Coding worker can spawn Explore agent for deeper investigation
- New roles via `.cat-code/roles/` — easy to create, system-assigned names from a pool
- Names session-scoped; role files cross-run persistent
- Coding worker tools: Read, Edit, Write, Bash, Glob, Grep, `ask_orchestrator`, Agent (Explore only)
- Worker briefing: role file + task + context file list always; prior outputs injected only when relevant
- Worker output: hybrid natural + small structured skeleton
- Universal clarification tool: `ask_orchestrator`, real registered tool

### Planning and approval
- Selective planning; plan mode reused selectively
- No mandatory approval for implementation; approval for plan mode and real risk boundaries

### Verification
- Strong default audit after non-trivial delegated implementation
- Small changes: orchestrator reviews inline
- Audit timing and post-audit routing: orchestrator judgment

### Persistence
- `.cat-code/runs/` restructured — session-scoped storage
- Role files in `.cat-code/roles/`: instruction prompt + learning accumulator per role
- Context files in `.cat-code/context/`: domain big-picture files (frontend.md, auth.md, api.md, ...) — seeded by user, maintained by workers. High-level and stable only, no low-level implementation details.
- Cross-run learnings live inside role files and context files, not a separate global file
- Session state: moderate, one main effort per session

### Rejected ideas (complete list)
Everything not listed above was rejected, including:
- Repo fingerprinting and compressed repo-context packet
- Thinking-budget routing per role
- Structured handoff schema project (existing work order contracts are kept as-is)
- All trigger/event-driven automation
- All code intelligence infrastructure (LSP, AST, call graphs)
- All security/sandbox infrastructure
- All UI observability surfaces (HUD, statusline, heartbeats)
- All async/background execution patterns
- All cost/budget management features
- All plan UX ceremony (two-gate, plan DSL, TDD-first, refactor-only modes)
- Tiered risk classification
- Multi-model routing
- Council/best-of-N as hardcoded behavior (kept as orchestrator power move doctrine only)

### Lightly adopted (doctrine only, no machinery)
- Divergent-convergent, council voting, debate → orchestrator power moves doctrine
- Per-decision escalation tiers → orchestrator escalation guidance
- Compacted resume path → cleaner optional improvement, no new infrastructure
- Context diff at resume → inject repo diff when resuming a worker

---

## Open items (none — all resolved)

All items previously marked "still open" are now resolved:
- Who does planning → always orchestrator inline
- Coding worker tool list → Read, Edit, Write, Bash, Glob, Grep, `ask_orchestrator`
- UI treatment → clear mode indicator, normal chat feel, no workflow console
- Worker handoff fields → hybrid natural + small structured skeleton (existing contracts kept)
- Repo-context layer → rejected
- IDEAS.md selection → complete

---

## Next step

Implementation. The design is stable. Start with:
1. Orchestrator prompt rewrite reflecting V2 conversational stance and power moves doctrine
2. New coding worker role definition and tool surface (including Explore agent access)
3. `ask_orchestrator` tool implementation
4. Session-scoped state replacing `.cat-code/runs/` ledger
5. `.cat-code/roles/` directory and role file injection mechanism
6. `.cat-code/context/` directory — context file list injection at spawn
7. Named worker pool (name assignment and session-scoped resume)
