# Cat Code Agent Mode V2 — Wide Brainstorm

**Purpose:** Comprehensive idea list for V2 feature selection. Each idea has origin and tradeoff notes. Select, cut, or combine — then we write the V2 doc.

**Status:** Brainstorm only. Nothing here is committed.

**Date:** 2026-04-19

---

## How to use this doc

Read through, mark ideas with:
- ✅ must-have
- 🤔 maybe / needs discussion
- ❌ skip
- 🔀 combine with [other idea]

Then we condense into V2.

---

## 1. Repo context layer (the AGENTS.md story)

**1.1 AGENTS.md as first-class orchestrator input.** Read `AGENTS.md` at orchestrator bootstrap, inject compressed summary into active context, cite it when planner decisions trace back to it. Cross-tool standard now — Cursor, Claude Code, Codex, Copilot, Gemini all honor it. Vercel's evals: 100% pass rate vs 79% for skills-only. **Tradeoff:** near zero — this is a pure win.

**1.2 Hierarchical per-directory AGENTS.md.** Vercel Code Review pattern — nested AGENTS.md files inherit from parent; `src/components/AGENTS.md` adds scoped context on top of root. Orchestrator and workers load the relevant ones based on which files they're touching. **Tradeoff:** needs careful merging logic; default to concatenation with clear headers.

**1.3 Compressed docs index pattern.** Vercel's 8KB compressed index beat 40KB full-docs injection. For Cat Code: orchestrator builds a compressed repo index (file tree + module purposes + key APIs) at bootstrap, refreshes on major file additions. **Tradeoff:** needs maintenance logic to stay current.

**1.4 SOUL.md / TOOLS.md split (OpenClaw pattern).** AGENTS.md for "what the repo is," SOUL.md for "how this agent should act," TOOLS.md for "what tools exist and when to use them." **Tradeoff:** more files to maintain; probably overkill for a solo personal tool. Keep in mind as optional organization.

**1.5 Versioned docs bundled in the repo.** Next.js 16.2 bundles its own docs at `node_modules/next/dist/docs/` so agents get version-matched references locally. Cat Code could encourage users to bundle API docs in their repo, or auto-pull them at bootstrap. **Tradeoff:** repo-specific, not core to agent mode.

**1.6 Technical context as separate layer (Ctxo pattern).** Recent Medium piece argued for semantic code intelligence as its own layer beneath context engineering — symbol graphs, change intelligence, dead-code analysis. Cat Code could integrate with LSP/AST tooling as a first-class orchestrator tool surface. **Tradeoff:** substantial new infrastructure.

**1.7 Repo fingerprinting.** On first run in a repo, orchestrator generates a structured fingerprint (stack, test framework, build system, conventions) and saves it to `.cat-code/repo.md`. Future runs skip rediscovery. **Tradeoff:** fingerprint can rot; need refresh trigger.

---

## 2. Approval & HITL patterns

**2.1 Plan-as-markdown with inline comments (Ultraplan pattern).** Plan is written to `plan.md`; user opens in editor, adds inline comments, saves; those comments become the refinement input. Much closer to code review UX than terminal approval. **Tradeoff:** needs file-watching or commit-based detection.

**2.2 Tiered risk classification with per-tier approval rules.** Inspired by HumanLayer's `require_approval` decorator. Classify each planned action: safe (auto), moderate (notify, default-approve after timeout), risky (hard stop for approval). Orchestrator sets tier based on action type. **Tradeoff:** classification logic needs tuning; easy to get wrong.

**2.3 Escalation with timeout (Cloudflare waitForApproval pattern).** If user doesn't respond to an approval within N minutes, default action (either block or apply based on policy). For solo use, "block after 30 min" is the most useful default. **Tradeoff:** needs a notification channel the user actually reads.

**2.4 Structured response options.** HumanLayer pattern — pre-filled response choices ("Approve," "Modify scope," "Re-plan with constraint X"). Makes approval responses machine-parseable. **Tradeoff:** limits expressiveness; user can still write free-form.

**2.5 Human-as-tool (not just approval gate).** HumanLayer's "Human as Tool" — agent can ask for advice, missing context, or clarification at any point, not just at plan approval. Use sparingly; otherwise becomes approval fatigue. **Tradeoff:** slippery slope toward babysitting.

**2.6 Approval receipts in the run ledger.** Every approval logged with timestamp, content shown, user response, source channel. Immutable audit trail. Useful even for solo use — you can rewind to "why did I approve this." **Tradeoff:** tiny data overhead, no real downside.

**2.7 Re-approval checkpoint at "point of no return."** Before the orchestrator takes an irreversible action (merge to main, force-push, delete file), explicit re-approval even if original plan covered it. **Tradeoff:** can re-trigger approval fatigue if not scoped tightly.

**2.8 "Ask the user" as a first-class orchestrator tool.** Instead of blocking with "I need clarification," orchestrator calls an `ask_user` tool that renders a structured prompt. Different from general approval because it's mid-execution context-seeking, not gate-crossing. **Tradeoff:** overlaps with 2.5; pick one framing.

---

## 3. Async execution & notifications

**3.1 Background runs with wake triggers.** OpenClaw pattern — agent runs in background, notifies when state changes to `awaiting_approval`, `completed`, or `blocked`. Channels: terminal bell → desktop notification → optional webhook. **Tradeoff:** need to pick notification channels.

**3.2 Multi-channel notifier.** Desktop (macOS notification), terminal bell, webhook (Slack, Discord, ntfy.sh, Telegram). User configures priority channel. **Tradeoff:** each channel needs config.

**3.3 Live progress summary message.** On wake, the notification isn't just "done" — it's "done: built 3 files, 14 tests pass, verifier approved, review diff here." Similar to Cursor 3's cloud-agent demos. **Tradeoff:** needs summary generation logic.

**3.4 "Run while I'm away" default.** Agent mode assumes long-running by default; user explicitly picks "stay foreground" when they want to watch. Flips the current mental model. **Tradeoff:** requires the background infrastructure to be rock-solid first.

**3.5 Nighttime / scheduled runs.** "Run this overnight, wake me at 8am with the result." Anthropic's 2026 trends report calls this "workflow-level" and says it's the top 15% of teams. **Tradeoff:** solo personal system might not need this, but cheap to add.

