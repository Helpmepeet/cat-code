# deep_think as a tool vs native thinking — empirical test and cat-code evaluation

Date: 2026-08-12
Status: investigation complete (empirical); recommendation for cat-code below.

## The claim under test

> "guys you do know you can just disable thinking, and instead give it a `deep_think` tool,
> and it will call it with internal CoT reasoning format right?"

Three separable sub-claims:

1. **Mechanism** — with native thinking off, a model given a `deep_think` tool will call it.
2. **Format** — what it writes into the tool argument looks like internal chain-of-thought,
   not user-facing prose.
3. **Function** — doing so recovers the reasoning capability that disabling thinking removed.

All three are **true** on `claude-opus-5` under the conditions tested. Sub-claim 1 holds even
without instructing the model to use the tool. The interesting part is what the result does
*not* imply, and what it costs — see Limits and the cat-code evaluation.

## Method

Harness: `claude` CLI 2.1.228, model `claude-opus-5`, first-party provider, `--effort low`.

- **Thinking suppressed** with `MAX_THINKING_TOKENS=0`, verified per run by reading
  `usage.output_tokens_details.thinking_tokens` from `--output-format json`.
- **Tool isolation** with `--tools ""` (disables the entire built-in set) plus
  `--strict-mcp-config`, so the only callable tool is the one under test. This matters —
  see Threat to validity below.
- **`deep_think`** is a minimal stdio MCP server (JSON-RPC 2.0, no SDK) exposing exactly one
  tool taking a single `reasoning` string, returning a fixed acknowledgement
  (`"Noted. Proceed to your final answer."`). It performs no computation. It is a pure sink.
- **Task**: 6 arithmetic chains, 11 sequential operations each (add / subtract / multiply),
  ground truth computed in Python. Chosen because it is trivially verifiable and genuinely
  requires token-space working memory — the model cannot do it reliably in one shot.
- **Output constraint**: the visible reply was restricted to six bare numbers, no working.
  This is what forces the reasoning out of the answer and into either thinking or the tool.
- Two independent problem sets (different seeds) to guard against instance effects.

## Results

| Run | Set | Thinking | Tool available | Tool called | Score |
|---|---|---|---|---|---|
| A | 1 | **on** (adaptive, 426 tok) | none | — | **6/6** |
| A2r | 1 | off (0 tok) | none | — | **0/6** |
| Br | 1 | off (0 tok) | `deep_think`, instructed to use | yes | **6/6** |
| C | 1 | off (0 tok) | `deep_think`, *not* mentioned in prompt | yes, spontaneously | **6/6** |
| A2r' | 2 | off (0 tok) | none | — | **0/6** |
| C' | 2 | off (0 tok) | `deep_think`, *not* mentioned in prompt | yes, spontaneously | **6/6** |

The contrast is total: with thinking off and no scratchpad, the model scored **0/6 on both
problem sets** (every answer wrong, 44 output tokens, single turn — it simply guessed a
plausible magnitude). Restoring a place to write, with thinking still at zero, returned it to
**6/6**, matching the native-thinking baseline exactly.

Sub-claim 1 is stronger than stated: in runs C and C', the prompt never mentioned the tool.
The tool *description alone* was sufficient for the model to reach for it.

### What it writes into the tool (sub-claim 2)

Verbatim `reasoning` argument from run C':

```
P1: 12+52=64; *8=512; *6=3072; +18=3090; -36=3054; *9=27486; *7=192402;
    +35=192437; *5=962185; +50=962235; -32=962203.
P2: 25*4=100; -89=11; *3=33; -92=-59; +56=-3; *9=-27; -89=-116; +94=-22; ...
```

And from a separate constraint-satisfaction probe:

```
Bob not fewest → Bob ≠3. Alice > Bob. If Bob=12, Alice can't exceed. So Bob=7.
But 7 is not Carol — consistent. Alice>7 → Alice=12, Carol=3. Check clue 2: Carol=3, fine.
```

This is chain-of-thought register, not exposition: telegraphic, arrow notation, running state,
self-checks, no audience. It is what native thinking looks like. Sub-claim 2 holds.

### Why it works

There is no mystery. Native thinking and a `deep_think` tool call are the same mechanism —
both put intermediate tokens into the context window before the answer is generated. The tool
result round-trips the model's own reasoning back into the next request as ordinary context.
A model that has written `*9=27486` can read it; a model that wrote nothing must recompute
eleven operations in a single forward pass, and does not.

