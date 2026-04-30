# Practical implementation differences between Claude 4.6 and GPT‑5.4 for coding agents

## Executive summary

Most of the “Claude-first vs GPT-first” differences from earlier generations still apply, but **the newest model families add a few migration-critical changes** that you should treat as *required implementation updates*, not prompt style. The biggest changes are **GPT‑5.4’s Responses‑API-first agent loop features** (tool search, compaction, `phase`) and **Claude 4.6’s shift to adaptive thinking + effort (with `budget_tokens` deprecated)**. citeturn11view6turn10view5turn12view0turn12view3turn12view1

Key “still true” differences (stable across 2024–2026 docs):

- **Instruction hierarchy is structurally different.** GPT uses explicit instruction roles (`system`, `developer`, `user`) and/or an `instructions` parameter with documented precedence; Claude Messages has **no `system` role** inside `messages[]`—you provide a top-level `system` parameter instead. This is not just style; it affects request assembly and caching. citeturn1search9turn1search2turn1search0  
- **Tool-loop wiring is different.** Claude client tools produce `tool_use` blocks and require a strict “tool_result adjacency + ordering” protocol; GPT function calling produces `function_call` output items and requires you to respond with `function_call_output` items keyed by `call_id`. If you migrate the Claude loop “as-is,” you will usually break tool continuity. citeturn12view6turn15view3  
- **Claude extended thinking is *stateful and must be preserved* across tool turns; GPT reasoning tokens are *not retained* in context by default (they are internal and discarded).** This changes what you should carry forward across turns and why “Claude-style `<thinking>` logs” should not be ported literally. citeturn6search15turn10view2  

Key “new in these newest models” changes (time-sensitive / version-gated):

- **GPT‑5.4 introduces `tool_search`, built-in computer use, and native compaction support**, and the platform added an explicit **assistant message `phase` field** to avoid “intermediate update treated as final answer” failure modes in long tool workflows. If your orchestration layer drops or ignores `phase`, you can see degraded behavior. citeturn11view6turn10view5turn3search5turn9search9turn17view6  
- **Claude 4.6 deprecates manual extended thinking budgets (`budget_tokens`) in favor of adaptive thinking + effort**, and adaptive thinking automatically enables interleaved thinking. If your Claude-first system relies on fixed think budgets, plan a rewrite anyway—then decide whether you want to keep that design for GPT. citeturn12view0turn12view3  
- **Structured output constraints differ sharply.** Claude structured outputs enforce grammar compilation limits such as caps on strict tools and optional parameters (with explicit 400 errors when too complex). GPT Structured Outputs support a documented subset of JSON Schema with explicit limits on nesting depth, total properties, enum sizes, and total string size. Your schema generator may need two backends. citeturn13view0turn14view3turn14view0  

Biggest implementation consequences when moving a Claude-optimized stack to GPT‑5.4:

- **Replace “tool_result block protocol” with “call_id keyed tool outputs”** and adopt GPT’s tool primitives where they are built-in (shell, computer use, tool search, server-side compaction). citeturn15view3turn22view5turn17view5turn11view2  
- **Stop treating visible thought as state.** For GPT‑5.4 you should mostly treat reasoning as internal; if you need debuggability, use reasoning summaries or encrypted reasoning items rather than storing or replaying a Claude-style `<thinking>` transcript. citeturn10view2turn16search25turn2search5  
- **Rework caching strategy.** Claude prompt caching is breakpoint/TTL-based and has explicit invalidation rules by prompt segment; OpenAI prompt caching is automatic prefix-hash-based, optionally guided by `prompt_cache_key` and request-level retention. Your “stable prefix vs dynamic tail” split will likely stay, but the knobs and failure modes change. citeturn25view0turn24view0turn11view3turn23view0  

## Side-by-side comparison table

