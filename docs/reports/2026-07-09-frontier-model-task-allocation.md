# Frontier-model task allocation — Cat Code fork behavior and performance

**Updated:** 2026-07-11

**Purpose:** Decide where a short-lived strongest model such as Fable 5 provides exceptional value in Cat Code.

**Scope:** Cat Code additions and material fork modifications only. Untouched upstream Claude Code is presumed good enough and is excluded.

## Conclusion

The previous ranking was mis-scoped. Its leading compaction and session-memory tasks primarily targeted inherited upstream text, its conversation-mapper audit centered on an unchanged upstream function, and its committed-log hazard is already guarded in current source.

The best use of a frontier model is not another isolated prompt rewrite. It is to improve the **fork-created behavioral control system** and leave behind judgment artifacts that cheaper models can reuse:

1. A behavioral constitution and benchmark for Cat Code's GPT and Agent Mode stack.
2. A durable truth and recovery model for long-running multi-agent sessions.
3. A canonical runtime-assembly contract so every Cat Code client gives the model the real engine context.
4. A semantic model for Codex continuation, reasoning replay, and cache fidelity.
5. An evidence-backed policy for provider instructions, model choice, reasoning effort, and delegation.

The central allocation principle is:

> Spend the frontier model on defining correct judgments and invariants, then let cheaper models implement and repeatedly execute them.

## Provenance method and limits

Three independent source sweeps covered the engine/Codex layer, intelligence and behavior surfaces, and the desktop/always-on runtime. A separate parent sweep focused on model behavior and performance.

The sweeps used:

- `f66f3ab7b5d918b9f3b999bd1be3fefd3330ea41` as the best locally available pre-Cat comparison tree.
- Post-baseline file history and explicit Cat Code commits.
- Current source and `docs/migration/STATUS.md`, not dated plans, for live behavior and migration state.
- Strong provenance only where a surface is absent from the comparison tree or has a material, explicit Cat-specific modification history.

Limits:

- No official Anthropic upstream remote is configured.
- Current history contains disconnected or grafted roots, including the later `86051a8` private publish snapshot.
- The comparison is therefore a local tree-to-tree provenance check, not proof against the latest upstream Claude Code.
- Pre-import provenance that could not be established was excluded rather than guessed.

## Selection standard

A candidate belongs near the top only when all of these are true:

1. **Fork-owned:** Cat Code created or materially changed the behavior.
2. **High leverage:** It affects many model turns, workers, sessions, or clients.
3. **Judgment-bound:** Ordinary tests cannot determine the correct policy or invariant by themselves.
4. **Silent failure risk:** A plausible but wrong result can look successful while degrading behavior, continuity, context, or confidence.
5. **Durable artifact:** The frontier pass can leave a benchmark, authority model, decision table, invariant specification, or compact doctrine.

Routine implementation, registry synchronization, known reproducible bugs, visual polish, and mechanically testable adapters belong to strong non-frontier models plus tests.

## Recommended top 10

### 1. Cat Code behavioral constitution and benchmark

**Owners**

- `src/constants/promptStyles/gpt.ts`
- `src/constants/prompts.ts`
- `src/agent-mode/orchestratorPrompt.ts`
- `src/agent-mode/rolePrompts.ts`
- `src/tools/AgentTool/prompt.ts`
- `src/utils/providerPromptRegressions.test.ts`
- `src/constants/prompts.test.ts`

**Current evidence**

Cat Code has a dedicated GPT instruction system, Agent Mode doctrine, provider-specific context placement, custom worker roles, and custom tool guidance. Existing tests mainly assert prompt text, schemas, and instruction placement. They do not establish whether the resulting model makes better decisions.

**Frontier deliverable**

Create a versioned corpus of realistic Cat Code tasks with gold judgments for:

- direct work versus delegation,
- Explore versus full-context research,
- implementation and verification ownership,
- tool choice and search stopping,
- persistence through multi-step work,
- risky-action boundaries,
- worker convergence and synthesis,
- long-session recovery,
- model and effort selection,
- acceptable behavioral alternatives.

Include known-bad prompt mutations so the benchmark proves it can detect regressions. Score correctness, unsupported claims, tool calls, duplicate investigation, worker count, retries, tokens, latency, cache use, and premature stopping separately.