**3.6 Resumption on wake.** If the agent blocks at 2am and the user wakes at 8am, the resume flow shows exactly what happened, the current ledger state, and the decision needed. Not just "blocked — see logs." **Tradeoff:** needs good blocked-state summary generation.

---

## 4. Live observability

**4.1 HUD statusline.** OMC pattern. One-line statusline showing phase, worker count, tokens burned, estimated cost, elapsed time, current action. Cheap; all data already in run ledger. **Tradeoff:** minimal.

**4.2 Tiled tmux pane mode.** Optional — agent mode opens in a tmux session with orchestrator in main pane, worker output panes tiled alongside, HUD at the bottom. OMX uses this. **Tradeoff:** tmux dependency; skip if you don't live in tmux.

**4.3 Monitor / tail tool for the orchestrator.** Claude Code April addition. Orchestrator can tail implementor test/build output live and react to signals mid-run instead of only seeing batched handoffs. **Tradeoff:** needs live log ingestion; changes the "evidence packets are prose" doctrine from V1.

**4.4 Worker progress heartbeats.** Workers emit structured progress events every N seconds ("reading auth.ts," "running tests," "test failed: 3 in billing_spec"). Orchestrator renders these as a live activity feed. **Tradeoff:** chatty workers; need rate limiting.

**4.5 Token burn live counter.** Real-time token cost as a footer stat. When approaching budget (e.g., 80%), color changes to yellow. At 100%, soft stop (see 11.1). **Tradeoff:** needs provider cost lookup.

**4.6 Optional thought narration.** Workers can stream brief one-line "thinking" narration to the HUD when enabled. Useful when debugging agent behavior; noisy otherwise. **Tradeoff:** easily becomes cute instead of useful.

---

## 5. Run state & persistence

**5.1 JSONL append-only session log per worker.** OpenClaw pattern. Each worker's trajectory saved as append-only JSONL; crash-safe (lose at most one line). V1 has a ledger but doesn't specify this for worker transcripts. **Tradeoff:** disk usage grows; needs rotation policy.

**5.2 Content-addressed artifacts.** Huggingface Anthropic trends guide suggests content-hash IDs for diffs, plans, outputs, so you can reference "plan-abc123" unambiguously across the run. Good for audit and replay. **Tradeoff:** more plumbing; only matters at scale.

**5.3 Git checkpoint per phase.** Orchestrator auto-commits to a run-specific branch at each phase boundary (plan approved, implementation done, verification passed). User can `git bisect` the agent's work. **Tradeoff:** pollutes git history unless scoped to a worktree.

**5.4 Run replay.** Given a run ledger + JSONL logs, re-simulate the run's decisions on a new branch. Useful for "this went well, let me run the same approach on a similar task." **Tradeoff:** replay determinism is hard with LLMs; probably best-effort.

**5.5 Run templates.** Save a completed run as a template (plan shape, role briefings, verification commands) that future similar tasks can clone. Start fresh but pre-configured. **Tradeoff:** needs good template-matching UX.

**5.6 Cross-run knowledge accumulation.** On every blocked/failed run, orchestrator writes a short postmortem to `.cat-code/learnings.md`. On new runs, read it as context. Small, personal, permanent memory of "things that don't work in this repo." **Tradeoff:** can bloat over time; needs cap + rotation.

**5.7 Structured handoff schema (not just prose).** V1 explicitly keeps handoffs as prose. Consider a structured schema (changed_files, commands_run, unresolved, confidence) with a prose `notes` field. Codex supports strict structured outputs well. **Tradeoff:** more rigid; prose was chosen for a reason.

---

## 6. Compaction & context hygiene

**6.1 Codex-native compaction (already in V1).** Keep this. No change.

**6.2 Rolling summary per worker.** Each worker maintains a running 200-word summary of its own progress, refreshed every N turns. On handoff, the summary is the default handoff content. **Tradeoff:** extra inference cost; modest.

**6.3 Tiered context for the orchestrator.** Hot context (current phase, next action, latest handoff), warm context (previous phase summaries), cold context (link to ledger). Orchestrator can pull from warm/cold on demand. **Tradeoff:** adds retrieval complexity.

**6.4 Context budget per role.** Each role gets a max-tokens budget for its prompt (planner: 8K, implementor: 30K, verifier: 15K). Enforce at briefing time. **Tradeoff:** can clip important context; need fallback.

**6.5 "Progressive disclosure" brief.** Role worker gets a minimal brief first; can request more context as needed via a `read_more` tool. Matches Anthropic's Skills 2.0 progressive disclosure pattern. **Tradeoff:** adds a round-trip; useful when briefs are huge.

---

## 7. Orchestration & role patterns

**7.1 Named specialist roles (BMAD-style).** Planner, Implementor, Verifier — plus optional: Refactorer, Test Writer, Doc Writer, Security Reviewer, Architect. Summonable when the task calls for them. **Tradeoff:** V1 resisted this intentionally; introduces role sprawl risk.

**7.2 Council consensus for high-stakes decisions.** OMC pattern. N agents independently evaluate a decision (architect choice, merge conflict resolution), output `[CONSENSUS: YES/NO]`, orchestrator takes majority. **Tradeoff:** expensive; only worth it for genuinely high-stakes decisions.

**7.3 Best-of-N implementor (opt-in).** Two implementors in parallel worktrees, verifier picks winner by diff comparison. Cursor 3 built this into the product. **Tradeoff:** 2x cost per invocation; worth it for architecturally-important work.

**7.4 Party mode / multi-agent discussion.** BMAD pattern. Multiple role personas discuss a question in a single session. Useful for planning complex features. **Tradeoff:** chat becomes slow and verbose; probably not worth it for solo coding.

**7.5 Orchestrator that asks "do I need to delegate at all?"** Before spawning a worker, orchestrator self-checks: is this faster to do myself? V1 has this principle; make it an explicit decision step. **Tradeoff:** adds a check; small cost.

**7.6 Researcher as opt-in role (resolve V1 tension).** Acknowledge Researcher exists but as a conditional escalation, not a default. Rename "Role Set (v1)" to "Default roles + optional escalations." Fixes the internal inconsistency from V1 review. **Tradeoff:** small framing change; clean.

**7.7 Dual-model fast + strong (DHH pattern).** Fast model (cheap, quick iterations) + strong model (expensive, hard reasoning) running in parallel, user picks diffs as they come in. DHH does this in Neovim. **Tradeoff:** requires multi-model support + good diff UI.

