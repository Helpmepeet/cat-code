# Context Compaction Architecture: Codex CLI, Hermes Agent, and OpenClaw

## Combined Technical Report

### 1. Executive Summary

Modern coding-agent compaction is no longer adequately described as “summarize old chat messages when the context gets full.” Across **OpenAI Codex CLI**, **NousResearch Hermes Agent**, and **OpenClaw**, compaction has evolved into a broader context-management subsystem covering token admission, semantic compression, raw-history retention, provider-owned checkpoints, replay, recovery, tool-output control, and post-compaction continuity.

All three systems now separate, to different degrees, the **durable conversation or rollout history** from the **context actually presented to the model**.

Their main architectural centers differ:

- **Codex is checkpoint/reconstruction-centric.** It increasingly treats compaction as a transition from one logical context window to another. Replacement history, window lineage, provider-owned opaque checkpoints, current runtime state, and canonical reinjection of instructions are more important than preserving every old message in textual form.
- **Hermes is archive/retrieval/cache-centric.** It combines local summarization with non-destructive archival, retrieval, carefully selected verbatim context, provider-aware token thresholds, persistent anti-thrash state, and explicit consideration of prompt-cache invalidation.
- **OpenClaw is summary-quality/failure-atomicity-centric.** Its safeguard mode actively checks whether summaries preserve pending asks and exact identifiers, and cancels compaction rather than installing a summary that fails the audit. It supplements this with memory flushing, tool-result pruning, provider checkpoints, and a post-compaction loop guard.

The useful common abstraction is therefore:

```text
durable history / external state
            ↓
context-pressure calculation
            ↓
cheap mechanical reclamation if possible
            ↓
semantic or provider-native checkpoint if needed
            ↓
retain selected recent/raw state
            ↓
reconstruct current instructions/runtime state
            ↓
install a new model-facing context
            ↓
validate liveness and continue
```

The strongest architecture for another agent would combine all three approaches rather than copying one implementation directly.

---

# 2. Scope and Provenance

This report combines three supplied research memos. Claims marked as architectural conclusions or recommendations are synthesis; implementation facts come from those memos.

| System | Repository / snapshot | Main subject |
|---|---|---|
| **Codex CLI** | `openai/codex`, inspected 2026-08-24, HEAD `fb0781b9...` | Context-window compaction in the Rust CLI/core runtime |
| **Hermes Agent** | `NousResearch/hermes-agent`, snapshot `3f5d3756...`, 2026-08-23 | Compression, retrieval, native compaction, micro-compaction and persistence |
| **OpenClaw** | `openclaw/openclaw`, commit `19d44d3f...`, 2026-08-23 | Compaction, safeguard auditing, memory flush, pruning and provider-native replay |

The Codex memo explicitly notes that its historical observations are based on public repository history rather than a complete local Git history. The OpenClaw memo states that its reachable local history begins around August 11, 2026, so its trend discussion covers only the recent period. Hermes is based on the listed local snapshot and associated implementation files.

---

# 3. Unified Architectural Model

The three implementations are easiest to compare as a stack of six layers.

## Layer 1 — Context-pressure accounting

The runtime first decides whether the current model-visible state is approaching an unsafe context size.

This includes more than message text. Depending on the system, accounting can include:

- system and developer instructions;
- recent dialogue;
- tool schemas;
- tool results;
- image estimates;
- reserved output space;
- provider-reported token usage;
- reusable/prefix context;
- incoming user content.

The goal is **admission control**: avoid sending an invalid request in the first place.

## Layer 2 — Mechanical reclamation

Before asking another LLM to summarize history, an implementation may mechanically remove low-value context.

Examples include:

- truncating large tool results;
- deduplicating identical outputs;
- replacing old tool results with stubs;
- retiring stale images;
- removing stale reasoning replay artifacts.

This is fundamentally different from semantic compaction.

```text
mechanical pruning:
    remove/shrink known low-value bytes

semantic compaction:
    replace old semantic history with a new representation
```

All three memos recognize this distinction, although they implement it differently. OpenClaw explicitly maintains an ephemeral tool-result pruning subsystem separate from true compaction, while Codex describes independent model/tool-output truncation policies. 
## Layer 3 — Semantic or native compaction

When ordinary reclamation is insufficient, the system creates a new representation of old history.

Possible representations include:

- a human-readable LLM handoff summary;
- a summary plus recent raw tail;
- an opaque provider-native checkpoint;
- a fresh context window reconstructed from explicit state without semantic summarization.

## Layer 4 — Persistence and recovery

A robust design should not confuse:

```text
what the model currently sees
```

with:

```text
what the runtime still knows
```

All three systems increasingly retain information outside the active prompt.

## Layer 5 — State reconstruction

After the old context is replaced, important live state may be reintroduced from authoritative runtime sources rather than trusting the summary.

## Layer 6 — Liveness controls

Compaction itself can fail, repeat, or leave the model in a pathological state. Mature implementations therefore require retry limits, failure handling, timeout behavior, and anti-loop controls.

---

# 4. High-Level Comparison