The tool being a no-op sink is the load-bearing detail. It adds no capability. All the gain
comes from the model having somewhere to put tokens.

## Does tool-reasoning degrade quality? (follow-up experiment)

The arithmetic task above is a **binary** instrument: it detects whether a scratchpad exists, not
whether the reasoning done in it is any good. It would score 6/6 even if tool-scratchpad
reasoning were substantially worse than native thinking. The real question — *is reasoning in a
tool argument the same as reasoning in a thinking block, or does the different channel hurt?* —
needs a graded instrument.

**Instrument.** Logic puzzles, 5 houses × 3 categories (owner / pet / door), generated with
**verified-unique solutions** and **trimmed to minimal clue sets** (every clue load-bearing, 9
clues each) so difficulty comes from deduction depth rather than clue count. Scored on 150
individual cells, not pass/fail, so partial degradation is visible as a gradient. Prompt is
**identical across all conditions** — only thinking and tool availability vary. All runs at
`--effort high` (the highest effort legal with thinking disabled).

| Run | Thinking | Tool | Exact | Cells | Reasoning tokens | Format |
|---|---|---|---|---|---|---|
| A1 | **on** | none | **10/10** | 150/150 (100%) | 5,236 (thinking) | clean |
| A2 | **on** | none | **10/10** | 150/150 (100%) | 5,565 (thinking) | clean |
| B1 | off | `deep_think` | **10/10** | 150/150 (100%) | 5,837 (scratchpad) | **VIOLATION** |
| B2 | off | `deep_think` | **10/10** | 150/150 (100%) | 5,548 (scratchpad) | **VIOLATION** |
| C1 | off | none | 0/10 | 42/150 (28%) | — | clean |
| C2 | off | none | 1/10 | 89/150 (59%) | — | clean |

Both arms replicated cleanly on accuracy: native thinking 10/10 twice, tool-scratchpad 10/10
twice, floor 0–1/10 twice.

**Reasoning-token accounting.** Provider accounting, not a character estimate. Native thinking
is `usage.output_tokens_details.thinking_tokens`. The scratchpad figure is total
`usage.output_tokens` minus the final answer iteration (641 tokens in every run, since the
answer format is identical across conditions): B1 = 6,478 − 641 = 5,837; B2 = 6,189 − 641 =
5,548. **The two channels spend the same reasoning budget** — the tool arm was slightly higher
in one run and slightly lower in the other.

> An earlier revision of this report claimed the tool used "roughly half the reasoning tokens."
> That was wrong. It came from dividing scratchpad characters by four while exact provider token
> counts sat in the same JSON. The scratchpad tokenises at ~1.7 chars/token, not 4, because it is
> dense with digits, names and punctuation. Any inference built on tool-reasoning being more
> *compressed* is retracted — there is no compression to explain.

**Format compliance is where the two arms actually differ.** Both `deep_think` runs emitted a
visible preamble — `"I'll work through these carefully."` — before calling the tool, breaking the
answer-only contract the prompt imposed. Native thinking broke it zero times out of two. This was
invisible to the first version of the grader, which scored only the final result message and
never inspected earlier assistant text; it is now checked explicitly. **Accuracy 10/10, format
compliance 0/2.**

**Does the tool interfere when thinking is left on? — single observation, n=1.** In one run
(E1) with thinking enabled *and* `deep_think` available, the model did not call the tool
(`tools: none`), thought natively at its usual depth (5,634 tokens, in line with A1/A2's 5,236 /
5,565), and scored 10/10.

This is one run, on one task family, with no instruction to use the tool. It is **not** evidence
that the tool is inert in general, and the earlier phrasing ("inert whenever thinking is on",
"only ever activates as a substitute") overclaimed from it. Establishing that would need
replication, a second task family, and a thinking-on arm that explicitly instructs tool use.
What it does justify is a weaker, useful prior: **the apparent "add the tool but keep thinking"
middle path should not be assumed to work — on this evidence the tool may simply go unused, and
the question is open.**

Earlier tier (4 houses × 3 categories, 12 minimal puzzles): thinking on **12/12** (3,536
thinking tokens); thinking off + `deep_think` **12/12**; thinking off, no tool **4/12** (54%
cells).