---

## 7b. Orchestration & role patterns — deep dive

Follow-up expansion on §7. Goes further on subagent lifecycle, specialization, communication, and several patterns that contradict V1 (marked ⚠️). Treat this as an exploration — not everything here is selectable, some are mutually exclusive.

### 7b.A Subagent lifecycle — resumable vs fresh

V1's doctrine is **fresh-by-default**. Every new implementor/verifier is spawned clean. This deep dive pushes on that.

**7b.A.1 Pure resume with feedback injection.** ⚠️ Same subagent, same session. Orchestrator appends a new message: "Verifier says fix X, Y, Z." Subagent keeps its full working memory — knows what it wrote, why, what it tried. No re-briefing cost. **Tradeoff:** anchor bias — subagent may defend its prior choices. Contradicts V1.

**7b.A.2 Resume with amended instructions.** ⚠️ Same subagent, but the system prompt gets an addendum before the next turn. "Continue, but now respect constraint Z." Useful when verifier revealed the plan was incomplete, not when the work was wrong. **Tradeoff:** prompt layering can conflict with original brief.

**7b.A.3 Resume with compacted context.** ⚠️ Same subagent trajectory, but compacted first. Subagent's memory becomes "you tried X, it failed because Y, now do Z." Continuity without noise. **Tradeoff:** compaction quality determines outcome; bad summary = worse than fresh.

**7b.A.4 Partial resume / state transplant (V1-compatible).** Fresh subagent, but seeded with previous subagent's handoff + decision log. Fresh model, warm context. This is roughly V1's "curated context packet" pattern made explicit. **Tradeoff:** handoff quality determines outcome.

**7b.A.5 Subagent pool.** Orchestrator keeps warm role-initialized subagents. New task pulls from pool. Trades context freshness for latency. **Tradeoff:** pooled subagents accumulate stale state; needs rotation.

**7b.A.6 Hibernation.** Subagent state serialized on completion, resumed only if needed. Zero memory cost between resumes. **Tradeoff:** serialization/deserialization overhead; not all model providers support it cleanly.

**7b.A.7 Checkpointing.** Subagent can be restored to any prior turn, not just latest. "Try that again from when you were about to edit file X, but differently." **Tradeoff:** storage cost; useful only for genuinely exploratory tasks.

**7b.A.8 Time-boxed subagent.** Wall-clock cap per subagent. "10 minutes, return what you have." Forces decisive work. **Tradeoff:** can cut off productive work mid-thought.

**7b.A.9 Retirement protocol.** When subagent completes, it writes "what I did and why" to the ledger and is formally retired. Resurrection requires orchestrator decision. **Tradeoff:** adds ceremony; makes subagent identity explicit.

**When resume beats fresh:**
- Small fixes after verifier feedback — re-briefing cost > resume value
- Iterative refinement within a well-understood scope
- Bug-fixing that requires remembering what you already tried
- User requests a tweak post-completion

**When fresh beats resume:**
- First attempt was fundamentally misguided (sunk-cost lock-in)
- Working context is polluted with dead-end exploration
- Task changes category ("fix bug" → "rewrite module")
- Subagent has hit >N failed attempts in this session

**Proposed orchestrator rule:** decision is per-spawn based on verifier verdict. `fixable` → resume. `wrong approach` → fresh. User tweak → resume. User pivot → fresh. >N failures → fresh regardless.

### 7b.B Subagent specialization depth

V1's role prompts are skeletons. Specialization can go much further.

**7b.B.1 Prompt specialization.** Role prompt is pre-loaded with domain doctrine (React rules, DB migration patterns, API design conventions). BMAD, OMC, OMX all do this. **Tradeoff:** prompt bloat; stale content.

**7b.B.2 Context specialization.** Role-specific context filters at brief time — DB specialist gets schema + migrations + DB code; frontend gets components + design tokens. **Tradeoff:** filter rules to maintain per role.

**7b.B.3 Tool specialization.** Refactorer gets LSP rename + extract-function, not arbitrary shell. Test-writer gets coverage tool. Security reviewer gets AST query. Tool scope shapes behavior. **Tradeoff:** per-role tool configuration.

**7b.B.4 Model specialization.** Architect → expensive model. Implementor → standard coding model. Test-writer → fast cheap model. Route compute where it pays off. **Tradeoff:** multi-model prompt variance.

**7b.B.5 Skill specialization.** Role has pre-loaded skills packs. A React specialist has three React skills auto-attached. **Tradeoff:** skill inventory to maintain.

**7b.B.6 Example specialization.** Role prompt includes worked examples specific to that role and this codebase. "Here's what a good planner output for this repo looks like: ..." **Tradeoff:** examples go stale.

**Specialization levels:**
- **L0** — Bare role (name + one-line job). Too little.
- **L1** — V1 current. Role skeleton with do/don't + output contract. Generic.
- **L2** — Repo-specialized. Skeleton + AGENTS.md + repo fingerprint.
- **L3** — Role-skilled. Skeleton + skills pack for the role's domain.
- **L4** — Task-tailored. Skeleton + skills + task-specific watchouts.

V1 is at L1. L2 is cheap and almost always worth it. L3 and L4 have maintenance cost.

**7b.B.7 Named specialists vs role-bucketed.** Named ("FrontendImplementor," "DBImplementor") has nicer ergonomics but creates proliferation risk. Role-bucketed ("implementor, specialized per-spawn") stays lean. **Tradeoff:** named needs curation discipline.

**7b.B.8 Specialization by stage, not domain.** Underexplored axis — "planning implementor" vs "execution implementor" vs "polishing implementor" on the same task. Different lenses at different moments. **Tradeoff:** role proliferation; may not earn its keep.

**7b.B.9 `.cat-code/roles/` directory.** ⚠️ User-defined named specialists. Start empty; roles emerge from actual repeated tasks. Role inheritance — `frontend-implementor extends implementor`, adds React skill pack + prompt suffix. **Tradeoff:** contradicts V1's "three roles only" framing; matches V1's spirit of letting complexity earn its keep.

### 7b.C Communication patterns

V1 is strict — one-hop, orchestrator-mediated only. This area has more room.

**7b.C.1 Subagent clarification request.** ⚠️ Mid-run, subagent asks orchestrator a clarifying question before proceeding. V1 allows this implicitly; make it a first-class tool (`ask_orchestrator`). **Tradeoff:** round-trip cost; worth it to avoid wasted work on wrong assumptions.