| Dimension | Codex CLI | Hermes Agent | OpenClaw |
|---|---|---|---|
| Core abstraction | Context-window replacement checkpoint | Recoverable compressed transcript plus archive/retrieval | Durable semantic compaction boundary |
| Main default strategy | Provider-aware; local/remote depending route | Local batch summarization | Local semantic compaction with safeguard |
| Threshold philosophy | Model-derived percentage | Effective-window + model/provider-specific policy | Context minus reserved headroom |
| Normal default boundary | ~90% resolved context | Often 50%, 75%, 85%, etc. depending model/route | `window - reserve` |
| Local raw retention | Recent real user messages, ~20K tokens | Protected head + token-budgeted recent tail | ~20K recent-tail target |
| Local textual summary | Yes | Yes | Yes |
| Strong semantic output audit | No equivalent found | Structured preservation rules, but different failure design | Yes, safeguard audit |
| Provider-native compaction | Major modern path | Optional for narrow eligible routes | Supported for OpenAI; Anthropic opt-in |
| Remote retained raw context | Remote v2 ≤64K eligible messages | Native replay retains bounded user/summary context | Provider/path dependent |
| Canonical runtime-state reconstruction | Strong/core mechanism | TODO/skills/memory/read state handled explicitly | Selected workspace reinjection is opt-in |
| Same-request overflow retry | Not normal Codex behavior | Yes | Yes |
| Durable raw-history recovery | Rollout/checkpoint history | Archived `state.db` rows | SQLite/session transcript |
| Retrieval-first recovery | Limited in core compaction design | Strongest, especially lean mode | Raw history/memory available, but less retrieval-centered |
| Post-compaction repeated-tool guard | No equivalent found | Anti-thrash at compaction level | Explicit repeated-tool guard |
| Cache economics | Present but not central abstraction | Explicit design priority | Present indirectly through pruning/provider behavior |
| Context-window lineage | Explicit first-class IDs | Session/compression lineage | Compaction/session boundary lineage |

---

# 5. Trigger Thresholds and Token Accounting

## 5.1 Codex

Codex normally derives its automatic compaction limit as:

```text
resolved context window × 0.90
```

If configuration supplies another auto-compaction limit, it chooses:

```text
min(configured limit, 90% of resolved context window)
```

Therefore configuration can cause earlier compaction but cannot normally push the threshold beyond the model-derived 90% ceiling.

Codex also has a separate default:

```text
effective_context_window_percent = 95
```

This acts as an independent effective/full-window limit. Conceptually:

```text
0% --------------------------------------- 100%
                    90%           95%
                     |              |
              auto compact     effective cap
```

Its accounting can operate in at least two scopes:

- **Total** — pressure against total active context.
- **BodyAfterPrefix** — subtract reusable/prefill prefix state and consider body growth separately.

A hard full-context limit remains independent of the auto-compaction boundary.

This indicates a relatively **runtime-oriented** pressure model: the system is not merely calculating characters or messages; it is reasoning about how the actual model context is structured.

---

## 5.2 Hermes

Hermes starts from an **effective input window**:

```text
effective_window =
    context_length
    - reserved_max_output_tokens
```

The configured default is:

```yaml
compression:
  threshold: 0.50
  target_ratio: 0.20
```

But actual admission is substantially more complicated than “compact at 50%.”

The basic calculation includes:

```text
percentage trigger = effective_window × percentage
trigger = max(percentage trigger, 64,000)
```

If that 64K floor would place the trigger at or beyond the usable window, Hermes falls back to 85% of the effective window.

Important policy variations include:

| Case | Effective trigger policy |
|---|---:|
| General model, ≥512K | Configured percentage; default 50% |
| Model under 512K | At least 75% |
| GPT-5.4/5.5/5.6 via Codex OAuth 272K route | 85% unless opted out |
| `gpt-5.3-codex-spark` on Codex OAuth | 70% |
| Arcee Trinity Large Thinking | 75% |
| Explicit `threshold_tokens` | Can establish an earlier absolute cap |

Hermes also distinguishes **estimated** and **real** usage.

Before a request, the estimator accounts approximately for:

- system prompt;
- messages;
- tool schemas;
- images.

After successful requests, provider-reported `prompt_tokens` becomes authoritative for deciding whether compaction actually reduced pressure. Hermes stores rough-vs-real observations to improve future projections.

This is particularly important for anti-thrash: a compressor that reduces message count but does not reduce the provider-visible prompt enough has not actually succeeded.

Hermes additionally verifies that an auxiliary summarization model has enough context to perform compression. Auxiliary models under 64K are rejected, and if the summarizer's capacity is below the normal main-session threshold, the live trigger is lowered accordingly.

---

## 5.3 OpenClaw

OpenClaw uses a reserve-oriented model:

```text
compact when:
current context tokens
    >
context window
    - effective reserve
```

Core/default values in the supplied memo include:

- core reserve: **16,384 tokens**;
- OpenClaw reserve floor: **20,000 tokens**, when model budget permits;
- recent-tail target: approximately **20,000 tokens**;
- preflight soft margin: another **4,000 tokens**;
- minimum prompt budget: `min(8,000, 50% of context window)`.

Its preflight soft boundary is therefore conceptually:

```text
context window
- 20K reserve
- 4K soft margin
```

The preflight system also examines incoming content rather than only the state left by the previous model response.

---

# 6. Trigger Lanes

A major common pattern is that one threshold is not enough.

## Codex trigger lanes

Codex supports:

- pre-turn admission;
- mid-turn rollover when another model request is required;
- manual `/compact`;
- app-server compaction;
- model-switch or model-downshift compatibility compaction.

Its mid-turn logic is important. Compaction happens when the turn still needs another request and either a new window was requested or the token limit was reached.

Thus:

```text
crossing threshold
does not necessarily imply
compact immediately after every response
```

If the turn is finished, compaction can wait until the next admission check.

---

## Hermes trigger lanes

Hermes has the broadest set of separate trigger surfaces in these materials:

- turn-start preflight;
- pressure checks inside a multi-tool loop;
- provider-overflow recovery;
- post-response real usage tracking;
- manual `/compress`;
- optional idle resume compaction;
- gateway hygiene for extreme message counts;
- optional micro-compaction;
- optional native/server-side compaction.

This reflects an architecture in which compression may be:

- proactive;
- reactive;
- periodic;
- operator-directed;
- provider-owned.

---

