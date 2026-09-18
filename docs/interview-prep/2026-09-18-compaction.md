# Cat Code Compaction

This document explains why Cat Code compacts conversations, how its original
full-compaction path worked, and why the current implementation normally uses
reactive prefix compaction instead.

## Interview answer in 30 seconds

> A coding agent eventually fills the model's context window. Cat Code used to
> summarize the whole active conversation and replace it with one summary. That
> recovered space, but it also erased the exact recent prompt, tool output, and
> work trajectory. I changed the normal path to prefix compaction: summarize an
> older prefix, preserve the newest complete API rounds verbatim, and continue
> the interrupted turn in the same session. The hard parts were choosing a
> split that preserves tool-call protocol invariants, keeping prompt-cache reuse,
> persisting the preserved suffix correctly, and handling failure without
> repeatedly spending quota.

## Why compaction exists

Every model request has a finite input budget. An agent's context contains more
than visible chat text:

- system and developer instructions;
- tool schemas;
- user and assistant messages;
- tool calls and tool results;
- images and attachments;
- generated plans, skill content, and hook context.

When this total approaches the usable context window, Cat Code must replace
some detail with a smaller representation. Compaction is lossy compression of
the model's active context; it is not deletion of the session itself.

## The inherited design: full compaction

The original path passed the active conversation to a one-turn summarizer. On
success, the next model context was rebuilt as:

```text
compact boundary
-> synthetic user message containing the summary
-> regenerated attachments
-> SessionStart hook messages
```

It returned no `messagesToKeep`, so no original user, assistant, tool-call, or
tool-result message remained verbatim in active model context. The append-only
transcript and session identity could still exist, but the model continued from
the generated summary.

This was reliable and simple, and it remains valuable as a fallback. Its main
weakness was continuity: even a very recent request, compiler error, or partial
investigation could immediately become summarized prose. A summary can preserve
meaning but not every exact detail or the agent's immediate momentum.

## The current design: reactive prefix compaction

Cat Code now normally separates the active context into two parts:

```text
older prefix                         recent suffix
summarize this                       keep this verbatim
        \                              /
         -> boundary -> summary -> suffix -> restored context
```

This is the normal algorithm for:

- threshold-triggered automatic compaction;
- manual `/compact`;
- recovery after the provider rejects an oversized prompt or image payload.

The old full-compaction implementation still exists. It is the structural
fallback when the conversation cannot be split safely, rather than the normal
choice.

### The preserved suffix is not a fixed size

The implementation starts by preserving one trailing API-round group. It can
preserve additional groups if the prefix-summary request is itself too large.
Therefore, “the latest one or two rounds” is a useful intuition, not a contract.

The real contract is: preserve one or more newest complete groups while leaving
a non-empty older prefix to summarize.

## Why Cat Code splits at API rounds

A visual chat turn is not necessarily one model round. One human request can
produce several model requests:

```text
user request
-> assistant tool call
-> tool result
-> assistant tool call
-> tool result
-> assistant answer
```

`groupMessagesByApiRound()` detects a new group when a genuinely new assistant
response ID begins. Streaming fragments with the same response ID remain in the
same group. Cat Code then applies an additional invariant-preserving adjustment
before accepting the pivot.

This matters because a bad array slice can create an invalid request:

- a tool call without its tool result;
- a tool result without its call;
- thinking content separated from the response it belongs to.

The high-level rule is: **compact semantic protocol units, not arbitrary message
indices.**

## What happens during prefix compaction

1. Ignore material before the latest existing compact boundary; it has already
   been summarized.
2. Group the remaining active messages into API rounds.
3. Check that at least two complete assistant rounds exist. One round cannot be
   divided into an older prefix and recent suffix safely.
4. Start with one trailing group preserved.
5. Summarize only the older prefix.
6. If that summary request is too large, move more complete groups into the
   preserved suffix and retry, for a bounded number of attempts.
7. Build the new context in this order:

```text
compact boundary
-> synthetic summary user message
-> preserved messages, unchanged
-> regenerated attachments
-> SessionStart hook messages
```