**Why frontier-only**

Harness code is mechanical. Deciding what good judgment looks like, which alternatives are acceptable, and how to avoid optimizing toward superficial compliance requires the strongest model. The gold decisions are the durable asset.

### 2. Agent Mode durable truth, continuity, and recovery

**Owners**

- `src/agent-mode/sessionState.ts`
- `src/agent-mode/orchestratorPrompt.ts`
- `src/tools/AgentTool/agentToolUtils.ts`
- `src/tools/AgentTool/resumeAgent.ts`
- `src/tools/GetWorkerResultTool/GetWorkerResultTool.ts`
- `src/skills/bundled/agent-mode-compaction-recovery/SKILL.md`
- `src/services/compact/prompt.ts`

**Current evidence**

Worker identity and status can exist in task state, durable Agent Mode state, transcript metadata, process registries, worktrees, completion notifications, task output, and synthesis state. The normal doctrine generally prefers resuming relevant workers; the compaction-recovery skill prefers respawning unless prior context is still clearly load-bearing.

**Frontier deliverable**

Define one authority lattice covering:

1. filesystem and worktree state,
2. durable session and worker state,
3. worker transcript and metadata,
4. task output and completion notification,
5. compaction summary,
6. transcript inference.

Then define resume, steer, respawn, cancel, synthesize, and ignore decisions. Adjudicate interrupted-session fixtures covering research, implementation, blocked handoff, verification, pending synthesis, partial output, worktree divergence, process restart, and stale prior workers.

**Why frontier-only**

Local branch tests cannot decide which state plane should win when several individually valid records disagree. The wrong policy causes duplicated work, stale-context reuse, false completion, or loss of user intent without an obvious crash.

### 3. Canonical app-session runtime assembly

**Owners**

- `app/sidecar/sessionController.ts`
- `src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts`
- `src/app-runtime/createQueryEngineAppSession.ts`
- `src/app-runtime/appRuntimeCanUseTool.ts`
- `src/main.tsx`

**Current evidence**

Desktop still reconstructs normal engine setup in `app/sidecar/sessionController.ts`, including empty MCP client, server, tool, and command collections. The real engine assembles those values in `src/main.tsx`, while the reusable app-runtime seam already accepts a complete setup snapshot.

This is the same failure class that previously shipped valid shapes backed by `tools: []`, empty permission context, or `commands: []`.

**Frontier deliverable**

Define one normal-runtime setup owner for TUI, print, browser, and desktop sessions. Classify every dependency as snapshot, live view, controller-local, or process-global. Produce a parity matrix for tools, commands, agents, permissions, MCP clients/tools/commands/resources, settings, goals, model/effort, startup failures, and restored context. Prove the direction with one narrow extraction using real engine data.

**Why frontier-only**

The implementation is straightforward after ownership is settled. The difficult work is extracting the correct layer without creating another shape-correct but behavior-empty runtime personality.

### 4. Codex continuation and canonical context fidelity

**Owners**

- `src/services/api/codex-websocket-transport.ts`
- `src/services/api/codex-fetch-adapter.ts`
- `src/services/api/codex-continuation-e2e.test.ts`

**Current evidence**

Cat Code translates Claude-shaped history into OpenAI Responses items, preserves encrypted reasoning, canonicalizes tool calls and outputs, maintains `previous_response_id`, and tries to retain cache-compatible prefixes across reconnects and turns.

**Frontier deliverable**

Define the canonical identity of every replayed item family and distinguish:

- semantic equivalence,
- byte/cache equivalence,
- provider-managed identity,
- safe incremental continuation,
- required full resend.

Trace reasoning, function calls, custom tool calls, tool outputs, aborts, reconnects, account changes, compaction boundaries, and simultaneous forks. Produce counterexample traces and a differential corpus from real request and response shapes.

**Why frontier-only**

Fixtures can prove that a chosen equivalence relation passes. They cannot establish that the relation is correct across reasoning state, provider identity, transcript semantics, and future-turn cache behavior.

### 5. Provider-native instruction architecture and instruction budget

**Owners**

- `src/constants/promptStyles/gpt.ts`
- `src/constants/prompts.ts`
- `src/services/api/instructionAssembly.ts`
- `src/utils/systemPrompt.ts`
- `src/utils/queryContext.ts`