## OpenClaw trigger lanes

OpenClaw includes:

- post-turn threshold maintenance;
- preflight admission;
- provider-overflow recovery;
- manual `/compact`;
- provider-native mechanisms;
- an optional mid-turn check after tools, disabled by default.

OpenClaw's design therefore emphasizes **both preflight and post-turn maintenance**, whereas Codex primarily integrates rollover into pre-turn and continuation execution.

---

# 7. Local Semantic Compaction

## 7.1 Codex local algorithm

Codex's local compactor roughly performs:

```text
old history
    ↓
append compaction request
    ↓
normal model sampling
    ↓
extract final assistant handoff summary
    ↓
select recent real user messages
    ↓
build replacement history
    ↓
install checkpoint
```

It retains recent real user messages under:

```text
COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000
```

Selection proceeds newest-to-oldest, then the retained messages are restored to chronological order. A boundary message may be truncated. Previous summary pseudo-user messages are filtered from the “real user” selection.

Historical assistant messages, reasoning, tool calls, and tool results are generally **not retained verbatim** in the local compacted prompt. Their important meaning must survive in the handoff summary or other reconstructed runtime state.

The local summary prompt asks for a handoff containing:

- current progress;
- key decisions;
- constraints;
- preferences;
- next work;
- important data/references.

Unlike OpenClaw, the inspected Codex local path did not expose a separate fixed 16K-character summary cap.

---

## 7.2 Hermes local batch compaction

Hermes has a more elaborate batch pipeline.

Its compressor:

1. checks whether a real compressible middle exists;
2. prunes/deduplicates old tool output mechanically;
3. removes blank platform echoes;
4. protects the head;
5. selects a token-budgeted tail;
6. restores any previous summary;
7. summarizes the middle;
8. falls back from auxiliary to main model where appropriate;
9. either preserves the original or uses a deterministic fallback after failures;
10. assembles head + summary + tail;
11. repairs tool-call/result and role structure;
12. removes old media/reasoning replay data;
13. refuses a compaction that would make the transcript larger;
14. atomically writes the new active transcript while keeping prior messages archived.

### Head retention

On the first compaction:

- system message is protected;
- three additional non-system messages are protected by default.

After that first compaction, the extra protected-head count decays to zero. The system message remains protected, but early user turns do not become permanently immortal.

### Tail retention

Legacy tail budgeting is:

```text
tail budget =
    compaction trigger
    × target_ratio
```

with default `target_ratio = 0.20`.

Because the trigger percentage itself varies, the tail's size relative to the raw model window also varies.

Examples from the memo:

- approximately 10% of raw context with a 50% trigger;
- approximately 15% with a 75% trigger;
- approximately 17% with an 85% trigger.

The tail selection also respects structural anchors:

- do not split tool-call/result groups;
- retain at least a small recent-message floor;
- retain the latest actionable user request;
- retain the newest visible assistant answer;
- retain at least one real user message by default.

### Structured handoff

Hermes's summary includes explicit sections such as:

- Historical Task Snapshot;
- Goal;
- Constraints & Preferences;
- Completed Actions;
- Active State;
- Blocked;
- Key Decisions;
- Errors & Fixes;
- Resolved Questions;
- Relevant Files;
- Critical Context;
- optional Pruned Skills.

The summarizer is told to preserve the latest unfulfilled user request, security constraints, paths, line numbers, commands, errors, counts, decisions, corrections and conversation language.

This makes Hermes's summary contract substantially more prescriptive than Codex's generic handoff, though it does not use OpenClaw's exact post-generation safeguard model.

---

## 7.3 OpenClaw local compaction

OpenClaw selects a recent tail by walking backward while respecting message structure.

It:

- cuts only at valid boundaries;
- avoids treating isolated tool results as safe cut points;
- preserves call/result pairing;
- handles split turns by summarizing the old portion and retaining the suffix;
- prefers real provider usage when available;
- allows re-compaction if the result is still oversized.

Its generic summary has a structured contract:

```markdown
## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
## Critical Context
```

Unlike Codex's inspected local compactor, OpenClaw has a hard summary cap:

```text
16,000 UTF-16 characters
```

This can discard detail even when there would still be token budget remaining.

---

# 8. Summary Quality and Continuity

This is where OpenClaw differs most sharply.

## 8.1 OpenClaw safeguard

New OpenClaw configurations default to a **safeguard** mode.

The summary must preserve categories including:

- decisions;
- open TODOs;
- constraints/rules;
- pending user asks;
- exact identifiers.

The resulting output is audited.

Checks include:

- required headings;
- overlap with the latest pending user request;
- preservation of up to 12 likely opaque identifiers from recent messages.

If the audit fails, OpenClaw asks for corrective regeneration.

If that still fails, compaction is cancelled.

Critically:

```text
failed quality audit
    ≠
successful compaction
```

The system does not append a false compaction boundary and leaves the original usable history intact.

Safeguard also directly preserves recent user-led turns, default three, although each rendered message has a 600-character bound and this preserved material shares the overall summary budget.

---

## 8.2 Codex

The inspected Codex paths do not expose an equivalent semantic audit.

Local compaction accepts the successful generated handoff; remote v2 validates the structure of the provider response, including the requirement for exactly one compaction item.

It does not perform OpenClaw-style checks such as:

- required semantic headings;
- pending-user-request preservation;
- opaque-ID preservation;
- automatic corrective regeneration.

Instead, Codex's continuity defense focuses on:

- directly retained user messages;
- a larger remote retained tail;
- reconstructed current context;
- metadata preservation;
- context-window lineage;
- checkpoint persistence;
- model compatibility.

---

## 8.3 Hermes

Hermes takes a third approach.