8. Persist boundary metadata that identifies the preserved UUID segment so a
   resumed session can rebuild the same logical chain.

The summarizer intentionally does not receive the recent suffix. Summarizing it
would duplicate information that the main model will receive verbatim.

## The summarizer is a constrained one-turn agent

The compaction prompt requires an `<analysis>` drafting block followed by a
`<summary>` containing nine sections: request and intent, technical concepts,
files and code, errors and fixes, problem solving, all user messages, pending
tasks, current work, and the next step.

`formatCompactSummary()` strips the `<analysis>` block before the result enters
the continuing model context. The private drafting text is useful while the
summary is generated, but only the formatted summary is retained.

The cache-sharing route inherits the parent's complete tool definitions because
the cache-compatible prefix includes the system instructions, tools, model,
messages, and thinking configuration. Cat Code does not let the compaction agent
execute those tools: `createCompactCanUseTool()` denies every call, the prompt
strongly requires text only, and the fork is limited to one turn.

If the cache-sharing fork errors or returns no summary text, Cat Code tries a
separate streaming summarization route. This is a **summary-generation
fallback**, not the same thing as falling back from prefix compaction to full
compaction.

Interview-safe wording:

> The tool schemas stay present to preserve cache compatibility, while the
> runtime permission callback forbids tool execution. Keeping a schema and
> allowing its execution are separate decisions.

Do not claim a fixed latency or a guaranteed cache-hit percentage. Those depend
on provider state and request history; the source only establishes that the
route is designed to reuse the parent's cached prefix and records the observed
cache metrics.

## Restoring non-conversation state

The summary is not expected to carry every piece of operational state. After
compaction, Cat Code reconstructs important context through typed attachments.

### Recently read files

The read-file tracker records paths and timestamps. Cat Code considers the five
most recently read eligible files, refreshes them through `FileReadTool`, limits
each to 5,000 estimated tokens, and also enforces a 50,000-token total budget.

With prefix compaction, it scans the preserved suffix first. If that suffix
already contains the full relevant read result, the file is not reattached.
A deduplication stub does not count as the full content, so that file can still
be restored.

### Other regenerated state

Depending on current state, Cat Code can also restore:

- an active plan and plan-mode instructions;
- invoked skill content, with per-skill and total budgets;
- running or completed-but-unretrieved async-agent status;
- deferred tool discovery, agent listings, and MCP instructions that were lost
  with the summarized prefix;
- SessionStart hook output for the compact event.

This illustrates an important design principle: durable operational state
should not rely only on a prose summary.

## Session and persistence semantics

Compaction stays inside the same logical session. It does not behave like
`/clear`:

- the session continues rather than starting a fresh session;
- the transcript remains the persistence source;
- running background work is not intentionally reset merely because context
  was compacted;
- the active model context is rebuilt around a compact boundary.

Preserving a suffix is more complicated than retaining it in an in-memory
array. Those messages already have persistent UUIDs and parent links. The
boundary stores explicit preserved-segment metadata; resume logic relinks that
segment and prevents its old usage counters from making the restored session
immediately compact again.

That persistence work is part of the feature, not an implementation detail to
omit in an interview. A prefix algorithm that works live but corrupts or
duplicates history after resume is incomplete.

## Failure behavior

There are two different kinds of fallback to keep separate.

### 1. Prefix compaction to full compaction

If Cat Code cannot form an older prefix plus a complete recent suffix—for
example, there is only one giant API round—it uses traditional full compaction.
`canPrefixCompact()` makes this decision before `PreCompact` hooks run, because
the full path runs those hooks itself and they must not fire twice.

Once a valid prefix attempt is running, an ordinary network, rate-limit, abort,
or summarizer error does not immediately trigger a second, larger full-history
summary request. It is surfaced or classified by the caller instead. Prompt-too-
long recovery has an additional same-turn path: if the remaining tail later
cannot be prefix-split, the query recovery can use full compaction.

### 2. Cache-sharing summary to streaming summary

If the one-turn cached-prefix summarizer fails or produces no text, Cat Code can
retry summary generation through the direct streaming route. This changes how
the summary is generated; it does not change which conversation portion the
caller selected.