| Area | Claude Sonnet/Opus 4.6 native pattern | GPT‑5.4 native pattern | Overlap | Migration risk | Recommendation |
|---|---|---|---|---|---|
| Instruction hierarchy | `system` is a top-level parameter; Messages API `messages[]` uses `user`/`assistant` roles (no `system` role in Messages). citeturn1search0turn6search16 | Inputs can include `system`/`developer`/`user` roles; `developer`/`system` override `user`. There is also an `instructions` parameter that overrides `input`. citeturn1search9turn1search2 | Both benefit from “stable prefix + dynamic tail.” citeturn11view3turn25view0 | Medium | Make GPT request assembly role-native (don’t simulate Claude’s top-level `system`). |
| XML wrappers | Often used as a *prompting technique* for Claude and is discussed in prompt best practices. citeturn12view4 | GPT can follow XML-like structure, but authority comes from roles + structured outputs, not tags. citeturn1search9turn3search0 | Tags help humans and parsing. | Low | Keep XML only where it improves parsing/tests; don’t use it as “control.” |
| Client tool loop | `tool_use` blocks → you run tool → reply with `tool_result` blocks. Requires adjacency and ordering. citeturn12view6turn12view5 | `function_call` output items → you run tool → send `function_call_output` with `call_id`. citeturn15view3turn11view0 | Both are multi-turn tool loops. | High | Rewrite the tool loop and message formatting; don’t “adapter-shim” at the text level. |
| Parallel tool calls | Supported; you can disable via `disable_parallel_tool_use`. Tool results must be returned in a single user message to avoid “teaching” Claude to be serial. citeturn12view5turn6search16 | Parallel function calling exists, but **not possible when using built-in tools**; can disable multi-function calls with `parallel_tool_calls:false`. citeturn15view0 | Both need your infra to execute multiple calls safely. | High | For GPT: separate “built-in tool turns” from “parallel function turns,” or accept seriality when built-ins are enabled. |
| Strict schema tool calling | `strict: true` exists (Claude strict tool use + JSON outputs); has complexity limits that can trigger 400 errors. citeturn13view0turn6search10 | `strict:true` for function calling; strict has schema requirements and uses Structured Outputs under the hood. Responses may normalize schemas into strict mode by default. citeturn15view0turn15view0 | Both can enforce schema adherence. | High | Maintain separate schema policies: Claude complexity budgeting vs GPT schema normalization rules. |
| Structured JSON outputs | `output_config.format` supports JSON schema; citations incompatible with strict JSON outputs (400). citeturn13view1turn13view2 | `text.format` supports `json_schema`; supports a subset of JSON Schema with explicit limits on nesting, properties, enums, string size. citeturn14view0turn14view3turn3search29 | Both: JSON schema discipline improves agent reliability. | Medium | Build a “schema compiler” layer with per-provider constraints + tests. |
| Thinking / reasoning | Adaptive thinking is recommended for 4.6; `budget_tokens` deprecated. Tool use requires preserving thinking blocks for continuity; interleaved thinking via adaptive mode. citeturn12view0turn6search15turn12view3 | Reasoning tokens are internal and discarded from context; can include encrypted reasoning items for stateless continuity; can request reasoning summaries. citeturn10view2turn16search25 | Both can do multi-step work; both have “effort” knobs (but semantics differ). citeturn10view2turn12view3 | High | Remove any design that depends on “visible thought as state.” Use GPT reasoning summary/encrypted items if needed. |
| Prompt caching | Explicit breakpoints + TTL (default 5m; optional 1h). Explicit invalidation rules across `tools → system → messages`. citeturn25view0turn24view0turn24view2 | Automatic prefix caching for prompts ≥1024 tokens; guided by `prompt_cache_key`; optional `prompt_cache_retention` (`in_memory` vs `24h`). citeturn11view3turn23view0 | Both reward “stable prefix first.” citeturn11view3turn25view0 | Medium | Keep the “prefix discipline,” but rewrite the knobs and observability around each provider’s caching model. |
| Long-running context mgmt | Compaction is beta (header-gated) on Opus/Sonnet 4.6. citeturn17view7turn16search5 | GPT‑5.4 is trained for compaction; server-side compaction can emit an encrypted compaction item; recommended for long-running agents. citeturn11view6turn22view5turn17view6 | Both offer compaction concepts. | Medium | For GPT‑5.4, plan on compaction as a first-class part of the loop; for Claude, treat as optional beta. |
| Coding assistant primitives | Text editor + bash are schema-less client tools you implement; code execution is a server tool with its own constraints (and ZDR rules differ). citeturn17view0turn19view0turn18view0turn17view1 | `apply_patch` + `shell` are native tool surfaces; shell can be hosted or local; local shell is labeled outdated. citeturn21view2turn17view5turn22view0 | Both can support edit→test→fix loops. | High | Prefer GPT’s `apply_patch` + hosted shell for deterministic verification; keep Claude’s editor/bash loop when staying on Claude. |
| Safety / risky actions | Strong emphasis on tool formatting + tool permission patterns in Claude Code and tool docs; programmatic tool calling warns about code injection and timeouts. citeturn19view0turn26view0 | OpenAI agent guidance emphasizes approvals + guardrails; computer use guide formalizes confirmation-at-risk and “treat only user instructions as permission.” citeturn11view5turn22view2 | Both require product-level approvals. | Medium | Make approvals a workflow node, not a “prompt promise.” Follow provider guidance for untrusted content handling. |