Its prompt places strong preservation requirements on the summarizer and explicitly keeps important tail anchors, while its failure system can preserve the source transcript or generate a deterministic fallback depending on configuration and failure class. 
Thus the rough distinction is:

```text
OpenClaw:
generate → audit → commit

Hermes:
structure + retain anchors → generate → fallback/abort policy

Codex:
generate/check response structure → install checkpoint
while relying heavily on reconstructed runtime state
```

---

# 9. Summary Budgets and Loss Boundaries

## Codex

Local Codex has no separate hard character cap identified in the inspected compactor. The summary is primarily bounded by normal model-response constraints. Its main explicit raw-user retention budget is approximately 20K tokens.

## Hermes

Hermes targets:

```text
20% of estimated middle-region tokens
```

clamped to:

```text
minimum: 2,000 tokens
maximum: min(5% of model context, 10,000 tokens)
```

However, this is only a requested summary target in the prompt. The normal batch request intentionally does not impose a wire-level `max_tokens` at 10K.

Hermes also truncates what reaches the summarizer:

- each message body: 6,000 characters;
- oversized bodies preserve approximately 4,000 front + 1,500 rear;
- tool-call arguments: 1,500 characters;
- total serialized middle: 160,000 characters;
- aggregate truncation roughly favors 45% early and 55% recent content.

Therefore Hermes can preserve the original durable transcript while still giving the summary model a deliberately lossy projection.

## OpenClaw

OpenClaw's key hard boundary is:

```text
16,000 UTF-16 characters
```

for the textual summary. Its safeguard mechanism tries to allocate that limited space intelligently, but the result remains intentionally lossy.

---

# 10. Provider-Native Compaction

Provider-native compaction is a major trend across all three systems.

## 10.1 Codex Remote Compaction v2

Codex remote v2 uses the normal Responses transport with a compaction trigger and receives an opaque server-generated compaction item.

Its retained plaintext budget is:

```text
RETAINED_MESSAGE_TOKEN_BUDGET = 64_000
```

There is also:

```text
MAX_RETAINED_AGENT_MESSAGE_TOKENS = 10_000
```

so very large agent messages may be excluded before the final eligible retained set is budgeted.

The process:

1. collects prompt items with metadata;
2. groups associated items;
3. filters to eligible history types;
4. applies compaction-retention policy;
5. optionally keeps qualifying client developer messages;
6. flattens the selected items;
7. truncates to 64K;
8. appends the opaque provider checkpoint.

Therefore:

```text
64K retained budget
≠
last 64K tokens of raw history
```

It is 64K over the **eligible retained projection**.

Remote v2 validates structural conditions such as successful completion, exactly one compaction item, and a response ID. It cannot semantically inspect the hidden checkpoint.

---

## 10.2 Hermes native Responses compaction

Hermes has an opt-in native Responses route.

Defaults include:

```yaml
codex_responses_native: false
codex_responses_compact_threshold: 200000
```

Eligibility is deliberately narrow in the supplied snapshot, focusing on GPT-5.6-family direct OpenAI/ChatGPT Codex routes rather than arbitrary relays or providers.

The configured native threshold is clamped below the Hermes local trigger so the provider receives the first opportunity to compact. Local compression remains available as fallback.

Hermes persists the opaque provider item and later replays it.

When replaying, it can retain:

- up to ~64K tokens of plaintext user messages;
- up to ~32K tokens of Hermes local summaries.

If the provider rejects `context_management`, Hermes disables native ownership for that session and retries with local compaction.

When Hermes is driving a Codex app-server thread, it delegates compaction to Codex because Hermes's local copy is not the actual remote context.

This is an important general principle:

> The component that owns the actual model context must own, or at least participate in, compaction.

---

## 10.3 OpenClaw provider compaction

For eligible stored OpenAI Responses routes, OpenClaw enables automatic provider compaction by default unless disabled.

Without an explicit threshold, the normal threshold is about:

```text
70% of the smaller active context budget
```

with an 80K fallback where necessary.

OpenClaw retains the complete local transcript while omitting the replaced prefix only from the provider-facing request.

It also supports a direct `/responses/compact` path under specific policies, with local fallback on failure.

Anthropic server compaction is opt-in and uses approximately:

```text
max(50,000, 70% of active context)
```

The provider checkpoint remains opaque, meaning OpenClaw's normal textual safeguard cannot audit it.

---

# 11. Persistence and Recovery

## 11.1 Codex: replacement-history checkpoint

Codex persists a compacted rollout item containing replacement history and context-window metadata.

Concepts include:

- replacement history;
- window number;
- first window ID;
- previous window ID;
- current window ID;
- checkpoint/provenance state.

The raw rollout remains an audit/history source, but future model context can resume from a recent replacement checkpoint instead of replaying every historical item.

This is effectively an event-log plus checkpoint design.

---

## 11.2 Hermes: archive, do not delete

Hermes defaults to:

```yaml
compression:
  in_place: true
```

Compaction is non-destructive:

- previous active rows become inactive/archived;
- new compacted rows become active;
- both remain associated with the same session;
- normal resume reads the active representation;
- archived history remains searchable.

This creates an important separation:

```text
active prompt = lossy

stored transcript = recoverable
```

Hermes also supports session rotation rather than in-place replacement. In that mode, it creates a continuation child while preserving the parent transcript and migrating runtime state.

---

## 11.3 OpenClaw: durable compaction boundary

OpenClaw's local true compaction appends a record containing concepts such as:

```text
type: compaction
summary
firstKeptEntryId
tokensBefore
details
fromHook
```

Future model context is reconstructed from:

1. the latest summary;
2. retained entries between the cut point and boundary;
3. entries written after that boundary.

Older entries remain stored in SQLite/session state.

---

# 12. Context-Window Lineage