**7b.C.2 Broadcast briefing.** One brief → N subagents. Parallel attempts at same task (see §7b.E on parallelism). **Tradeoff:** expensive; only for speculative/race patterns.

**7b.C.3 Relay handoff.** A finishes phase 1 → B takes phase 2 with A's handoff packet. V1's implicit default. Keep.

**7b.C.4 "Ask previous subagent" as a tool.** ⚠️ New subagent can query a retired subagent's handoff as a tool call, not by being re-briefed with it. Lazy context loading. **Tradeoff:** requires retired subagents to stay queryable; storage + query infra.

**7b.C.5 Shared whiteboard.** ⚠️ Single markdown file all subagents on a run can read. Orchestrator writes decisions to it; subagents treat it as shared ground truth. **Tradeoff:** whiteboard rot; needs orchestrator to own writes.

**7b.C.6 Subagent-to-subagent messaging via orchestrator.** ⚠️ Subagent A needs something from B's work; message goes A → orchestrator → B. V1 forbids direct A↔B; this preserves that but allows mediated exchange. **Tradeoff:** orchestrator becomes router; prompt for the routing logic.

**7b.C.7 Subagent escalation to user.** Subagent can request direct user clarification (orchestrator relays) instead of guessing. **Tradeoff:** re-approval fatigue if not tightly scoped.

### 7b.D Failure-response patterns

**7b.D.1 Replace with fresh of same role.** V1 default on `wrong approach`. Keep.

**7b.D.2 Retry same subagent with amended prompt.** ⚠️ "Try again, but don't use recursion this time." Cheaper than fresh when the issue is narrow. **Tradeoff:** anchor bias again.

**7b.D.3 Downgrade model and retry.** Sometimes expensive model over-thinks. Cheap model with same task. **Tradeoff:** cheap model may miss nuance the expensive one caught.

**7b.D.4 Upgrade model and retry.** Cheap model stuck → escalate to expensive. **Tradeoff:** cost; use when signals suggest capability ceiling, not just bad luck.

**7b.D.5 Decompose and retry.** Orchestrator splits failed task into smaller pieces, spawns fresh subagents for each. **Tradeoff:** re-planning cost; but often the right move.

**7b.D.6 Role promotion.** Implementor failed three times on a regex? Spawn a regex-specialist. **Tradeoff:** requires specialist roles to exist.

**7b.D.7 Subagent bail.** Subagent can return "I don't know how to do this" with evidence, rather than flailing until time runs out. **Tradeoff:** needs prompt discipline to prevent premature bail.

### 7b.E Parallelism patterns

**7b.E.1 Broad parallel.** N subagents on N slices of work (different files/modules). V1 mentions this with worktrees. Keep.

**7b.E.2 Speculative parallel.** N subagents on the *same* task, different approaches. Orchestrator picks best via verifier diff comparison. Cursor's best-of-N is this. **Tradeoff:** N× cost; worth it for high-stakes passes.

**7b.E.3 Race.** Two approaches start simultaneously; first to complete with passing verification wins, other cancelled. **Tradeoff:** wastes the losing branch's compute; useful when latency matters.

**7b.E.4 Pipelined.** Implementor phase 1 starts while planner produces phase 2 plan. Overlapping phases for throughput. **Tradeoff:** if phase 2 plan changes phase 1, rework. Fragile.

**7b.E.5 Divergent-convergent.** Intentionally diverge ("try approach A" vs "try approach B"), then converge via debate or verifier. **Tradeoff:** deliberate duplication; only for genuinely open architectural calls.

### 7b.F Decision & arbitration

**7b.F.1 Single verifier verdict.** V1 default. Keep.

**7b.F.2 Council voting.** N independent verifiers, majority rules. OMC pattern. For high-stakes architectural calls. **Tradeoff:** N× verification cost.

**7b.F.3 Debate.** Two subagents argue opposing positions; orchestrator adjudicates. **Tradeoff:** theatrical if not tuned; useful if calibrated.

**7b.F.4 Red-team/blue-team.** Implementor implements, red-team subagent tries to break it, blue-team defends. `everything-claude-code` uses this for security. **Tradeoff:** 3× cost; reserve for security-sensitive work.

**7b.F.5 Champion/challenger.** Current "champion" output vs challenger's attempt. Loop until no better. **Tradeoff:** can loop indefinitely; needs cap.

### 7b.G Escalation chain

**7b.G.1 Implicit escalation (V1).** Orchestrator escalates to user when stuck. Keep.

**7b.G.2 Per-decision escalation tiers.** Small: subagent autonomous. Medium: subagent confirms with orchestrator. Large: orchestrator confirms with user. Risk-tiered. **Tradeoff:** tier classification overhead.

**7b.G.3 Named escalation paths.** "Architecture question → Architect role. API design → Designer role." Pre-declared routing. **Tradeoff:** needs specialist roles to exist.

**7b.G.4 Subagent-initiated escalation.** ⚠️ Subagent says "above my role," orchestrator spawns senior role. **Tradeoff:** subagents over-escalating; needs prompt calibration.

### 7b.H Orchestrator "shape" patterns

**7b.H.1 Single orchestrator (V1).** Keep.

**7b.H.2 Orchestrator as implementor occasionally.** V1 hints at this. Make it explicit — orchestrator may do direct work when delegation overhead outweighs value. **Tradeoff:** orchestrator context bloats with implementation state.

**7b.H.3 Orchestrator as pure dispatcher.** ⚠️ Strict version — orchestrator never edits, only routes. Forces clean separation. **Tradeoff:** contradicts V1's judgment-call stance; more ceremony for trivial work.

**7b.H.4 Hierarchical orchestrator.** ⚠️ Lead orchestrator + sub-orchestrators for major sub-tasks. V1 explicitly avoids this. **Tradeoff:** complexity explosion; but some tasks genuinely have sub-structure.

**7b.H.5 Orchestrator with its own role prompt.** Orchestrator isn't just "the controller" — it has a codified role with judgment rules, examples, anti-patterns. Same treatment subagents get. **Tradeoff:** prompt tuning work; but V1's orchestrator doctrine already implies this.

**7b.H.6 Orchestrator as just another subagent.** ⚠️ Collapse the distinction. A "meta" role that happens to be the entry point. Simpler system but removes V1's control-plane separation. **Tradeoff:** loses V1's context-shape discipline.