## Detailed analysis by topic

### Instruction hierarchy

**Claude 4.6 family (Messages API):**

- In the Claude Messages API, **system instructions are provided via a top-level `system` parameter**; there is **no `"system"` role inside `messages[]`**. This is a mechanical difference from GPT-style role stacks and changes how you build a stable prefix. citeturn1search0turn6search16  
- Claude prompt engineering guidance treats XML structuring as a helpful technique for clarity and output control, but it does not change the API’s authority model; the API authority is still primarily system + tool configuration + message history. citeturn12view4turn6search16  

**GPT‑5.4 family (Responses API + role hierarchy):**

- GPT request inputs explicitly encode instruction precedence: `developer` and `system` take priority over `user`, and prior assistant messages are treated as model outputs. citeturn1search9turn1search6  
- The `instructions` parameter is documented as a high-level instruction channel that takes priority over `input`. This gives you a stable “always-on behavior contract” that does not require you to embed everything into message text. citeturn1search2  

**Stable principle:** keep non-negotiable policy and the tool contract in a stable prefix that rarely changes, and keep user/task specifics late. This improves both model reliability and caching efficiency on both providers. citeturn11view3turn25view0  

**Time-sensitive change to incorporate for GPT‑5.4:** the platform introduced an assistant message `phase` field to distinguish “commentary” from “final answer” in tool-heavy workflows; if your integration drops it, the model can mis-handle intermediate updates. citeturn11view6turn3search5turn9search3  

### Tool calling patterns

**Claude 4.6 family: client tools vs server tools**

- Claude distinguishes **client-executed** tools (you run them) from **server-executed** tools (Anthropic runs them). For server tools like `web_search`, `web_fetch`, `code_execution`, and `tool_search`, you do **not** construct `tool_result` blocks because the server executes and feeds results back before you receive the response. citeturn17view1turn4search1  
- For client tools, Claude returns `stop_reason:"tool_use"` plus one or more `tool_use` blocks, and your next user message must include `tool_result` blocks with strict formatting rules: tool results must immediately follow the tool use message in history, and the `tool_result` blocks must come first in the content array (text only after). citeturn12view6turn6search14  
- Claude supports parallel tool use; if you return tool results in separate user messages, the docs warn this can reduce future parallel behavior. You can also disable parallel tool use with `disable_parallel_tool_use`. citeturn12view5turn6search16  
- Claude “strict tool use” exists (`strict:true` on tools) and Claude structured outputs include explicit schema complexity limits that can produce 400 errors when exceeded (details in the structured outputs section). citeturn13view0turn5search2  

**Claude 4.6 special case: programmatic tool calling (code-execution-mediated tools)**

- Programmatic tool calling runs tools *from inside code execution* and can reduce token usage because intermediate tool results do not enter Claude’s context; only the final code execution result does. citeturn26view0turn18view0  
- It has important constraints: tools with `strict:true` are not supported; forcing a specific tool via `tool_choice` is not supported; `disable_parallel_tool_use:true` is not supported; and when pending programmatic tool calls exist, the “tool result only response” restriction applies (the user message must contain only `tool_result` blocks, no text). citeturn26view0  
- Containers have lifecycle/timeout behavior (idle cleanup), and Claude may retry on timeout if your tool response arrives after `expires_at`. citeturn26view0  