Codex makes window identity especially explicit.

Recent development added IDs representing relationships between context windows. The system can reason about:

- which window replaced which;
- whether output belongs before or after compaction;
- replay boundaries;
- model-switch transitions;
- analytics;
- cross-request continuity.

This changes the conceptual model from:

```text
one conversation
whose messages occasionally shrink
```

to:

```text
one durable rollout
containing multiple logical context windows
```

Hermes expresses similar ideas through session/compression lineage, while OpenClaw uses compaction records, successor-session controls, and persisted session state. But Codex is the system in these materials where **window identity itself is most clearly first-class**.

---

# 13. Runtime-State Reinjection

## Codex

Codex explicitly distinguishes current runtime state from lossy semantic history.

Depending on compaction phase, it can reconstruct current initial context containing items such as:

- base/model instructions;
- sandbox and permission state;
- workspace/developer instructions;
- environment state;
- collaboration/personality configuration;
- plugin/tool context.

Rather than demanding that an old summary preserve these indefinitely, the runtime recreates current state from authoritative sources.

This is one of Codex's strongest design properties.

---

## Hermes

Hermes handles several forms of state after compression:

- current TODO snapshot can be reinjected;
- pruned skill bodies can leave deterministic reload markers;
- recently relevant skills are protected where possible;
- file-read and `skill_view` dedup caches are reset so omitted information can be re-read;
- `MEMORY.md` and `USER.md` remain authoritative according to the handoff framing. 
This reflects a retrieval/reload approach: an omitted item need not remain permanently embedded in every prompt if the agent has a reliable method to fetch it again.

---

## OpenClaw

OpenClaw can reinject configured sections of `AGENTS.md` after compaction.

Examples include startup and critical-rules sections.

However, this is **opt-in**. Missing configuration means no automatic selected-section reinjection.

Therefore OpenClaw relies more heavily on summary preservation, memory files, and explicit configuration than Codex's canonical context reconstruction.

---

# 14. Pre-Compaction Memory

OpenClaw has the strongest explicit memory-compaction coupling.

Before compaction it can perform a silent durable-memory flush.

Relevant defaults include:

- enabled unless explicitly disabled;
- soft threshold 4K tokens before reserve;
- reserve floor 20K;
- forced transcript threshold 2 MiB;
- maximum three failures per compaction cycle.

The maintenance operation is intentionally constrained:

- silent;
- read/write tools only;
- append-only write behavior;
- protected bootstrap/reference files;
- completion persisted against the current compaction cycle.

After three failures, it stops trying for that cycle so memory maintenance cannot permanently block the session.

Codex's inspected core compaction subsystem has no direct equivalent transaction. Its continuity mechanism is more separated from memory storage. Hermes integrates external memory lifecycle callbacks around compression, but its architecture is still distinct from OpenClaw's dedicated daily-memory flush. 
---

# 15. Tool-Result Management

Tool output is one of the largest context-growth sources in coding agents.

## Codex

Codex treats ordinary truncation separately from semantic compaction.

Old tool transcripts may disappear from local compacted history, while independent tool/model output limits control individual oversized responses.

## Hermes

Hermes performs significant tool cleanup before LLM summarization:

- exact duplicate older results can be deduplicated;
- large old results become informative one-line stubs;
- large tool arguments are shrunk while preserving valid JSON;
- stale screenshots/images are retired;
- protected-tail tool output may still be demoted under heavy pressure.

## OpenClaw

OpenClaw has an explicit ephemeral pruning system.

Its pruning can:

- wait for cache TTL;
- ignore low context usage;
- protect bootstrap history;
- protect the last three assistant turns;
- soft-trim large results;
- replace images with markers;
- hard-clear older eligible results under high pressure.

Importantly, persisted raw history remains the audit source.

---

# 16. Overflow Recovery

## 16.1 Codex ordinary sampling

This is one of the clearest differences.

When an ordinary Codex model request produces:

```text
ContextWindowExceeded
```

the current flow:

1. marks session token state as full;
2. records/emits the error;
3. returns the error.

It does **not** normally invoke a generic immediate:

```text
compact
→ retry same failed request
```

loop.

The marked-full state causes the next admission check to require compaction before another call.

### Compactor overflow

If the local **compaction request itself** overflows, Codex handles it differently:

```text
while more than one input remains:
    drop oldest input
    retry compaction
```

This prioritizes recent information and can continue progressively.

So Codex distinguishes:

```text
ordinary sampling overflow
vs.
compactor's own overflow
```

rather than treating all context exceptions identically.

---

## 16.2 Hermes overflow recovery

Hermes reacts immediately to provider-reported input overflow.

It:

- distinguishes input overflow from excessive output-token configuration;
- uses provider-reported context limits when available;
- estimates the entire request;
- compacts;
- retries;
- checks actual reduction.

Default retry rounds are **three**, configurable up to **ten**.

It terminates with `compression_exhausted` if it cannot make progress rather than looping indefinitely.

---

## 16.3 OpenClaw overflow recovery

OpenClaw similarly uses a bounded same-request recovery loop:

1. detect provider-specific overflow;
2. force compaction;
3. optionally truncate large tool results;
4. arm the post-compaction loop guard;
5. retry.

It stops after three compaction attempts.

If those fail, it can try one final tool-result truncation fallback and then return visible recovery guidance.

This is a stronger immediate liveness strategy than the current Codex ordinary-sampling path.

---

# 17. Failure Atomicity and Retry Behavior

## Codex

Codex's local path does not install a successful checkpoint if the local summarization request fails.

Remote v2 also rejects malformed output, including zero or multiple compaction items.

However, Codex's semantic success condition is lighter than OpenClaw's:

```text
successful generated checkpoint
does not imply
semantic continuity audit passed
```