**Current evidence**

Cat Code created a second model-facing constitution for GPT and a provider-specific placement architecture. OpenAI receives stable instructions plus volatile developer context; Claude-style providers receive differently assembled system and user context. Delegation and execution doctrine is repeated across the GPT prompt, Agent Mode prompt, Agent tool prompt, and role prompts.

**Frontier deliverable**

Inventory every model-visible instruction and assign:

- one canonical owner,
- authority and priority,
- provider-specific rendering only where justified,
- stable versus volatile placement,
- always-on versus skill-loaded scope,
- intentional divergence versus accidental omission.

Produce a minimum viable GPT instruction stack and validate it with the behavioral benchmark. Measure instruction tokens, cache-prefix stability, task quality, tool-call validity, unnecessary searches, repeated-action loops, and latency.

**Why frontier-only**

This is not prose cleanup. Redundancy may improve adherence, waste context, or create competing policies. The correct reduction depends on observed model behavior and provider instruction semantics.

### 6. Evidence-backed model, effort, and worker allocation

**Owners**

- `src/utils/effort.ts`
- `src/utils/model/agent.ts`
- `src/tools/AgentTool/AgentTool.tsx`
- `src/tools/ClaudeCliTool/prompt.ts`
- `src/agent-mode/rolePrompts.ts`

**Current evidence**

Sol and Terra default to medium effort, Luna defaults to low, subagents normally inherit the parent, and the Agent tool discourages model overrides unless the user named one. These are safe static defaults, not a task-allocation strategy.

**Frontier deliverable**

Create an evidence-backed decision policy for:

- Sol, Terra, and Luna,
- low, medium, high, and maximum effort,
- direct execution versus workers,
- cheap reconnaissance versus deep implementation or review,
- inherited versus explicitly selected worker models,
- external Claude second opinions,
- cache continuity versus model-switch value.

Begin with instruction-level doctrine and benchmark it. Add automatic runtime routing only if instruction-driven selection is measurably unreliable.

**Why frontier-only**

The policy must balance ambiguity, task difficulty, false confidence, verification strength, latency, cost, and cache effects. A simplistic router will overuse either the cheapest or strongest model.

### 7. Cache-identical forked-agent semantics

**Owners**

- `src/tools/AgentTool/forkSubagent.ts`
- `src/tools/AgentTool/AgentTool.tsx`
- `src/tools/AgentTool/runAgent.ts`

**Current evidence**

Forked workers intentionally preserve parent prompt bytes, assistant tool-use blocks, placeholder tool results, exact tool schemas, model, provider, and reasoning configuration to maximize cache reuse.

**Frontier deliverable**

Define which prefix must remain identical and prove whether the resulting synthetic conversation remains semantically valid across providers. Cover simultaneous forks, placeholder tool results, stale inherited context, permissions, worktree path translation, recursive-fork prevention, cancellation, and completion.

**Why frontier-only**

Byte identity is mechanically testable. Whether those identical bytes communicate a truthful, safe, and useful child conversation is an architectural and model-behavior judgment.

### 8. Desktop turn-control contract

**Owners**

- `app/renderer/src/App.tsx`
- `app/sidecar/sidecarServer.ts`
- `app/renderer/src/connectionState.ts`
- `src/web/AppSessionWebSocketServer.ts`

**Current evidence**

Desktop rejects concurrent submission and disables input based on local state. It has a real abort path, but unlike the web runtime it lacks a complete explicit turn-status transition path. The product semantics of typing during a running turn remain unresolved.

**Frontier deliverable**

Define a closed state machine for idle, running, waiting for human input, abort requested, settling, and ready. Rule separately on:

- draft editing,
- queued next turn,
- steering,
- slash commands,
- permissions and plan pauses,
- Stop semantics,
- session switching and renderer reload.

Every accepted input must execute exactly once or be visibly returned; none may disappear silently.

**Why frontier-only**

Tests can validate a chosen state machine but cannot decide what user actions should mean or how steering, queuing, permissions, and cancellation should compose.

### 9. Worker handoff, verifier epistemics, and synthesis truth

**Owners**

- `src/agent-mode/rolePrompts.ts`
- `src/agent-mode/orchestratorPrompt.ts`
- `src/tools/GetWorkerResultTool/GetWorkerResultTool.ts`
- `src/agent-mode/sessionState.ts`