**GPT‑5.4 family: built-in tools + function calling**

- The Responses API is positioned as the recommended primitive for agentic loops and can call built-in tools and custom functions, including multiple tool calls, within a request. citeturn1search3turn16search13turn11view1  
- GPT function calling output items include a `call_id` and JSON-encoded arguments; your tool results must be returned as `function_call_output` items keyed by that `call_id`. citeturn15view3turn11view0  
- **Parallel function calling is explicitly documented as not possible when using built-in tools.** If your agent relies on parallel fanout, you must design around this constraint (for example: separate a “function fanout turn” from a “web_search turn”). citeturn15view0turn11view1  
- You can disable multi-function calling via `parallel_tool_calls:false`. citeturn15view0  

**Time-sensitive GPT‑5.4 changes:** tool search (`tool_search`) exists only on GPT‑5.4 and later. It is designed to preserve cache by injecting discovered tool definitions at the end of the context window. citeturn11view2turn10view5turn11view6  

### Structured outputs and JSON schema limits

**Claude structured outputs (Sonnet/Opus 4.6):**

- Structured outputs are generally available for Claude Opus 4.6 and Sonnet 4.6. citeturn10view0turn13view2  
- Claude enforces explicit schema complexity limits across strict tools and JSON outputs, including caps such as: max 20 strict tools per request, max 24 optional parameters total, and max 16 union-type parameters (with additional internal grammar-size limits and a 180-second compilation timeout). citeturn13view0turn13view3  
- Claude structured outputs have documented incompatibilities: for example, enabling citations with `output_config.format` returns a 400 error. citeturn13view1turn13view2  

**GPT Structured Outputs (used by GPT‑5.4):**

- OpenAI Structured Outputs (`text.format` with `json_schema`) support a documented subset of JSON Schema, including supported primitive types and `anyOf`. citeturn14view0turn3search0  
- OpenAI documents explicit schema bounds such as: up to 10 levels of nesting, up to 5000 object properties total, total string length constraints, and enum limits (including additional limits when an enum has many string values). citeturn14view3turn14view0  
- In function calling strict mode, OpenAI documents schema requirements: `additionalProperties:false` and all `properties` marked `required`, with optionality expressed via union with `null`. citeturn15view0  
- A sharp migration gotcha: **Responses requests may normalize your schema into strict mode when `strict` is omitted**, which can turn previously optional fields into required fields, while Chat Completions remain non-strict by default. citeturn15view0turn3search27  

**Stable principle:** treat schemas as production artifacts with tests, size budgets, and provider-specific compilation constraints. Don’t rely on “the model will probably follow it.” citeturn13view0turn3search0  

### Reasoning and “thinking” behavior

**Claude 4.6: adaptive thinking + interleaved thinking**

- Claude 4.6 recommends adaptive thinking (`thinking:{type:"adaptive"}`) and deprecates manual thinking budgets (`thinking:{type:"enabled", budget_tokens:N}`), indicating they will be removed in a future release. citeturn12view0turn12view3turn16search22  
- When using extended thinking with tool use, Claude’s docs emphasize preserving thinking blocks unmodified across tool turns for continuity. citeturn6search15turn6search23  
- Adaptive thinking automatically enables interleaved thinking and is positioned as especially effective for agentic workflows. citeturn12view3  

**GPT‑5.4: internal reasoning tokens + optional summaries + encrypted continuity**

- Reasoning models allocate internal reasoning tokens and **discard them from context** after producing visible output tokens; they are not shown by default but still take context space and are billed as output tokens. citeturn10view2  
- For stateless usage (`store:false` or ZDR), OpenAI documents **encrypted reasoning items** (`reasoning.encrypted_content`) that you can include across turns so the model can “carry reasoning state” without exposing raw reasoning. citeturn10view2turn16search25turn2search5  
- OpenAI also supports reasoning summaries via a `summary` setting (model-dependent). citeturn10view2turn2search12  

**What this means for migrating a Claude-style `<thinking>` design:**