The Codex memo characterizes its failure-atomicity focus as primarily ensuring that an unsuccessful compaction is not installed rather than proving a successful summary is semantically complete.

---

## Hermes

Hermes has detailed failure classification and fallback behavior.

If an auxiliary summary model fails, it can attempt the main model.

Persistent cooldowns include different values for:

- missing auxiliary provider;
- repeated timeout;
- malformed/premature stream;
- other transient failures.

By default:

```yaml
abort_on_summary_failure: false
```

Many failures therefore produce a deterministic local handoff capped around 8,000 characters and remove the compressible middle.

Authentication, permission/quota and final network failures always abort and preserve the transcript.

An operator can configure fail-closed behavior instead.

Hermes therefore chooses configurability between:

```text
liveness with deterministic loss
```

and:

```text
preservation with failed compaction
```

---

## OpenClaw

OpenClaw is the most conservative about semantic quality.

If all summary paths fail, it raises a compaction error rather than recording a false success.

Safeguard validation is a separate additional stage.

This is a strong transactional interpretation:

```text
old history
    ↓
attempt summary
    ↓
validate
    ↓
only then commit boundary
```

---

# 18. Anti-Thrash and Post-Compaction Loops

## Hermes anti-thrash

Hermes does not consider compression effective merely because fewer messages remain.

Its authoritative question is approximately:

> Did the next provider-reported prompt fall below the threshold?

Two ineffective strikes, or two consecutive deterministic-fallback boundaries, can trip a durable breaker. After a period of continuous blocking, a probationary automatic attempt may be permitted. Structural no-op cases use temporary backoff rather than poisoning the durable failure count.

This is an unusually strong anti-thrash design.

---

## OpenClaw post-compaction loop guard

OpenClaw addresses a different failure mode: the agent repeatedly doing the same tool action after losing conversational context.

Its guard:

- snapshots the previous 16 tool calls;
- watches the first three post-compaction tool attempts by default;
- hashes tool name, arguments and result;
- throws if an identical triplet repeats three times.

This is a concrete safeguard against compaction-induced behavioral loops.

---

## Codex

The inspected Codex compaction path has no equivalent repeated-tool-triplet guard.

Its mid-turn logic instead assumes that a successful compaction will reduce pressure sufficiently to avoid repeated rollover at the same boundary.

This is a notable place where borrowing OpenClaw's approach could improve robustness.

---

# 19. Hermes Micro-Compaction

Hermes includes an experimental alternative to large periodic rewrites.

Micro-compaction is disabled by default.

When enabled, it can periodically:

- find the oldest completed assistant/tool exchange outside protected regions;
- leave all user messages verbatim;
- merge that exchange into a cumulative rolling summary;
- archive the old exchange;
- publish the updated active representation.

Each micro-summary has a hard maximum of roughly 1,500 output tokens. When the rolling summary reaches around 2,000 estimated tokens, Hermes can defragment the summary rather than add another exchange.

The reason this is not the default is important:

> each rewrite invalidates the provider's cached prompt prefix.

This shows that optimal context management cannot be evaluated only by token occupancy. **Cache invalidation cost is part of the system economics.**

---

# 20. Hermes Lean-Tail Mode and Retrieval

Hermes's optional lean mode is the clearest attempt in these materials to make the summary an **index into external history** rather than the only surviving representation.

The lean tail is approximately:

```text
clamp(
    context window × 2.5%,
    10K,
    25K tokens
)
```

It compensates for the smaller live tail using:

- retrieval stubs;
- six newest tool-result rounds;
- exact IDs such as PRs, SHAs, paths, URLs, errors and handles;
- verbatim recent user messages under a 24K-character budget;
- deterministic `session_search(...)` recovery guidance;
- chunk digests of archived material.

This produces a hierarchy:

```text
small live context
    ↓
structured summary/index
    ↓
retrieval pointers
    ↓
searchable archived transcript
```

This is closer to virtual memory or hierarchical storage than traditional chat summarization.

---

# 21. Prompt-Cache Economics

Hermes treats prompt caching as a first-class design concern.

Its policy implies:

- ordinary batch compaction should cause one episodic prefix break;
- proactive pruning should reclaim enough tokens to justify another cache miss;
- micro-compaction stays opt-in because rewriting every turn would repeatedly destroy the prefix;
- session rotation can preserve a logical compression-lineage cache scope;
- after compaction, subsequent calls can reuse the newly compacted prefix.

This leads to a useful general cost model:

```text
total context cost
=
model input tokens
+ summarizer tokens
+ lost prompt-cache reuse
+ retrieval calls
+ failure/retry cost
```

A context algorithm that minimizes input tokens but destroys a high-value cached prefix every turn may be economically worse.

---

# 22. Model Switching and Compatibility

Codex specifically treats model migration as another compaction trigger.

Compaction may occur when:

- model compatibility metadata changes;
- moving to a model with a smaller context;
- current context cannot fit the destination model.

Its model metadata contains an opaque compaction compatibility identifier, `comp_hash`.

This is a significant architectural idea:

> A checkpoint must not only fit in token count; it must be valid for the model/configuration that will consume it.

Compaction therefore behaves partly like a **state-schema or cache-compatibility boundary**.

---

# 23. Comparative Strengths

## Codex strengths

Codex is strongest in:

- explicit logical context-window transitions;
- provider-aware compaction ownership;
- typed replacement history;
- explicit window lineage;
- canonical runtime-state reconstruction;
- model-switch compatibility;
- remote v2 metadata preservation;
- clean separation between ordinary overflow and compactor overflow.

Its recent development is strongly concentrated on typed metadata, retained media, provider compatibility and replay correctness.

### Main weakness