### 7b.I Context shape per subagent

**7b.I.1 Layered prompts.** Base orchestrator rules + role rules + task rules + repo context. CSS-specificity style. **Tradeoff:** layer conflicts.

**7b.I.2 Context budget per role.** Planner 8K, implementor 30K, verifier 15K. Enforced at briefing. **Tradeoff:** can clip important context; need fallback.

**7b.I.3 Private scratchpad per subagent.** ⚠️ Append-only workspace subagent can write to. Other subagents read (if granted) but not write. **Tradeoff:** storage; scratchpad rot.

**7b.I.4 Subagent memory file.** ⚠️ Each named subagent has a memory file that persists across invocations within the run. Survives compaction. **Tradeoff:** only works with named subagents (see 7b.B.9).

**7b.I.5 Context diff at resume.** When subagent resumes, inject diff of what changed in the repo since last run. Prevents implicit-state-decay. **Tradeoff:** diff noise if changes are large.

**7b.I.6 "Here's what other subagents tried" context.** ⚠️ When a fix subagent spawns, it sees prior attempts as warning context — doesn't repeat mistakes. **Tradeoff:** context bloat; may anchor to prior approaches.

### 7b.J Prompt evolution & learning

**7b.J.1 Static role prompt (V1).** Keep as default.

**7b.J.2 Role playbook per repo.** ⚠️ A living `.cat-code/roles/implementor-playbook.md` that evolves based on what worked in this repo. Loaded on every implementor spawn. **Tradeoff:** playbook rot; needs curation.

**7b.J.3 Prompt evaluation.** Regularly eval role prompts against canonical tasks. Underperforming prompts flagged for revision. **Tradeoff:** eval harness work.

**7b.J.4 Subagent retrospection.** Each subagent writes "what I learned" at end. Feeds into future subagents in the same role. **Tradeoff:** small inference cost; useful only if retrospections are read.

### 7b.K Meta-patterns

**7b.K.1 Mentor/mentee pairing.** Senior role drafts approach, junior implements under senior's review. **Tradeoff:** 2× cost for quality gain.

**7b.K.2 Planner-implementor partnership.** ⚠️ Same planner stays "assigned" across multiple implementor spawns — reviews diffs from planning perspective, answers clarification questions. **Tradeoff:** planner context grows; but answers clarifications without re-briefing.

**7b.K.3 Context curator role.** ⚠️ Dedicated subagent whose only job is building context packets for other subagents. Reads repo + AGENTS.md + prior runs, distills into briefs. Read-only, cheap model. **Tradeoff:** extra role; but offloads curation from orchestrator.

**7b.K.4 Role contract validation.** Before orchestrator accepts a subagent's output, validate it matches the role's output schema. Reject and retry on malformed output. Runtime-enforced. **Tradeoff:** needs schemas defined per role.

**7b.K.5 Hot-swap model mid-run.** ⚠️ Subagent context transfers (compacted), underlying model changes. Useful when cheap is stuck or expensive over-thinks. **Tradeoff:** context transfer fidelity; different models have different prompt expectations.

**7b.K.6 Subagent-initiated re-plan.** ⚠️ Subagent raises `re-plan-needed` signal when it discovers the plan is wrong mid-execution. V1 says orchestrator owns re-plan; this contradicts. **Tradeoff:** subagents over-triggering re-plan; needs prompt calibration.

**7b.K.7 Subagent with mini-orchestrator for complex sub-tasks.** ⚠️ Big implementation legitimately has sub-sub-tasks. V1 forbids hierarchical orchestrators. **Tradeoff:** complexity; mostly not worth it for solo.

**7b.K.8 Stateful workers across runs.** ⚠️ A named subagent whose memory persists across runs in the same repo. "DBImplementor remembers the schema conventions from last time." **Tradeoff:** contradicts V1's fresh-by-default doctrine fundamentally; matches Claude Code's memory-from-chat-history direction.

### 7b.L Taxonomy — axes that matter

If you're organizing V2's subagent model, the axes to decide on explicitly:

1. **Lifetime:** fresh per spawn / resumable within run / persistent across runs
2. **Identity:** anonymous / role-bucketed / named / named+versioned
3. **Specialization depth:** generic / role-prompted / role+context / role+skills+tools+model
4. **Communication:** one-hop only / orchestrator-mediated multi-hop / shared whiteboard / direct
5. **Decision authority:** subagent suggests only / subagent decides within scope / subagent can escalate / subagent can re-plan
6. **Failure response:** replace fresh / resume with feedback / retry with amended brief / escalate
7. **Parallelism:** serial default / opportunistic parallel / speculative parallel / racing

**V1 picks:** fresh, anonymous, role-prompted, one-hop, suggests-only, replace-fresh, serial-default.