- If your Claude-first design stored a `<thinking>` transcript and replayed it, that is aligned with Claude’s “preserve thinking blocks” requirement during tool use. citeturn6search15  
- For GPT‑5.4, a Claude-style `<thinking>` transcript is at best redundant and at worst harmful (extra tokens, more instruction surface, and it can mislead downstream logic). GPT’s supported path is: keep conversational state via Responses conversation mechanics, and use reasoning summaries or encrypted reasoning items for continuity/debugging, not literal thought logs. citeturn10view2turn11view4turn16search25  

### State, prompt caching, and request assembly

**Claude 4.6 prompt caching and invalidation**

- Claude prompt caching is explicitly breakpoint-oriented with TTL: default 5 minutes and optional 1 hour via `cache_control.ttl:"1h"`. citeturn25view0turn25view1  
- The cache covers the prompt prefix in a structured order (`tools → system → messages`) and has documented invalidation behavior when you change tool definitions, system toggles, speed flags, and more. citeturn24view0turn25view0  
- Claude also documents subtle interactions with thinking blocks and tool result-only user turns: cache remains valid when only tool results are provided as user messages, but adding non-tool-result user content can cause previous thinking blocks to be stripped from context. citeturn24view2turn6search12  

**GPT‑5.4 prompt caching and retention**

- OpenAI prompt caching is automatic for prompts ≥1024 tokens and relies on exact prefix matches. You can guide routing and improve cache hit rates with `prompt_cache_key`. citeturn11view3turn23view0  
- Retention is configured per request via `prompt_cache_retention` with documented values (`in_memory` vs `24h`), and OpenAI documents how extended retention stores key/value tensors in GPU-local storage (not raw prompt text). citeturn23view0turn23view1  
- OpenAI stores Response objects for 30 days by default unless `store:false`, while conversation objects and items are not subject to that 30-day TTL. This matters for how you implement “server remembers state” vs “client replays state.” citeturn11view4turn2search2  

**GPT‑5.4 tool search and caching interaction**

- Tool search is designed to preserve cache by injecting discovered tools at the end of the context window. You activate it by adding `tool_search` and marking deferred tools with `defer_loading:true`. citeturn11view2turn11view0turn10view5  

**Claude tool search and caching interaction**

- Claude tool search uses deferred loading and `tool_reference` blocks; tool definitions with `defer_loading:true` are stripped from the rendered tools prefix before the cache key is computed, and discovered tools are expanded inline later, preserving prefix cache. citeturn6search10turn17view3turn10view4  

### Agent orchestration design and safety

**Coordinator/worker contracts**

- GPT‑5.4 is explicitly described as strong for long-running and multi-step agent workflows, and the Responses API is positioned as the unified interface for tool-heavy, multi-turn interactions. citeturn10view5turn1search3turn22view4  
- For GPT‑5.4, the addition of `phase` (commentary vs final answer) is an orchestration contract: intermediate progress updates should be marked as commentary, and the final deliverable as final answer, to avoid early stopping or confusion. citeturn3search5turn11view6turn9search7  
- For Claude, tool handling docs emphasize that you should not rely on specific text phrasing around tool use; your orchestration should be driven by tool blocks / stop reasons, not by prose. citeturn7view0turn12view6  

**Safety / approvals as workflow, not prompt text**

- OpenAI’s agent safety guidance recommends keeping tool approvals enabled (especially around MCP tools), using guardrails, and designing workflows so untrusted data does not directly drive tool calls. citeturn11view5turn3search6  
- OpenAI’s computer use guidance formalizes the “confirm at the point of risk” pattern and explicitly warns not to treat on-screen instructions or third-party content as permission. citeturn22view2  
- Claude’s bash tool docs emphasize allowlists over blocklists and address shell operator bypass, which is directly relevant to designing a safe coding agent verification loop. citeturn19view0  
- Claude programmatic tool calling explicitly warns about code injection risks when tool results are interpreted/executed as code inside the sandbox. citeturn26view0  

## Concrete migration advice

### Keep