Its local summary path does not provide the same explicit semantic audit as OpenClaw, and ordinary provider overflow can surface to the user instead of being repaired in the same failed turn.

---

## Hermes strengths

Hermes is strongest in:

- durable searchable archival;
- aggressive recovery possibilities;
- real-vs-estimated token tracking;
- provider-specific thresholds;
- explicit cache economics;
- durable anti-thrash controls;
- structured summaries with important semantic anchors;
- retrieval-backed lean mode;
- subagent-result budgeting;
- progress-aware timeout and commit fencing.

The memo's historical trend shows movement from simple message-count compaction toward token-aware boundaries, searchable archives, durable breaker state, multiple trigger lanes, native checkpoints and retrieval-backed small live tails.

### Main weakness

Its flexibility produces complexity, and some stronger mechanisms remain opt-in. Legacy tail remains the default, deterministic lossy fallback remains default, and native/micro-compaction are not generally enabled.

---

## OpenClaw strengths

OpenClaw is strongest in:

- semantic quality auditing;
- pending-user-ask preservation;
- opaque identifier preservation;
- failure atomicity;
- same-request overflow repair;
- memory flush before context loss;
- clear separation between pruning and semantic compaction;
- post-compaction repeated-tool detection;
- provider-native support while preserving local transcript recovery.

Its recent history emphasizes provider-native replay, more accurate pressure accounting, failure visibility, user/file provenance preservation, re-compaction and loop prevention.

### Main weakness

Its local semantic contract can still be constrained by a fixed 16K-character summary cap, and post-compaction runtime instruction reinjection is not as canonical or automatic as Codex's reconstructed initial-context model. 
---

# 24. Historical Direction Across All Three Projects

Despite implementation differences, all three systems show a similar evolution.

## Stage 1 — Simple summarization

Early architecture resembles:

```text
conversation becomes large
        ↓
summarize old messages
        ↓
continue with summary + recent messages
```

## Stage 2 — Structural compaction

Boundaries become aware of:

- token counts;
- tool-call/result grouping;
- recent user intent;
- provider limits;
- output reserves.

## Stage 3 — Persistence

The system stops treating compressed-away history as permanently deleted.

Instead:

```text
model context = compact
durable transcript = retained
```

## Stage 4 — Multiple compaction owners

Compaction may be performed by:

- local harness;
- specialized summarizer model;
- provider;
- remote thread owner.

## Stage 5 — Checkpoint/retrieval architecture

Current direction is closer to:

```text
durable event/transcript history
          ↓
     checkpoint/index
          ↓
selected recent exact context
          ↓
reconstructed current state
          ↓
    model-facing window
```

Codex approaches this through evented replacement checkpoints and context-window lineage.

Hermes approaches it through searchable archival, small retrieval-aware tails and persistent state.

OpenClaw approaches it through a multi-owner architecture consisting of textual summaries, raw recent tails, ephemeral projections, opaque provider checkpoints, memory files and optional instruction reinjection.

---

# 25. Best Combined Architecture

A new coding-agent harness could combine the strongest properties of all three.

## 25.1 Keep durable history immutable or recoverable

Borrow from Hermes and OpenClaw:

```text
never make the compressed prompt
the only surviving copy of task history
```

Keep raw dialogue/tool events in durable storage.

The active model context should be a projection.

---

## 25.2 Give context windows explicit IDs

Borrow from Codex.

Every compaction should create:

```text
window_id
previous_window_id
compaction_reason
compaction_trigger
implementation_owner
model/config identity
```

This improves replay, debugging and telemetry.

---

## 25.3 Use one authoritative pressure calculator

It should account for:

- nominal model window;
- reserved output;
- system/developer state;
- conversation body;
- tool schemas;
- images;
- provider-reported usage;
- prefix/cache behavior when available.

Avoid having several unrelated components independently guess when context is “full.”

---

## 25.4 Separate pruning from compaction

Use mechanical reclamation first where it is clearly safe:

```text
deduplicate tool results
truncate stale oversized results
retire old media
remove disposable reasoning state
```

Do not describe this as semantic compaction.

---

## 25.5 Preserve raw recent user intent

All three systems support this principle in different ways.

A robust default should directly retain:

- newest unresolved user request;
- recent user corrections;
- important exact identifiers;
- a bounded recent interaction tail.

Do not force critical current intent to survive only through summarization.

---

## 25.6 Use a structured handoff schema

A good common schema could be:

```markdown
## Goal

## Pending User Requests

## Constraints and Rules

## Current State

## Completed Work

## Key Decisions

## Errors and Fixes

## Exact Identifiers

## Relevant Files and Artifacts

## Open TODOs

## Next Steps

## Recovery / Retrieval Pointers
```

This combines useful elements from Hermes and OpenClaw.

---

## 25.7 Audit local summaries before installation

Borrow OpenClaw's strongest feature.

At minimum validate:

- required headings;
- newest unresolved user request;
- exact identifiers;
- file paths/commands important to current work;
- safety or authorization constraints.

If validation fails:

```text
regenerate once
    ↓
still invalid?
    ↓
do not commit the boundary
```

This creates strong failure atomicity.

---

## 25.8 Reconstruct volatile runtime state outside the summary

Borrow from Codex.

Do not ask a prose summary to permanently preserve:

- current sandbox permissions;
- latest workspace instructions;
- tool availability;
- current model configuration;
- environment state;
- live collaboration configuration.

Rebuild these from authoritative runtime state after compaction.

---

## 25.9 Make retrieval explicit

Borrow from Hermes.

The compaction summary should contain recovery pointers such as:

```text
search session archive for <identifier>
reload file <path>
reload skill <name>
retrieve tool result <id>
```

The summary should be an **index**, not an attempted miniature copy of everything that happened.