### Circuit breaker

Automatic compaction stops retrying after three consecutive non-transient
failures. Abort, connection, timeout, rate-limit, overload, and similar
transient failures preserve the breaker budget. A successful compaction resets
the count.

## Context-window math

Cat Code separates four notions of model capacity:

```text
native
-> entitled by the current account
-> configured by operator limits
-> effective after output reservation
```

The output reservation is:

```text
min(model default maximum output for this request, 20,000)
```

It is therefore capped at 20,000, not always exactly 20,000.

For most models, the automatic compaction threshold is approximately:

```text
recovery reserve = clamp(8% of effective window, 10,000, 50,000)
auto buffer      = 3,000 + recovery reserve
auto threshold   = effective window - auto buffer
blocking limit   = effective window - 3,000
```

`gpt-5.6-sol` also has a 900,000-token auto-compaction ceiling. Environment
overrides, account entitlement, and model-specific output settings can move the
actual numbers, so explain the formula rather than memorizing one 200K example.

The gap between the automatic threshold and blocking limit provides recovery
room. Waiting until the hard edge would leave no space for a large tool result,
the summary prompt, or continuation output.

## Design trade-offs

Prefix compaction improves immediate continuity, but it is still lossy:

- exact older content survives only in the transcript, not active context;
- summary quality can omit a critical old detail;
- a large recent suffix may leave less room than expected;
- rebuilding attachments spends context tokens;
- cache reuse is an optimization, not a correctness guarantee;
- grouping, persistence relinking, and retry logic are more complex than full
  replacement.

The old path remains useful precisely because it has fewer structural
requirements. The design is not “new algorithm good, old algorithm bad”; it is
“use the continuity-preserving path normally, retain the simpler path for cases
that cannot be split.”

## Strong interview framing

Structure the story around the engineering decision:

1. **Problem:** full compaction recovered tokens but destroyed exact recent
   working context.
2. **Observation:** old history and immediate working state have different
   value; only the old prefix needs lossy compression.
3. **Implementation:** group by complete API rounds, summarize the prefix, keep
   the suffix, and persist explicit segment metadata.
4. **Reliability work:** protect tool/thinking invariants, preserve cache
   compatibility, deduplicate restored files, avoid duplicate hooks, and bound
   retries.
5. **Trade-off:** more state-machine and persistence complexity in return for
   much better continuation quality.

Likely follow-up questions:

- Why not use a larger context window forever?
- Why is an API round different from a user turn?
- What breaks if a tool call and result are separated?
- Why retain tool schemas when tools are denied?
- How does resume reconstruct a preserved suffix?
- Why not fall back to full compaction after every error?
- What metrics would show that the change is better?

A good metrics answer includes continuation success, repeated user instructions,
immediate post-compact errors, time to first useful continuation, compaction
latency, cache-read versus cache-creation tokens, post-compact context size, and
recompaction frequency.

## Source map

- `src/services/compact/reactiveCompact.ts`: prefix selection, widening retries,
  preserved messages, attachments, and durable boundary metadata.
- `src/services/compact/grouping.ts`: API-round grouping.
- `src/services/compact/compact.ts`: old full compaction, summarizer execution,
  post-compact message construction, and attachment restoration.
- `src/services/compact/prompt.ts`: provider-specific summary prompts and
  `<analysis>` removal.
- `src/services/compact/autoCompact.ts`: thresholds, normal automatic routing,
  failure classification, and circuit breaker.
- `src/commands/compact/compact.ts`: manual `/compact` routing.
- `src/utils/contextWindowPolicy.ts`: native, entitled, configured, and effective
  context-window calculation.
- `src/utils/sessionStorage.ts` and `src/utils/tokens.ts`: persistent relinking
  and correct token accounting for preserved messages.
- `docs/reports/2026-08-09-claude-code-compaction-evolution.md`: historical
  investigation. Its early statements describe Cat Code before prefix
  compaction became the normal path; read its later amendments and current
  source when discussing today's behavior.