- **The “stable prefix / dynamic tail” architecture.** Both providers’ caching systems reward it, even though the knobs differ. citeturn11view3turn25view0  
- **Schema-first contracts for handoffs and tool I/O.** Both providers have strict modes and structured outputs; you will get reliability gains in multi-agent orchestration. citeturn3search0turn13view0turn15view0  
- **Explicit safety gates (approvals) for risky actions** as part of your orchestrator, not as a “please ask first” line in the prompt. citeturn11view5turn22view2turn19view0  

### Change

- **Claude tool-loop mechanics → GPT call_id tool-loop mechanics.** Replace `tool_use`/`tool_result` message formatting with `function_call`/`function_call_output` patterns keyed by `call_id`. citeturn12view6turn15view3  
- **Parallelism assumptions.** If your Claude-first system used parallel tool calls heavily, GPT will require a re-plan: you cannot do parallel function calling when built-in tools are enabled. citeturn15view0turn11view1  
- **Reasoning persistence.** Replace any “store and replay thinking text” approach with GPT’s supported continuity mechanisms (conversation state, encrypted reasoning items, compaction items). citeturn10view2turn22view5turn11view4  
- **Caching configuration.** Convert Claude’s TTL + breakpoint strategy into OpenAI’s `prompt_cache_key` + retention policy and strict prefix stability approach. citeturn23view0turn11view3turn25view0  

### Remove

- **Claude-style `<thinking>` transcripts as a first-class artifact in GPT.** GPT reasoning tokens are not meant to be replayed as text; you’ll spend tokens and add attack surface with little benefit. citeturn10view2  
- **Claude-specific message formatting requirements** (tool results first, adjacency rules) in the GPT pathway—they don’t map cleanly and can lead to brittle adapters. citeturn12view6turn15view3  

### Replace with

- **GPT-native coding primitives**: adopt `apply_patch` for multi-file edits + `shell` for deterministic verification when you are on GPT‑5.4, and integrate approvals around patch application and shell commands. citeturn21view2turn17view5turn20view1  
- **GPT-native long-run memory controls**: adopt server-side compaction (`context_management.compact_threshold`) or `/responses/compact` when building genuinely long trajectories. citeturn22view5turn17view6turn11view6  
- **Claude 4.6 thinking configuration**: migrate from `budget_tokens` to adaptive thinking + effort when targeting Claude 4.6. citeturn12view0turn12view3  

## Example prompt translations and patterns

Below are “before vs after” patterns that commonly appear in Claude-first stacks.

### XML-style instruction wrapper

**Claude-first (common pattern):**

```xml
<system>
You are a coding agent.
Follow repo conventions.
When using tools, explain briefly.
</system>

<task>
Fix the failing tests.
</task>

<output_format>
Return:
1) what you changed
2) why
3) commands run
</output_format>
```

**GPT‑5.4-first translation (role + phase aware):**

```json
{
  "model": "gpt-5.4",
  "instructions": "You are a coding agent. Follow repo conventions. Be concise but complete.",
  "input": [
    { "role": "developer", "content": "Tool rules: use apply_patch for edits; use shell only for read/test/verify; require approval before risky actions." },
    { "role": "user", "content": "Fix the failing tests. Return: (1) changes (2) rationale (3) commands run." }
  ]
}
```

Why: on GPT, authority comes from the instruction hierarchy and tool contracts, not from XML. XML can still help readability, but it is not the controlling mechanism. citeturn1search9turn1search2  

### Long prose tool description → schema-first + strictness expectations

**Claude-first tool definition (conceptual):** long description + JSON schema, relying on Claude’s natural adherence.

**GPT‑5.4-first approach:** use function calling strict mode and accept the stricter schema constraints.

```json
{
  "type": "function",
  "name": "run_tests",
  "description": "Run the test suite. Return machine-readable results.",
  "parameters": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "command": { "type": "string" },
      "timeout_seconds": { "type": ["integer", "null"] }
    },
    "required": ["command", "timeout_seconds"]
  },
  "strict": true
}
```

Note the GPT strict-mode constraints (`additionalProperties:false`, all fields required; optionality via `null`). citeturn15view0turn2search0  

### Coordinator/worker handoff contract

**Claude-first handoff (often text-based):** coordinator writes a plan; worker executes with tools; handoff is freeform.

**GPT‑5.4-first handoff (structured output contract):** coordinator emits JSON that workers must follow.