**Answer on accuracy: no degradation detected, at any difficulty in this section.**
Tool-scratchpad reasoning matched native thinking exactly — 100% vs 100%, two difficulty tiers,
replicated — against a floor of 28–59% where the same model has nowhere to write, and it did so
on the *same* reasoning-token budget. Inspecting the scratchpad shows genuine deliberate
reasoning: case analysis, constraint re-checking, explicit uniqueness proofs ("Check alternative
Ana4,Cy5,Eli3: ... impossible. So unique."), not a shallow dump.

**The caveat that limits all of it: both arms are at ceiling.** No task here separates them, so
this rules out *gross* accuracy degradation and nothing finer. A test where both conditions
score 100% has no resolving power — it can fail to detect degradation, which is not the same as
showing there is none. These puzzles were also **self-authored from a single task family**,
which bounds difficulty by the author's imagination and generalises to nothing else. Resolving
the question needs an externally-sourced instrument at a difficulty where native thinking itself
starts to fail; see the pending work note below.

**Where the arms do separate is format, not accuracy** — 0/2 vs 2/2 (above). For an agent
harness that is the more consequential axis: a wrong answer is visible, an unbidden preamble
silently breaks a downstream contract.

### Pending: an instrument with headroom (in progress at time of writing)

Because the puzzle tiers saturate, a third tier was built from **externally sourced problems**
rather than self-authored ones: 15 items from **AIME 2026 I/II and HMMT February 2026** — all
competitions held in February 2026, deliberately **after the model's training cutoff**, so
memorisation cannot substitute for reasoning. Ground truth is the published answer keys; six of
the fifteen answers were additionally re-derived by brute force in Python and matched. The set is
committed at `docs/reports/2026-08-12-deep-think-artifacts/bench.json`.

The floor is established: **thinking off, no tool = 0/15** — wrong by magnitude (155 vs 669, 800
vs 896), not by corrupted recall.

**That floor is also the contamination control.** These problems postdate the stated training
cutoff, but `claude-opus-5`'s actual cutoff is not something this investigation can verify. The
0/15 floor makes memorisation unlikely regardless: the same model, on the same problems, with no
scratchpad, recalls none of them. Whatever the other arms are doing, they are computing.

### Result: parity where both arms complete

**The first design was invalid and was discarded.** It gave the tool arm an unbounded agent loop
(12 turns, 11 `deep_think` calls, 100,137 output tokens) and gave native thinking **one** turn for
all 15 problems. That compares turn budgets, not reasoning channels. The native arm then stalled
— 40 minutes wall-clock, 5.3 s CPU, blocked on I/O, no output — and was killed. Re-run as **three
batches of five, identical for both arms**, 20-minute timeout each:

| Batch | Native thinking | `deep_think` |
|---|---|---|
| 1 | **5/5** — 16,002 thinking tokens | **5/5** — 15,512 chars, 1 call |
| 2 | **5/5** — 22,079 thinking tokens | **5/5** — 42,632 chars, 1 call |
| 3 (hardest) | **0/5** — `stop_reason: max_tokens`, 64,000 thinking tokens, **empty output** | **0/5** — `stop_reason: max_tokens`, 3 calls, timed out |

**Accuracy: no degradation.** On batches 1 and 2 the two channels are exactly equal — 10/10
apiece on real AIME 2026 / HMMT February 2026 problems, against a 0/15 floor. This is the first
non-saturated evidence in the investigation, and it is the answer to the question the puzzle
tiers could not resolve: reasoning written into a tool argument is not worse than reasoning
written into a thinking block.

**Batch 3 is uninformative and should not be cited either way.** Both arms hit the model's
`max_tokens` ceiling *and* the harness's 20-minute timeout, so "could not solve it" and "was not
allowed to finish" are entangled. Native thinking's failure is the starker one — it spent the
entire 64,000-token output budget on thinking and returned an empty string — but the tool arm
failed on the same five problems under the same conditions.

> A claim that reasoning-as-tool-calls "escapes the single-turn ceiling" was drafted from the
> native arm's batch-3 failure before the tool arm's result was in. The tool arm then failed the
> same way. The mechanism is real — each turn does get a fresh output budget, and the unbatched
> run did solve all 15 by chaining 11 calls — but it is **not** demonstrated by these data, and
> the unbatched run is not a controlled comparison. Recorded here because the inference was
> plausible, tempting, and wrong.

**Format compliance: 3/3 violations for the tool arm, 0/3 for native thinking.** Every
`deep_think` run emitted a visible preamble ("I'll work through these problems.") before calling
the tool. Across every tier in this report the tally is now **5/5 tool runs violating, 0/5 native
runs violating.** This is the only difference between the channels that has reproduced
consistently at every difficulty.

### The failure mode that showed up instead

Running the floor condition on an over-determined puzzle set produced something more interesting
than a score. With thinking disabled and a format rule forbidding visible working, the model
**emitted `<thinking>` tags into the user-visible answer and reasoned there anyway** — the
documented thinking-disabled leak, reproduced. On the minimal-clue set it instead self-corrected
mid-answer in the visible channel ("Wait — I need to correct:") and then repeated the same wrong
line, having detected the error with nowhere to fix it.

**You cannot actually take the scratchpad away.** Disabling thinking does not remove reasoning;
it relocates it — into a tool if you provide one, and into the user-visible output if you do
not. For a harness with a format contract, that second outcome is a correctness bug, not a
stylistic one.

### A note on observability

Native `thinking` blocks came back with **`thinking` string length 0** — `display` defaults to
`"omitted"` and the raw chain of thought is never returned on `claude-opus-5`. The tool argument,
by contrast, is fully readable, which is how the reasoning-quality inspection above was possible
at all. This is the empirical version of the plaintext-vs-opaque argument in the cat-code
evaluation below: the two channels differ far more in *auditability* than in *quality*.

## Limits — what this does not show

**Threat to validity, caught mid-experiment.** The first run of condition B scored 6/6, but
inspection of the transcript showed the model never called `deep_think` — it called `Bash` and
ran `python3 -c "print(((((12+52)*8)*6)...))"`. `--allowedTools` did not restrict the default
toolset. That run was discarded and re-run with `--tools ""`. Two consequences:

- Every number in the table above comes from a run whose transcript was inspected for which
  tool actually fired. Scores alone would have been misleading.
- **The finding itself matters more than the correction**: when a genuinely better tool was
  available, the model bypassed the scratchpad entirely and offloaded to a calculator. In a
  real agent harness — which has Bash, Read, Grep — `deep_think` competes with tools that do
  real work.

**Follow-up probe (D): tool selection with a realistic toolset.** Thinking off, tools =
`Bash, Glob, Grep, Read, deep_think`, task = a five-house constraint puzzle where Bash is not
an obvious shortcut. The model called **`deep_think` and nothing else**, and returned a
constraint-consistent assignment. (The puzzle as written turned out to admit three valid
solutions — a flaw in my construction — so this probe measures *tool choice*, not accuracy.)

Taken together: `deep_think` loses to Bash when Bash is genuinely the better instrument
(arithmetic), and wins when the work is actually reasoning. That is the correct behaviour, and
it means the tool does not crowd out real tools — but it also means it fires unpredictably
from the harness author's point of view, because the model is making a judgement call every
time.

**The arithmetic tier was not tool-isolated, contrary to how it was first written.** Its
baseline run (`condA.json`) used `--allowedTools ""`, which does **not** restrict the built-in
set — its init record lists **31 available tools**. No tool fired, so the score stands, but two
things follow: the "no tools" label was wrong for that tier, and the 6,960 ms → 7,872 ms latency
comparison drawn from it is **confounded** and is withdrawn. Those two runs differ in tool-schema
size, prompt bytes, and cache state, none of which were controlled. The puzzle tiers used
`--tools ""` and are genuinely isolated (init records list 0 and 1 tool respectively).

**Non-Claude models were not tested, and the blocker is diagnosed, not assumed.** Codex CLI
0.147.0 spawns the MCP server and completes the `initialize` handshake (confirmed by
server-side logging), then exposes only the MCP *resource* plumbing to the model
(`list_mcp_resources`, `read_mcp_resource`) — never the tool itself. `thread_start` reports
`dynamic_tool_count=0`. This holds with `tool_search_always_defer_mcp_tools` disabled and with
`mcp_2026_07_28` + `non_prefixed_mcp_tool_names` enabled; its own feature table has `tool_search`
as `removed` while MCP tools are still deferred *to* tool search. Testing GPT needs a direct API
key or a local OpenAI-compatible endpoint (LM Studio is installed but holds only an embedding
model). **The claim that this technique generalises across providers is therefore an untested
hypothesis in this report.**

**Not tested**: multi-turn agent loops; long-horizon tasks; whether tool-scratchpad reasoning
degrades over many turns as it accumulates in context; models other than `claude-opus-5`; any
provider other than first-party Anthropic; the capacity boundary (batch 3, confounded by the
harness timeout). n=2 problem sets on the puzzle tiers, 1 run per cell elsewhere. No latency
claim in this report is controlled.

**Cross-provider**: not established. The Codex CLI (`gpt-5.6-sol`, reasoning effort low) was
tested but its build would not surface a third-party stdio MCP server's tools to the model
(MCP resource functions loaded; the tool name never appeared in the model's tool list, with or
without `tool_search_always_defer_mcp_tools` disabled). The GPT-side claim is untested here.

## Cost and latency — the part the claim omits

| | native thinking | deep_think tool |
|---|---|---|
| API round trips | 1 | 2 (one per scratchpad call, plus the answer) |
| Output tokens (run A vs C) | 467 | 524 |
| API wall time | 6,960 ms | 7,872 ms |

The reasoning tokens are billed as output either way. The tool adds:

- **an extra round trip per reasoning step**, and the entire prompt is re-sent on the
  follow-up request (prompt caching absorbs most of the token cost, not the latency);
- **the reasoning text becomes permanent conversation context** — it is a `tool_use` /
  `tool_result` pair, so it is re-sent as input on every subsequent turn for the rest of the
  session, and it is visible to anything that reads the transcript.

That last point is the substantive difference, and it cuts both ways: the reasoning is now
inspectable, replayable, and loggable — but it is also unsigned, un-encrypted, and
indistinguishable from any other tool traffic.

## Two premises of the claim that are shaky on current models

**"You can just disable thinking" is decreasingly true.** Verified first-hand against the live
API. `MAX_THINKING_TOKENS=0` + `--effort xhigh` returns:

```
API Error: 400 output_config.effort 'xhigh' is not supported when thinking is
disabled on this model. Use effort 'high' or below, or enable thinking.
```

Same at `max`; `high` and below succeed. Two things follow. First, this confirms
`MAX_THINKING_TOKENS=0` really does put `thinking: {type: "disabled"}` on the wire — the
server would not raise that error otherwise — so the "thinking off" condition in the results
table is genuinely disabled thinking, not merely omitted. Second, **the technique's premise is
being closed off at the API level, not opened up**: on `claude-opus-5` disabled thinking is
capped at effort `high`, and on Claude Fable 5 it is rejected outright at any effort (thinking
is always on; the parameter must be omitted entirely).

**Instrument warning — `thinking_tokens: 0` does not mean thinking is disabled.** Two runs
demonstrate the trap in opposite directions:

- `--effort low` with thinking *enabled* produced **426 thinking tokens** (run A). Low effort
  does not disable thinking.
- `--effort xhigh` with thinking *enabled* on a trivial prompt produced **0 thinking tokens** —
  adaptive thinking simply chose not to think. Identical usage signature to a disabled run.

Adaptive thinking decides per request. Anyone testing this claim must control thinking
explicitly and confirm it by provoking the 400 above, not by reading a zero off a usage field.

**Disabling thinking has documented failure modes** that a scratchpad tool does not fix. With
thinking disabled, `claude-opus-5` can emit a tool call as plain visible text instead of a
structured `tool_use` block — the turn completes, no error is raised, and the call silently
never runs. It can also leak `<thinking>` tags into user-visible output. For an agent harness,
a silently-dropped tool call is a serious failure mode, and it is caused by the very thing the
technique requires.

## Evaluation for cat-code

**Verdict: do not adopt it as a replacement for native thinking. The technique works, but every
condition that makes it work is one cat-code either does not meet or is actively moving away
from.** There is a real insight buried in it, and it is not the one the claim makes — see
"What is actually worth taking" below.

Repo state below was mapped by a subagent against current source; the load-bearing citations
were re-verified by hand.

### Why not

**1. cat-code does not disable thinking, and the code says not to change that.** On the main
agentic path the disabled state is expressed by *omitting* the field, never by sending
`thinking: {type:'disabled'}` (`src/services/api/claude.ts:1769-1772`, spread at `:1890`). The
selection logic carries an explicit warning: "Do not change the adaptive-vs-budget thinking
selection below without notifying the model launch DRI and research" (`claude.ts:1773-1775`).
The only place cat-code sends disabled is the side-query path for the auto-mode permission
classifier (`src/utils/sideQuery.ts:187-195`). Adopting the technique means editing a path
flagged as sensitive, for a mechanism the vendor is deprecating.

**2. The failure mode is exactly the one an agent harness cannot absorb.** With thinking
disabled, `claude-opus-5` can emit a tool call as visible text rather than a `tool_use` block —
no error, turn completes, call silently never runs. In a chat product that is a bad answer; in
cat-code it is a tool that did not fire while the transcript says the turn succeeded. Combined
with the API-level cap verified above (disabled thinking rejected at `xhigh`/`max`, rejected
outright on Fable 5), the technique is unavailable at exactly the effort levels cat-code uses
for real work.

**3. It inverts the context-eviction asymmetry, in the wrong direction.** Today thinking is the
*protected* class: `clear_thinking_20251015` is sent with `keep: 'all'`, only dropping to
`{thinking_turns: 1}` after a >1 h idle latch (`src/services/compact/apiMicrocompact.ts:89-90`),
and client microcompact clears `tool_result` blocks only, never `tool_use` inputs
(`src/services/compact/microCompact.ts:216-221`). Move reasoning into a tool argument and it
becomes a `tool_use` input, while the evictable half is the empty acknowledgement — so reasoning
would accumulate in context precisely because it is no longer thinking.

Qualification: this asymmetry is stated for the **external-user client path**. API-side
tool-input clearing does exist (`clear_tool_uses_20250919` with `clear_tool_inputs`), but it is
ant-only and env-gated in cat-code (`USE_API_CLEAR_TOOL_RESULTS` / `USE_API_CLEAR_TOOL_USES`,
`src/services/compact/apiMicrocompact.ts:95-140`), so it is not a mechanism an external user's
session can rely on. Full compaction destroys both classes regardless.

**4. Latency, on an interactive product.** One extra round trip per reasoning step, with the
prompt re-sent (caching absorbs tokens, not latency). **No controlled measurement of this is
offered here** — the only latency numbers collected came from the confounded arithmetic tier and
are withdrawn (see Limits). The extra round trip is a structural fact of the design; its cost on
a multi-step agent turn is unquantified.

### Where the idea is genuinely right — and it is not about thinking

The claim frames this as a way to *get reasoning*. For cat-code the interesting property is
different: it makes reasoning a **first-class, plaintext, client-owned transcript object**
instead of an opaque provider blob. Three current pain points are all downstream of that
representation, and the repo already has the receipts:

- **There is no cross-provider reasoning abstraction, and the shared field is a type pun.**
  Anthropic and Codex reasoning converge only on the thinking-block wire shape; `signature`
  means a cryptographic signature over thinking text on one path and opaque provider
  continuation state on the other (`src/services/api/codex-fetch-adapter.ts:2208-2263`,
  `:1206-1224`). Normalization is explicitly forked by provider
  (`src/utils/messages.ts:2385-2391`, `:2400-2408`). A tool call is provider-neutral by
  construction.
- **The opaque blob is a known security liability.**
  `docs/reports/2026-08-12-encrypted-reasoning-trace-security-evaluation.md` concludes that
  encrypted reasoning is sensitive active state that `app/shared/secretGuard.ts` cannot
  inspect, that `/feedback` ships without an opaque-state sanitizer, and that account failover
  replays one account's signatures under another. A tool argument is plaintext: greppable,
  redactable, secret-scannable. It does not make the exposure vanish — it moves it into a
  surface that transcript export and remote persistence treat as ordinary readable content —
  but it moves it somewhere the existing guards can actually see.
- **The desktop renders reasoning far worse than it renders tools.** In `app/`, thinking deltas
  project **no rows at all** — asserted by fixtures with `expectRows: 0`
  (`app/renderer/src/sdkMessageFixtures.ts:552-600`) and stated in
  `app/renderer/src/appModel.ts:99-103` ("thinking deltas project no row... close to
  unreachable today"). A thinking row is stateless and uncorrelated; a `ToolUseRow` is a
  stateful, correlated, collapsible card with live status. The terminal has a live streaming
  thinking view; the desktop does not.

  **But reasoning-as-a-tool would not inherit that renderer "for free" — an earlier revision of
  this report said so and was wrong.** A tool card shows `stringifyInput(row.input)` only while
  `!row.result` (`app/renderer/src/TranscriptView.tsx:1969`). Once the result arrives — for a
  `deep_think` sink, an instant acknowledgement — the body switches to rendering the *result*
  content (`TranscriptView.tsx:2027`), so the reasoning disappears from the card and survives
  only in the inspector. The `AckBody` path does not rescue it either: it surfaces only
  `input.prompt` / `input.message`, not an arbitrary `reasoning` field, and requires an exact
  two-key ack shape (`app/renderer/src/toolAck.ts:61`). Displaying completed reasoning in the
  desktop would take renderer work either way.

That third point stands on its own and does not require this technique. **The actionable item
is that the desktop has no live reasoning view, not that we should reshape the API to get one.**
Fixing `projectStreamEvent` to materialize thinking deltas is the direct fix, and it is a
smaller change than re-plumbing the thinking parameter.

There is also structural precedent for "model emits structured prose through a tool" —
`TodoWriteTool`, `BriefTool`, `AskUserQuestionTool`, `EnterPlanModeTool` (registered in
`src/tools.ts:219-283`) — so a `deep_think` tool would not be an alien shape. There is no prior art for it: no think,
scratchpad, or reasoning tool exists in `src/tools/`, nor at the upstream fork point. The
`ULTRATHINK` entry in `scripts/build.ts:47` is the keyword→effort feature, not a tool.

### If it were to be tried anyway

Scope it as an experiment, not a default:

- **Do not** touch the main agentic path or `claude.ts:1769-1803`.
- Viable niche: **subagents at low effort**, where cheap reasoning plus full plaintext
  visibility is worth losing tuned adaptive thinking, and where an extra round trip is hidden
  behind parallelism.
- Measure against native thinking on the same tasks — accuracy, tokens, wall time, and context
  growth over a long turn — rather than assuming parity from a single-step demo like this one.
- Note the tool-selection behaviour from probe D: with real tools present the model chooses
  between `deep_think` and doing actual work, per request. That is correct behaviour but it
  means reasoning coverage becomes nondeterministic in a way native thinking is not.

### One open question this raises

`CodexCoreUsage.reasoningTokens` is declared (`src/codex-core/types.ts:24`) but never populated
by any adapter, so Codex reasoning-token spend is currently unobservable in-app. Any comparison
of reasoning cost across providers is blocked on that. Worth fixing regardless of this proposal.

## Reproduction

All artifacts are committed under **`docs/reports/2026-08-12-deep-think-artifacts/`** — not in an
ephemeral scratchpad:

| Path | What |
|---|---|
| `deep_think_mcp.py` | The MCP server: ~80 lines of stdlib Python, `initialize` / `tools/list` / `tools/call`. A pure sink — returns a fixed acknowledgement, computes nothing. |
| `gen_hard.py` | Puzzle generator (numpy masks over the 1,728,000-state space; verified-unique + minimal-clue trimming). |
| `grade.py`, `grade_bench.py` | Graders. Both inspect **every** assistant text block for format violations, not just the final result. |
| `task_*.txt` | The exact prompts, verbatim. |
| `puzzles.json`, `puzzles5h.json`, `bench.json` | Problem sets with ground truth. |
| `runall.sh`, `runbench.sh`, `claude_mcp.json` | Exact commands and MCP wiring. |
| `raw/*.json` | Raw `--output-format json` output for all 17 saved runs. |
| `MANIFEST.json` | Per-run cost, tools-available count, thinking tokens, output tokens, turns. |

**Cost: $10.861 across the 24 saved named arms** (per `MANIFEST.json`). An earlier revision said
"six invocations, roughly $0.55" — that counted only the first tier and was stale by the time the
puzzle and benchmark tiers were added. Unsaved pilots and discarded probes are not included, so
true session spend is somewhat higher.

Three flags carry the whole experiment, and two of them were the difference between a valid and
an invalid run:

- `--tools ""` — disables the built-in toolset. **`--allowedTools` does not restrict it** (see
  the 31-tool arithmetic baseline above).
- `MAX_THINKING_TOKENS=0` — sends `thinking: {type:'disabled'}` (confirmed by the 400 above).
- `--output-format json` — required to read `thinking_tokens`, per-iteration `output_tokens`, the
  init record's tool list, and which tool actually fired. Every quantitative claim here should be
  taken from these fields, never estimated from character counts.