**Current evidence**

Cat Code has structurally mature implementor and verifier return contracts, but tests mainly assert source text. Reading and marking a result synthesized can occur in one tool operation even though doctrine says synthesis should be marked only after the result has actually been incorporated.

**Frontier deliverable**

Define what implementors must prove, what orchestrators may trust, when independent inspection is required, how uncertainty propagates, when a verifier may return partial, and when a worker result is truly synthesized. Build adversarial packets containing fabricated checks, irrelevant passing tests, persuasive but wrong patches, correct work with weak prose, and contradictory filesystem evidence.

**Why frontier-only**

A weaker model can produce perfectly formatted handoffs and still rubber-stamp work or erase decisive uncertainty. The hard problem is epistemic, not syntactic.

### 10. Codex account authority, refresh, leasing, and failover

**Owners**

- `src/services/api/codexAccountPool.ts`
- `src/codex-core/accounts.ts`
- `src/services/api/codexAccountLeaseManager.ts`
- `src/services/api/withRetry.ts`

**Current evidence**

The account system combines persisted refresh state, a raw-refresh ledger, process-local health, usage observations, hard 429 and 401 evidence, reset redemption, per-owner leases, active-account preference, and explicit standalone profile selection.

**Frontier deliverable**

Produce one authority table and state-transition model across vault, pool, lease, and retry layers. Analyze concurrent-process and crash interleavings, identity changes, stale usage polls, hard caps, token refresh, redemption, transient transport failures, and owner-local failover.

**Why frontier-only**

This is lower than the model-behavior candidates because it primarily affects availability. It remains frontier-worthy as a confidence task: local tests can encode an incoherent global authority model while every component appears correct in isolation.

## Bench candidates

These are valuable but should follow the top-ranked decisions or be delegated to strong non-frontier models.

### Unified human-intervention contract

Unify ownership, blocking, priority, expiry, and resume semantics across tool permissions, plan approval, AskUserQuestion, MCP elicitation, and blocked workers. Do not flatten their distinct security semantics into one generic modal queue.

Owners: `app/renderer/src/tabStatus.ts`, `app/renderer/src/orchestratorState.ts`, `app/renderer/src/App.tsx`, and the relevant sidecar domains.

### Full-context desktop resume fidelity

Classify model-visible tools, agents, permissions, goals, model/effort, MCP state, orchestration state, and interrupted work as durable, refreshed, recomputed, or intentionally dropped.

Owners: `app/sidecar/sessionResume.ts`, `app/sidecar/index.ts`, and `src/app-runtime/`.

### Fork-specific continuity-budget architecture

Reconcile wire-time tool truncation, history snipping, microcompaction, context collapse, session memory, normal compaction, Agent Mode compaction, and reactive overflow recovery. Measure successful resumption, not only token counts.

Owners: `src/query.ts`, `src/services/compact/`, and the Codex translation layer.

### Goal and memory authority

Define ownership, scope, versioning, conflict behavior, and retirement semantics for turn goals, session goals, and durable memory across same-workspace sessions and restores.

Owners: `src/app-runtime/AppSessionController.ts`, `app/sidecar/goalDomain.ts`, and `app/sidecar/memoryDomain.ts`.

### Auto Mode classifier calibration

Create a labeled action corpus for compound commands, reversible and destructive mixtures, environment boundaries, prompt injection, malformed output, and classifier fallback. Optimize weighted false-allow and false-block costs.

Owners: `src/utils/permissions/yoloClassifier.ts`, `src/utils/permissions/yolo-classifier-prompts/`, and `src/cli/handlers/autoMode.ts`.

### Session identity and lineage invariants

Define which IDs and metadata are copied, restamped, inherited, or discarded across normal resume, fork-session, subagent resume, Agent Mode worker reuse, compaction, cross-directory resume, desktop branch, rewind, rename, archive, and delete.

Owners: `src/utils/sessionStorage.ts`, `src/utils/sessionRestore.ts`, `app/host/registry.ts`, and `app/shared/hostApi.ts`.

### Always-on v2 host/client contract

Preserve locked v1 behavior while defining future daemon ownership, attach/detach, replay, unattended intervention, crash adoption, update handoff, and version skew. Produce a non-binding contract and failure matrix, not a daemon implementation.