Coordinator call (`text.format: json_schema`) to produce a task packet:

```json
{
  "type": "json_schema",
  "name": "task_packet",
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "goal": { "type": "string" },
      "acceptance_tests": { "type": "array", "items": { "type": "string" } },
      "allowed_tools": { "type": "array", "items": { "type": "string" } },
      "risky_actions": { "type": "array", "items": { "type": "string" } }
    },
    "required": ["goal", "acceptance_tests", "allowed_tools", "risky_actions"]
  },
  "strict": true
}
```

This aligns with OpenAI’s guidance to use structured outputs to reduce injection risk and keep workflows auditable. citeturn3search0turn11view5turn14view3  

### Prompt caching layout

**Claude-first caching layout:**

- Cache breakpoints on `tools` and/or `system`, possibly with TTL `1h` for long sessions. citeturn25view0turn24view0turn24view3  

**GPT‑5.4-first caching layout:**

- Put stable prefix first; keep tool lists + schemas identical; set a consistent `prompt_cache_key`; choose `prompt_cache_retention:"24h"` if you want longer retention. citeturn11view3turn23view0turn23view1  

### Tool runner loop and phase usage

For GPT‑5.4, explicitly separate intermediate updates from the final answer using `phase`, especially in tool-heavy flows. citeturn3search5turn11view6  

For Claude, enforce the strict adjacency and ordering constraints for `tool_result` blocks; never put text before tool results when returning them. citeturn12view6turn6search14  

### Mermaid: coordinator → worker → verify loop

```mermaid
flowchart TD
  U[User request] --> C[Coordinator]
  C -->|Task packet (JSON schema)| W[Worker]
  W -->|Tool call(s)| T[Tools: edit / run / search]
  T -->|Tool outputs| W
  W --> V[Verifier: tests / lint / checks]
  V -->|pass| R[Final response]
  V -->|fail| W
```

This diagram matches both ecosystems conceptually, but on GPT you typically implement edits via apply_patch + verification via shell, while on Claude you often implement edits via text editor + verification via bash or server-side code execution (depending on your tool choices). citeturn21view2turn17view5turn17view0turn19view0turn18view0  

## Open questions and model-version gated features

Some details are explicitly version-gated or underspecified in docs; treat them as “requires probing in your own eval harness.”

- **GPT `phase` support scope.** OpenAI’s changelog indicates `phase` was added to the Responses API, and the latest model guide recommends it for GPT‑5.4 flows. The exact failure modes and enforcement level can vary by model snapshot and by whether you rely on intermediate assistant updates. citeturn11view6turn10view5turn9search7  
- **Tool search behavior differences between providers.** Both providers aim to preserve cache by deferring tool schemas and injecting discovered tools late, but GPT’s docs emphasize end-of-context injection and namespaces/MCP as preferred surfaces; Claude’s docs emphasize `tool_reference` expansion outside the cached prefix. Exact retrieval quality and ranking will depend on your tool catalog and naming conventions. citeturn11view2turn6search10turn17view3  
- **Parallelism constraints in GPT with built-in tools.** The docs are clear that parallel function calling is not possible when using built-in tools, but they do not fully specify whether the model can still emit multiple built-in tool calls in one turn in all cases; you should test your exact tool mix. citeturn15view0turn1search3turn11view1  
- **Claude programmatic tool calling constraints.** The docs list specific incompatibilities (no `strict:true`, no forced `tool_choice`, no disabling parallel tool use) that materially impact how you design tool policies. If your architecture assumes “strict everywhere,” programmatic calling may not fit. citeturn26view0  
- **Compaction maturity differences.** GPT‑5.4 is described as trained for compaction and supports server-side compaction with encrypted compaction items; Claude compaction is explicitly beta and header-gated for Opus/Sonnet 4.6. Treat cross-provider parity here as incomplete. citeturn22view5turn11view6turn17view7turn16search5  
- **Deprecation timelines.** OpenAI has a published Assistants API shutdown date (August 26, 2026). Claude 4.6 docs state `budget_tokens` will be removed in a future model release but do not provide a date. Plan migrations accordingly. citeturn9search8turn12view0turn12view3