---

## 25.10 Add provider-owned compaction as a separate interface

Do not pretend local summaries and opaque server checkpoints are the same mechanism.

Represent the owner explicitly:

```text
CompactionOwner =
    LocalSemantic
    ProviderNative
    RemoteThreadOwner
    StateReset
```

Each path has different auditability and replay requirements.

---

## 25.11 Add bounded overflow recovery

Borrow from Hermes/OpenClaw.

For ordinary provider overflow:

```text
overflow
  ↓
cheap pruning if useful
  ↓
compact
  ↓
retry
```

Use a hard limit such as three recovery rounds.

Do not silently loop.

---

## 25.12 Treat compactor overflow separately

Borrow from Codex.

If the **summarizer request** itself cannot fit:

```text
progressively discard oldest summarizer input
while preserving latest critical context
```

This is a different error from ordinary sampling overflow and deserves separate handling.

---

## 25.13 Add anti-thrash

Borrow from Hermes.

A compaction should be considered successful only if real subsequent provider usage falls sufficiently below the trigger.

Possible rule:

```text
if two consecutive automatic compactions
fail to create meaningful headroom:
    trip breaker
    stop auto-compacting temporarily
```

---

## 25.14 Add a post-compaction behavior guard

Borrow from OpenClaw.

Watch the first few tool calls after compaction.

If the agent repeats the same:

```text
tool
+ arguments
+ result
```

multiple times, terminate or escalate instead of allowing a loop.

---

## 25.15 Account for prompt-cache cost

Borrow from Hermes.

Do not rewrite context continuously merely because micro-compression can save tokens.

Evaluate:

```text
tokens saved
vs.
cache prefix invalidated
vs.
extra summarizer calls
vs.
retrieval overhead
```

Batching compaction often provides better economics.

---

# 26. Recommended Reference Pipeline

A combined implementation could use the following lifecycle:

```text
                  ┌─────────────────────────┐
                  │ Durable raw transcript  │
                  │ + runtime state store   │
                  └────────────┬────────────┘
                               │
                               ▼
                  ┌─────────────────────────┐
                  │ Context pressure model  │
                  └────────────┬────────────┘
                               │
                 pressure low │ pressure high
                       ┌───────┴───────────┐
                       │                   │
                       ▼                   ▼
                 normal request     mechanical prune
                                           │
                                           ▼
                                   pressure resolved?
                                      │        │
                                     yes       no
                                      │        │
                                      ▼        ▼
                                   request   compact
                                               │
                           ┌───────────────────┴──────────────────┐
                           │                                      │
                           ▼                                      ▼
                     local semantic                       provider-native
                           │                                      │
                  structured summary                      opaque checkpoint
                           │                                      │
                  semantic validation                     structural validation
                           │                                      │
                           └──────────────────┬───────────────────┘
                                              │
                                              ▼
                                   retain bounded raw tail
                                              │
                                              ▼
                               reconstruct current runtime state
                                              │
                                              ▼
                                     assign new window ID
                                              │
                                              ▼
                                  persist replacement checkpoint
                                              │
                                              ▼
                                     recompute real pressure
                                              │
                                              ▼
                                 post-compaction loop guard
                                              │
                                              ▼
                                           continue
```

---

# 27. Overall Assessment

The strongest lesson from the three projects is that **compaction should not be implemented as a standalone summarization helper**.

It is a state transition across several distinct data planes:

```text
1. durable raw history
2. active model-visible history
3. structured semantic checkpoint
4. provider-native hidden state
5. current runtime/environment state
6. retrieval/archive state
7. context-window lineage
```

Treating those as one message array creates fragile behavior.

### Codex demonstrates the strongest checkpoint model

The key Codex idea is:

> the context window is a replaceable execution projection over a more durable rollout and runtime state.

Its explicit replacement-history checkpoints, provider-native route, runtime reconstruction and window lineage are particularly strong.

### Hermes demonstrates the strongest recovery hierarchy

Hermes goes furthest toward:

```text
small active working set
+
searchable durable backing store
```

Its lean mode, archival behavior, retrieval instructions, anti-thrash state and cache economics make it resemble virtual-memory management more than simple chat summarization.

### OpenClaw demonstrates the strongest semantic safety layer

OpenClaw provides the clearest answer to:

> How do we know the summary did not quietly lose the actual task?

Its explicit quality audit, preservation of pending user asks and identifiers, non-destructive audit failure, overflow recovery and post-compaction loop guard are valuable safeguards for any long-running agent.

---

# 28. Final Conclusion

The three projects are converging toward a common architectural principle:

> **The full conversation should be treated as durable state, while the prompt sent to the model should be treated as a temporary, reconstructable working set.**

Their strongest individual contributions are complementary:

```text
Codex
  → context-window identity
  → replacement checkpoints
  → canonical runtime reconstruction
  → model/provider compatibility
  → provider-owned opaque compaction

Hermes
  → non-destructive archive
  → retrieval-backed continuity
  → adaptive pressure accounting
  → anti-thrash
  → cache economics
  → lean working-set design

OpenClaw
  → semantic summary audit
  → exact pending-ask/identifier preservation
  → failure-atomic commit
  → durable-memory flush
  → bounded overflow recovery
  → post-compaction loop detection
```

A robust next-generation agent should therefore not choose between **summary**, **checkpoint**, and **retrieval**.

It should combine them:

```text
durable transcript
    +
explicit context-window checkpoint
    +
audited semantic handoff
    +
bounded raw recent context
    +
authoritative runtime-state reconstruction
    +
retrieval into archived history
    +
provider-native compaction where appropriate
    +
strict liveness controls
```

That architecture turns compaction from a lossy emergency operation into a controlled **context-window lifecycle and recovery protocol**.