Moving to resumable (7b.A) and role+context (7b.B) — the two most natural V2 upgrades — cascades into:
- Compaction strategy changes (resumable subagents don't need aggressive compaction between passes)
- Communication patterns change (persistent subagents can answer questions from new ones)
- State storage changes (each named subagent wants a memory file)

### 7b.M Failure modes to watch

- **Anchor bias on resume.** Subagent defends prior choices instead of reconsidering. Mitigation: phrase verifier feedback as "user wants X" not "you did this wrong."
- **Context bloat on resume.** Every resume adds turns. Eventually compaction kicks in and loses the state that made resume useful. Mitigation: proactive compaction at resume boundaries.
- **Implicit state decay.** Subagent remembers something no longer true (you committed since). Mitigation: diff-sync at resume.
- **Specialization cargo-culting.** Adding roles because BMAD has them, not because they help. Mitigation: every named role must pass "removing this, does output get measurably worse?"
- **Role proliferation.** Named roles multiply; each has a prompt to tune. Mitigation: roles emerge from real repeated patterns, don't pre-declare.
- **Sunk-cost lock-in.** Resumed subagent keeps pursuing a failing approach. Mitigation: >N failures → force fresh.

---

## 8. Verification strategies

**8.1 V1 three-check verifier (design, correctness, review).** Keep. Works.

**8.2 Sandbox-validated patches (Vercel Agent pattern).** Before a patch is presented as "done," it runs in a sandbox with real builds/tests/linters. Only validated patches reach the user. **Tradeoff:** sandbox infrastructure; heavier than V1's direct-on-repo approach.

**8.3 Visual verification with Playwright/Puppeteer.** For UI-touching tasks, verifier takes before/after screenshots + DOM dump and evaluates visual diff. Cursor 3 does this with cloud agents; Claude Code has it in CLI research preview. **Tradeoff:** browser infrastructure; worth it only for UI work.

**8.4 Property-based test generation as a verifier step.** For functions with clear types, auto-generate PBTs and run them as part of verification. Catches edge cases unit tests miss. **Tradeoff:** PBT generation is its own rabbit hole.

**8.5 Eval-based verification (Skills 2.0 pattern).** If the repo has evals defined, verifier runs them in addition to tests. Treats evals as first-class verification signal. **Tradeoff:** most repos don't have evals yet; adoption lag.

**8.6 Security scanner as verifier step.** AgentShield / ecc-agentshield pattern — scan diff for common vulnerabilities (secrets, injection, unsafe patterns) before completion. **Tradeoff:** noise if overly sensitive; useful for repos with security sensitivity.

**8.7 Verifier with adversarial mode.** High-stakes tasks: verifier runs in "attacker" mode and tries to find exploits in the implementation. Red-team/blue-team pattern from everything-claude-code repo. **Tradeoff:** expensive; reserve for security-relevant tasks.

**8.8 Diff-only review for speed.** For small changes, verifier looks at diff only (not full files). Faster, cheaper, matches how human code review works. **Tradeoff:** misses context-dependent issues.

---

## 9. Drift detection & quality control

**9.1 Mid-implementation drift check.** V1 checks design-vs-code at verification time. Add a lightweight mid-implementation check: after N files changed, a fast check against the plan to catch drift early. **Tradeoff:** extra inference; catches waste before it compounds.

**9.2 Explicit drift categories.** Drift can be: scope creep (more files than planned), approach change (different pattern than planned), or goal drift (doing something else entirely). Verifier reports category, not just "drift detected." **Tradeoff:** needs taxonomy; worth it if you hit drift often.

**9.3 Change impact analysis.** Before implementor touches a file, run "what depends on this" via LSP. If the impact radius is huge, flag for re-planning. **Tradeoff:** LSP integration needed.

**9.4 Auto-rebase awareness.** If user made commits since the run started, orchestrator detects the conflict and decides: rebase workers, pause for approval, or abort. Current V1 is silent on this. **Tradeoff:** solo use probably doesn't hit this often.

**9.5 "Don't touch this" zones.** User can mark files/dirs as no-go in `.cat-code/zones.yaml`. Orchestrator and workers refuse to edit them even if plan wants to. Runtime enforcement, not prompt. **Tradeoff:** small maintenance burden.

---

## 10. Triggers & event-driven runs

**10.1 File-watcher triggers.** `.cat-code/triggers.yaml` maps file-change patterns to agent tasks. Example: on test-file save, run focused test validation. **Tradeoff:** can spam runs; needs debouncing.

**10.2 Git post-commit trigger.** After each commit, run a verifier-only pass against the diff. Catches issues before push. **Tradeoff:** slows down commit flow; user needs to accept async delay.

**10.3 Pre-push trigger.** Heavier check before `git push`: full verification, security scan, design-vs-code. If blocked, push aborts. **Tradeoff:** can be annoying; make it opt-in per repo.

**10.4 PR comment trigger (if integrated with GitHub).** Tag `@cat-code` in a PR comment, run an agent task scoped to that PR. Like Claude Code GitHub Actions, but local. **Tradeoff:** requires GitHub app or webhook setup; scope is "coding-focused slice" which may exclude this.

**10.5 Timer/cron triggers.** "Every Monday at 9am, run a dependency upgrade check." **Tradeoff:** venture territory for a solo coding tool; keep as optional.

**10.6 Agent triggers agent.** One completed run can trigger another. Example: implementation run completes → triggers doc-writing run → triggers commit+push run. **Tradeoff:** pipeline complexity; probably not core V2.

---

## 11. Cost, budgets, multi-model routing

**11.1 Per-run budget with soft/hard stops.** Run declares expected cost ("$0.50"). Warn at 50%, hard stop at 200% asking "continue with extended budget?" **Tradeoff:** needs accurate pre-run estimation, which is hard.

**11.2 Daily/weekly cap.** Cumulative spending cap across all Agent mode runs. Prevents runaway costs from bad runs. **Tradeoff:** can block urgent work; needs override.

**11.3 Multi-model routing within a run.** Cheap model for planning, strong for implementation, cheap for verifier summaries. Codex supports gpt-5-codex variants of different sizes. **Tradeoff:** more complex prompt engineering; different models have different quirks.

**11.4 Thinking-budget routing.** Codex and Claude both support effort levels. Planning = high, verification = medium, status summaries = low. **Tradeoff:** small complexity; good lever.

**11.5 Adaptive model selection.** Orchestrator starts with cheap model, escalates to strong when the cheap one blocks or fails verification. **Tradeoff:** adds retry latency; but the cost savings on "easy" tasks are real.

**11.6 Per-run cost telemetry in the ledger.** V1 has this. Make it first-class for review: `cat-code runs` lists recent runs with cost, duration, outcome. **Tradeoff:** small UI/UX work.

**11.7 Cost prediction pre-run.** After planning but before approval, show estimated cost to user. Approval can be contingent on budget. **Tradeoff:** predictions will be wrong; calibrate from actual history.

---

## 12. Plan UX & spec-driven patterns

**12.1 Plan-as-markdown (repeated from 2.1 for this theme).** Write `plan.md` to the run directory; user edits in-place; changes are the refinement input. **Tradeoff:** needs diff/commit detection.

**12.2 Expansion phase (already in V1).** Formalize: for vague tasks, planner produces a `spec.md` first, user approves spec, then planner produces `plan.md`, user approves plan. Two-gate flow for expensive work. **Tradeoff:** more ceremony; optional for simple tasks.

**12.3 Spec Kit integration or compatibility.** Spec Kit is becoming the cross-tool standard for spec-driven flows. Cat Code could read Spec Kit's `.specify/` directory if present and align its planning with it. **Tradeoff:** interop work; useful if user already uses Spec Kit.

**12.4 BMAD-style persona briefs (optional).** BMAD uses persona personas (PM, Architect, Developer). Cat Code could optionally load personas for roles — "planner acts as an architect for this repo." Adds domain flavor. **Tradeoff:** persona theater can become cargo-cult; use only if it measurably helps.

**12.5 Superpowers-style "can't skip" enforcement.** Superpowers uses persuasion principles to keep agents from skipping steps. Cat Code's orchestrator prompt could embed anti-skip anchors at phase boundaries. **Tradeoff:** prompt bloat; tune empirically.

**12.6 Plan versioning.** Every plan refinement creates a new version with diff from previous. Easy to see "what changed between v1 and v3 of the plan." **Tradeoff:** small file overhead; big clarity win for complex tasks.

**12.7 Plan quality self-check.** Before presenting plan to user, planner runs a self-review against criteria (is scope clear? are acceptance criteria testable? any TBDs?). Fixes issues inline. Like V1's "Spec Self-Review" but applied by the planner worker. **Tradeoff:** extra pass; cheap.

**12.8 Plan-only mode.** Run "agent mode but stop after plan approval — don't implement." User implements themselves. Useful for learning, exploration, or delicate work. **Tradeoff:** trivial to add; underrated mode.

**12.9 TDD-first mode.** Task goes: plan → write tests first (approved) → implement to pass → verify. Different state machine than default. **Tradeoff:** new mode; worth it if user already writes TDD.

**12.10 Refactor-only mode.** Stricter doctrine: "preserve all behavior, change structure only." Different verifier emphasis (behavior tests must match exactly). **Tradeoff:** narrow mode; useful when you do it.

---

## 13. Learning & retrospection

**13.1 Skill emergence from repeated patterns.** OMC's "skill learning" — extract reusable patterns from successful sessions into portable skill files. After run completes, ask user "save this as a skill?" **Tradeoff:** skill inventory grows; needs curation.

**13.2 Instincts (everything-claude-code pattern).** Small pattern files that auto-inject when relevant — "when you see X, do Y." Different from skills: narrower, more personal. **Tradeoff:** yet another artifact type; might duplicate AGENTS.md.

**13.3 Postmortem on every blocked run.** Auto-generate `runs/<id>/postmortem.md` with what happened, why it blocked, what would unblock it. Index across runs becomes failure-mode library. **Tradeoff:** minor write cost per block; useful only if you actually read them.

**13.4 "Pattern this project has."** After 10+ runs in a repo, orchestrator notices recurring patterns ("this repo uses dependency injection in service layer") and appends to AGENTS.md as suggestions. **Tradeoff:** can create cargo-cult rules; needs user review before commit.

**13.5 Per-run feedback prompt.** After each run, user rates: "did this go as expected? 1–5." Low ratings flagged for review. **Tradeoff:** annoying if prompted every run; maybe randomly sample.

**13.6 Eval suite for Cat Code itself.** Build a small eval harness that tests Cat Code's agent-mode behavior on canned tasks. Regression catch. **Tradeoff:** meta-work; only worth it once the product stabilizes.

---

## 14. Security & guardrails

**14.1 Secrets detection in diffs.** Before verifier passes, scan diff for common secret patterns (API keys, tokens, passwords). Block if found. Pattern from `ecc-agentshield`. **Tradeoff:** false positives on example code.

**14.2 Prompt injection defense in AGENTS.md / fetched content.** If the orchestrator fetches external content (docs, issues, MCP responses), strip or flag instructions that try to redirect behavior. Snyk found prompt injection in 36% of audited skills. **Tradeoff:** can over-filter useful content.

**14.3 Sandbox for untrusted execution.** Any `bash` tool call outside worktree boundary runs in a sandbox (Docker container, firejail, etc.). V1 refers to "permission and sandbox infrastructure" — make this explicit. **Tradeoff:** sandbox setup overhead.

**14.4 Network allowlist.** Workers can't hit arbitrary URLs. `.cat-code/network.yaml` defines allowed domains (npm registry, docs sites, specific APIs). **Tradeoff:** friction when a legitimate network call is needed.

**14.5 Secrets vault integration.** Agent needs creds? It asks the vault (1Password CLI, OS keychain), never reads from env or files directly. Zero-storage principle. **Tradeoff:** integration per vault.

**14.6 Dangerous-command detector.** Before a `bash` call runs, regex-scan for known-dangerous patterns (`rm -rf /`, `git push --force` to main, etc.). Block with approval prompt. **Tradeoff:** regex cat-and-mouse; combine with sandbox.

**14.7 "Blast radius" pre-check.** Before modifying a file, orchestrator computes blast radius (tests that depend, services that import). If above threshold, requires re-approval. **Tradeoff:** LSP/AST dependency.

---

## 15. Resumption, replay, interrupt, and task classification

**15.1 Graceful interrupt.** User hits Ctrl-C or types `/pause`: current worker finishes its current tool call, orchestrator checkpoints state, run is paused. Resume with `cat-code resume <run_id>`. **Tradeoff:** interrupt plumbing; needed for any long-running runs.

**15.2 Inject a message mid-run.** User can type a message while run is in progress; orchestrator receives it at next decision point as "user note: X." **Tradeoff:** can derail focused workers; needs decision gate.

**15.3 Rollback run.** Run turned out bad? `cat-code rollback <run_id>` — reverts the commits/worktree to pre-run state. Only works if run used phase-commits (see 5.3). **Tradeoff:** commits-per-phase dependency.

**15.4 Task classification: does this even need Agent mode?** Before entering the orchestrator, a lightweight classifier decides: trivial task → normal chat, complex task → Agent mode. Auto-downgrade avoids ceremony. **Tradeoff:** classifier can be wrong; user needs override.

**15.5 Two modes inside Agent mode: "quick" and "deep."** Quick skips expansion + some verification checks; deep runs everything. User picks at invocation. **Tradeoff:** knob proliferation; but the current single mode is a blunt tool.

**15.6 Scheduled resume.** Blocked run can be resumed automatically after N minutes if the block was a transient condition (service down, rate limit). **Tradeoff:** false retries on real blocks; use sparingly.

**15.7 Session handoff to normal chat.** Agent mode blocks → offer "drop into normal chat to investigate," keeping run state intact. User investigates, then resumes agent mode. **Tradeoff:** mode switching; minor UX work.

---

## 16. Environment & isolation

**16.1 Worktree isolation (already in V1).** Keep.

**16.2 Docker/container isolation for high-risk work.** Higher than worktree — full container with its own filesystem, network, and resources. For running untrusted build scripts or agent-generated scripts. **Tradeoff:** Docker dependency; slower.

**16.3 Ephemeral remote sandbox (Vercel Agent pattern).** Validate patches in a remote sandbox that mirrors prod environment. Overkill for solo, but cheap if provider offers. **Tradeoff:** cloud dependency; contradicts solo-local spirit.

**16.4 Per-worker resource limits.** CPU, memory, wall-clock caps per worker. Prevents runaway processes. **Tradeoff:** resource monitoring complexity.

**16.5 DB/service provisioning.** For tasks that need a running DB or service, orchestrator spins it up (docker-compose), lets workers use it, tears it down. **Tradeoff:** compose dependency; config per-repo.

---

## 17. Code intelligence tools

**17.1 LSP integration as orchestrator tool.** Symbol lookup, find-references, go-to-definition available to orchestrator for planning. Much richer than grep. OMC and OMX both integrate LSP. **Tradeoff:** LSP per language; setup cost.

**17.2 AST-based code search.** Structural search (tree-sitter) instead of text search. "Find all functions that call `fetch()`" as a first-class tool. **Tradeoff:** tree-sitter parser per language.

**17.3 Call graph / dependency graph as context.** Pre-computed for the repo, orchestrator can query "what depends on this module?" instantly. **Tradeoff:** graph maintenance; stale on fast-moving repos.

**17.4 Semantic code intelligence (Ctxo-style).** Symbol intelligence, change intelligence, dead-code analysis as tools. The "technical context layer" argument. **Tradeoff:** substantial new dependency.

**17.5 Test-impact analysis tool.** "Which tests cover this file?" as a first-class query. Speeds up verification. **Tradeoff:** needs coverage mapping.

---

## 18. Emerging / speculative ideas

**18.1 Agent self-grading before presenting.** Before showing plan/diff to user, agent grades its own output against rubric. If grade < threshold, retry internally. **Tradeoff:** can loop; need cap.

**18.2 Speculative exploration mode.** Agent runs 2-3 "what if" plan branches in parallel, presents them to user as alternatives. User picks one, others are discarded. **Tradeoff:** 3x cost; only for exploratory tasks.

**18.3 Confidence scoring.** Every handoff includes a confidence score (0-100). Orchestrator uses confidence to decide whether to extend verification or accept the result. **Tradeoff:** LLMs are famously miscalibrated; may need explicit calibration.

**18.4 Plan DSL.** Formalize the plan as structured YAML with goals, steps, gates, acceptance criteria. Machine-readable, can be validated. **Tradeoff:** reduces expressiveness; V1 explicitly chose flat plan over heavy object.

**18.5 Visual pipeline editor.** UI to visualize run state as a DAG. For solo use probably overkill. **Tradeoff:** UI work; not a v2 priority.

**18.6 Agent that writes its own evals.** For a given task, agent writes the eval test suite FIRST, then implements to pass it. Similar to TDD but the agent generates the tests. **Tradeoff:** risk of shallow evals; user should review.

**18.7 Agent negotiation pattern.** Two agents disagree? They debate, orchestrator adjudicates. Interesting for hard architecture calls; expensive. **Tradeoff:** theatrical if not tuned; useful if calibrated.

**18.8 "Risk tolerance slider" per run.** User picks low/medium/high risk tolerance at invocation. Low = more approval gates, slower; high = trust the agent. **Tradeoff:** knob; but matches how people actually work.

**18.9 Run-local plugin support.** Drop a plugin file in `.cat-code/plugins/` that can register custom tools, roles, verifier checks. **Tradeoff:** attack surface; lots of edge cases.

**18.10 Multi-repo task.** A task that spans multiple repos (monorepo or polyrepo). Orchestrator coordinates workers per repo, merges results. **Tradeoff:** big complexity; probably skip for solo.

---

## Groupings to consider (combinations that work well together)

**"Get to async-capable"** — 3.1 + 3.2 + 4.1 + 15.1. You can run long work safely and get notified.

**"Get smart about context"** — 1.1 + 1.2 + 1.3 + 6.3. AGENTS.md as the backbone of repo knowledge.

**"Get cost-aware"** — 11.1 + 11.3 + 11.6 + 11.7. Budgets + routing + visibility.

**"Spec-driven when it matters"** — 12.1 + 12.2 + 12.6 + 12.7. Plan UX that matches how code review actually works.

**"Production-grade quality"** — 8.2 + 9.1 + 9.2 + 9.5. Catch drift early, validate patches, protect no-go zones.

**"Learn over time"** — 5.6 + 13.1 + 13.3 + 13.4. The agent gets smarter about your specific repo across runs.

**"Safe by default"** — 14.1 + 14.3 + 14.6 + 2.7. Secrets detection + sandbox + dangerous-command guard + re-approval at point of no return.

---

## What to cut explicitly

These appeared in the research but don't fit V2's scope:

- Multi-channel inbox (Discord/Slack/iMessage as interfaces) — OpenClaw territory, not coding-focused
- Cloud/local handoff — Cursor 3 feature, overkill for solo local
- Remote control / mobile approval — nice but overscoped
- Persistent named workers / agent society — V1's fresh-by-default is the right call
- Multi-repo coordination — out of scope
- Heavy workflow state machine — V1 resisted this; keep resisting
- Enterprise governance/audit tooling — solo personal system
- Agent marketplace / plugin ecosystem — too early

---

## Questions for selection

As you mark up, these are the big forks that shape everything else:

1. **Do we want async-by-default or foreground-by-default?** If async, we need to commit to 3.1–3.4 as a package. If foreground, HUD (4.1) is still useful but notifications (3.2) become optional.

2. **How much do we trust prompt doctrine vs runtime guardrails?** V1 has a contradiction here. V2 needs to pick: numeric rails (OMC/Claude Code style) or pure doctrine (V1 top section). Affects 11.x, 14.x, 15.1.

3. **Structured handoffs or prose handoffs?** V1 says prose. Codex does structured well. 5.7 flips this.

4. **Does the orchestrator get code-intelligence tools (LSP/AST) or stay text-only?** Big architectural question. Affects 9.3, 14.7, 17.x.

5. **Do we introduce "quick" and "deep" variants of Agent mode, or keep it one mode?** 15.5. Affects whole UX.

6. **How many roles? Three default + optional Researcher (V1 intent, cleaned up), or richer specialist set (7.1)?**