Owners: `app/shared/hostApi.ts`, the host registry, and `docs/migration/decisions/SESSION-LIFETIME.md`.

## Rejected or corrected items from the previous report

### Broad base compaction-prompt rewrite — rejected

`src/services/compact/prompt.ts` contains inherited base prompt text. Only Cat Code's GPT and Agent Mode continuity branches qualify for this allocation.

### Core session-memory template redesign — rejected

The default session-memory template is inherited. Cat Code's provider-aware update behavior and cross-memory interactions are eligible, not the original template.

### Generic `toSDKMessages` conversation audit — rejected

The available local baseline shows no material Cat-specific change in the named mapper. Shared use by fork-created clients does not make unchanged upstream code a fork-owned frontier task.

### Committed-log landmine — stale

Current `src/services/compact/autoCompact.ts` guards the context-agent path before destructive cleanup. Focused regression verification is appropriate; a frontier investigation is not.

### Transcript and generic tool-card redesign — stale

P4-18b/c implemented the main transcript, tool-card, activity, Stop, scroll, and jump-to-latest work. Remaining checks and optional formatting dependencies are not frontier tasks.

### Basic liveness and Stop — stale

The real abort path is now wired. The unresolved frontier question is the deeper turn-control contract in rank 8.

### Startup, trust, OAuth, and Welcome — stale

P4-15 and P4-17 are built and reviewed. Remaining GUI acceptance and small follow-ups do not justify frontier allocation.

### Generic interaction doctrine and whole-app information architecture — too broad

Current concrete contracts—runtime assembly, turn control, human intervention, worker supervision, and session lineage—are more actionable and easier to assess.

### Straight MCP wiring — rejected

Do not hand-wire another sidecar-only path. Settle and extract the canonical runtime assembly owner first.

### Known parent-chain bugs as isolated fixes — defer

Known reproducible identity defects belong to a strong model plus focused tests. The frontier-worthy task is deriving the cross-mode identity invariant specification.

### Model catalog, schema renaming, diagnostics, and parser work — defer

These are fork-specific but mechanically specifiable. Use ordinary implementation and contract tests.

### Visual polish and release plumbing — defer

Syntax highlighting, word-level diff, paste styling, packaging, signing, and routine update plumbing are important but not frontier-only judgment work.

### Locked desktop decisions — excluded

Do not reopen Unix-domain-socket transport, N-process topology, raw event fidelity, the two-ID model, v1 die-with-window lifetime, or the desktop security minimum.

## Recommended one-day frontier assignment

### Primary assignment: behavioral constitution and benchmark

> Evaluate Cat Code's custom GPT and Agent Mode stack using realistic tasks, interrupted sessions, delegation choices, tool-use cases, and long-context scenarios. Establish gold decisions for model, effort, direct execution, worker selection, handoff evidence, convergence, and recovery. Use those results to simplify duplicated GPT instruction surfaces and define the long-session authority model. Measure correctness, unsupported claims, tool calls, duplicate investigation, worker count, retries, tokens, latency, and cache use. Exclude untouched upstream behavior.

This assignment leaves three durable assets:

1. A gold behavioral corpus.
2. A compact behavioral constitution with one owner per decision.
3. An authority and recovery model for long-running Agent Mode sessions.

### Alternative when the priority is runtime performance

Choose **Codex continuation and canonical context fidelity**. The deliverable is the semantic equivalence model and counterexample trace corpus, not an immediate rewrite of transport code.

### Alternative when the priority is desktop correctness

Choose **canonical app-session runtime assembly**. The deliverable is a settled ownership contract, cross-runtime parity matrix, and narrow proof that desktop receives real engine context.

## Recommended sequence beyond one day

1. Behavioral benchmark and gold judgments.
2. Agent Mode authority and recovery model.
3. GPT instruction architecture and model/effort allocation policy, evaluated against the benchmark.
4. Canonical app-session runtime assembly.
5. Codex continuation and fork-worker cache semantics.
6. Turn-control and human-intervention contracts.
7. Account authority and remaining identity/lineage specifications.

Do not implement all of these in one frontier session. The strongest model should settle the hard judgments and produce durable evaluation artifacts; bounded implementation can then be distributed to cheaper models with objective acceptance checks.
