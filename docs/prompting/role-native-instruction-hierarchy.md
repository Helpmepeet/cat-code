# Role-native instruction hierarchy

## Summary

The current instruction assembly path is still Claude-first even when the active provider is OpenAI/GPT. The main query loop builds a single `SystemPrompt` array, appends `systemContext` to it, prepends `userContext` as a synthetic user meta message, and sends the resulting request through the Anthropic message shape. On the OpenAI path, `src/services/api/codex-fetch-adapter.ts` then translates that Anthropic-shaped request into a Codex/OpenAI request by flattening the top-level `system` field into `instructions` and converting the Anthropic `messages[]` history into Codex `input` items.

That means provider selection exists at the transport level, but not yet at the instruction-assembly level. GPT is not getting a role-native hierarchy assembled intentionally for GPT; it is getting a Claude-shaped request translated after the fact.

Recommended direction: keep instruction *content generation* largely shared, but introduce a provider-aware instruction assembly dispatch before API request construction. Claude-family providers should keep the current top-level `system` + no `system` role in `messages[]` path. GPT/OpenAI should assemble an intentional OpenAI-native instruction plan before transport encoding, where stable behavioral instructions go into `instructions`, provider-specific context placement is explicit, and Claude-specific prompt-wrapping assumptions stop leaking across the provider boundary. In the first slice, that does **not** require replacing the Anthropic SDK client plumbing immediately; it requires moving instruction-hierarchy decisions above the current fetch-adapter boundary so the OpenAI path stops deriving its authority model from an Anthropic-shaped request.

## Relevant files

Primary implementation surfaces:

- `src/query.ts`
- `src/utils/api.ts`
- `src/utils/queryContext.ts`
- `src/utils/systemPrompt.ts`
- `src/services/api/client.ts`
- `src/services/api/claude.ts`
- `src/services/api/codex-fetch-adapter.ts`
- `src/utils/model/providers.ts`

Supporting context:

- `src/constants/prompts.ts`
- `docs/research/provider-differences.md`
- `docs/vision/GOAL_PLAN.md`

## Current behavior

### 1. Shared prompt content is built as Claude-style system prompt blocks

The root prompt content is assembled through:

- `src/utils/queryContext.ts:44` via `fetchSystemPromptParts()`
- `src/utils/systemPrompt.ts:41` via `buildEffectiveSystemPrompt()`
- `src/constants/prompts.ts:120` and below, where the default prompt is authored as a large system-prompt document made of sections and boundary markers

This produces a `SystemPrompt` array of strings, not a provider-neutral instruction object.

Important consequence: the core behavioral prompt is already modeled as "things that belong in Claude top-level system blocks". That assumption is reinforced one layer up by `src/utils/systemPrompt.ts:41-123`, where `buildEffectiveSystemPrompt()` selects and returns a `SystemPrompt` array as the canonical prompt artifact for the main loop.

### 2. Query assembly treats system/user context in a provider-independent way, but that way is Claude-shaped

In `src/query.ts`:

- `src/query.ts:464` builds `fullSystemPrompt` by calling `appendSystemContext(systemPrompt, systemContext)`
- `src/query.ts:675` injects `userContext` by calling `prependUserContext(messagesForQuery, userContext)`
- `src/query.ts:674-722` then calls `deps.callModel()` with:
  - `messages: prependUserContext(...)`
  - `systemPrompt: fullSystemPrompt`

The helper behavior is defined in `src/utils/api.ts`:

- `src/utils/api.ts:437` `appendSystemContext()` appends system context as extra system-prompt text
- `src/utils/api.ts:449` `prependUserContext()` injects context as a synthetic `<system-reminder>` user message

This is the clearest current instruction assembly surface. It decides which material is expressed as system-level authority versus synthetic user-turn content.

### 3. The provider-specific request path lives below that layer

Provider routing exists, but late:

- `src/utils/model/providers.ts:14` chooses the active provider
- `src/services/api/client.ts:162-181` and `src/services/api/client.ts:331-346` route OpenAI/Codex requests through a fetch adapter while still instantiating the Anthropic SDK client

So the application is provider-aware for transport/auth, but the assembled request contract remains Anthropic-first until the final adapter layer.

### 4. Claude request construction is native and deeply integrated

In `src/services/api/claude.ts`:

- `src/services/api/claude.ts:1363-1374` mutates/extends the system prompt with attribution prefix, CLI prefix, advisor instructions, and Chrome tool-search instructions
- `src/services/api/claude.ts:1381` converts the prompt into Anthropic `system` blocks via `buildSystemPromptBlocks()`
- `src/services/api/claude.ts:3218` implements `buildSystemPromptBlocks()` specifically for Anthropic text blocks with prompt-cache metadata

This code is not just transport code. It contains Anthropic-native assembly semantics, caching semantics, and system-prompt shaping rules.

### 5. OpenAI currently receives a translated Anthropic request, not a native GPT assembly

The key leak is in `src/services/api/codex-fetch-adapter.ts`:

- `src/services/api/codex-fetch-adapter.ts:253-325` translates a full Anthropic request body into Codex format
- `src/services/api/codex-fetch-adapter.ts:263-284` reads Anthropic top-level `system`
- `src/services/api/codex-fetch-adapter.ts:273-295` flattens that into OpenAI `instructions`
- `src/services/api/codex-fetch-adapter.ts:287` converts Anthropic `messages[]` into Codex `input`

So GPT does not currently get provider-native hierarchy chosen by the app. It gets:

1. Claude-style `systemPrompt`
2. Claude-style `messages[]`
3. Claude-style synthetic user meta context
4. then a translation step that maps top-level `system` to `instructions`

This is exactly the kind of "shared format that one provider misreads or only partially honors" described in the Phase 0 goal.

## Where Claude-first assumptions leak into GPT

### A. `SystemPrompt` is the canonical instruction representation

`SystemPrompt` arrays are the source of truth throughout the stack. That representation fits Anthropic directly, but GPT should not be forced to inherit it as the only semantic structure.

### B. `userContext` is injected as a synthetic user message

`src/utils/api.ts:449-474` prepends a `<system-reminder>` user message. This is a Claude-era convention. It may still work on GPT, but it is not a native role-aware placement strategy. Some of that content likely belongs in OpenAI `instructions` or a provider-specific high-priority instruction role rather than synthetic user text.

### C. `systemContext` is appended as extra system prompt text

`src/utils/api.ts:437-447` always appends system context into the system prompt array. That is fine for Claude, but GPT may need a more explicit split between stable instructions, dynamic runtime context, and user-turn content.

### D. Anthropic-only prompt caching structure is embedded in instruction assembly

`src/constants/prompts.ts:112-119` and `src/utils/api.ts:296-435` revolve around Anthropic prompt block boundaries and cache scopes. Prefix stability is still valuable for GPT, but the exact block format and cache semantics are Anthropic-specific and should not define GPT assembly.

### E. OpenAI uses an Anthropic adapter instead of owning its own request assembly

`src/services/api/client.ts:162-181` and `src/services/api/codex-fetch-adapter.ts:253-325` mean the OpenAI path inherits Anthropic assumptions by construction. The adapter is currently both protocol bridge and de facto instruction assembly bridge, even though transport still runs through Anthropic SDK client plumbing in the current implementation.

## Current architecture: shared vs provider-specific content

### Shared today

These pieces are already good candidates to stay shared:

- Default prompt content and policy sections from `src/constants/prompts.ts`
- Effective prompt selection in `src/utils/systemPrompt.ts` and `src/utils/queryContext.ts`
- User/session/repo context collection from the context-loading path used by `fetchSystemPromptParts()`
- Message history objects in the app’s internal `Message[]` form
- Tool definitions and tool orchestration at the app level

### Provider-specific today

These pieces are already provider-specific, though too late in the stack:

- Provider selection: `src/utils/model/providers.ts`
- Provider transport/auth: `src/services/api/client.ts`
- Anthropic request shaping and prompt caching blocks: `src/services/api/claude.ts`
- OpenAI translation from Anthropic body to Codex body: `src/services/api/codex-fetch-adapter.ts`

### Architectural mismatch

The mismatch is that provider-specific behavior starts only after the instruction hierarchy has already been decided. Shared content is fine; shared authority structure is not.

One more nuance: for the purposes of this refactor, Bedrock / Vertex / Foundry still belong on the Anthropic-shaped side of the split. The immediate hierarchy problem is primarily Anthropic-family request assembly versus OpenAI/GPT request assembly, not "every provider gets a wholly different prompt stack".

## Design recommendation

### Principle

Split the system into:

1. **Shared instruction content generation**
2. **Provider-native instruction assembly**
3. **Provider-native transport encoding**

Today, (1) and (2) are fused into Claude semantics, and GPT only differs at (3). The next slice should separate (2).

### What should stay shared

Keep these shared for now:

- The underlying instruction text from `src/constants/prompts.ts`
- The current prompt-selection logic in `fetchSystemPromptParts()` / `buildEffectiveSystemPrompt()`
- Internal conversation history as `Message[]`
- Tool schema generation and orchestration
- Context collection (`userContext`, `systemContext`) as raw data

In other words: do not rewrite the whole prompt corpus yet. The first change is not "new prompts"; it is "provider-native assembly of the existing prompt materials".

### What should split by provider

Introduce a provider-aware assembly layer that decides how to place:

- stable behavioral instructions
- dynamic system/runtime context
- synthetic reminders / context banners
- conversation history

#### Claude path

Keep Claude native:

- top-level `system` parameter
- no `system` role in `messages[]`
- current Anthropic block-building and cache-control logic
- current Anthropic-oriented `buildSystemPromptBlocks()` behavior

But make it explicit that this is the **Claude assembler**, not the universal request format.

#### GPT path

Create a GPT-native assembler that outputs an OpenAI/Codex request-ready instruction plan before transport translation.

Recommended first version:

- Put stable behavioral instructions into OpenAI `instructions`
- Keep the live conversation in `input`
- Stop relying on Anthropic `system` existing as the source format for GPT
- Introduce explicit placement rules for `userContext` and `systemContext`

Suggested GPT placement in the first implementation slice:

- `instructions`: stable shared prompt content that currently becomes `systemPrompt`
- `input` conversation items: normalized conversation history
- a GPT-owned runtime-context preamble or equivalent encoded field for dynamic context placement
- leave tool schemas as provider-native translated tools for now

If the current Codex/OpenAI backend path only reliably supports `instructions` plus `input`, that is acceptable for the first slice. Do **not** make role-stacked `developer`/`system` items a requirement for slice one unless the codebase first grows a true OpenAI-native request object and encoder. The important change is that GPT assembly becomes intentional and first-class, instead of coming from an Anthropic request translation.

### Specific dispatch location

The dispatch should live **above** `src/services/api/claude.ts` and **above** `src/services/api/codex-fetch-adapter.ts`, in the query-to-model boundary where the app still has semantic knowledge of:

- `systemPrompt`
- `userContext`
- `systemContext`
- internal `Message[]`
- active provider

The best fit in the current workspace is the `deps.callModel()` boundary used by `src/query.ts:674-722`.

Concretely:

- `src/query.ts` should stop directly imposing the same `prependUserContext(...)` + `appendSystemContext(...)` strategy on every provider.
- Instead, it should call a new provider-aware assembly function before `callModel`.

### Concrete shape of the dispatch

Add a new assembly module, for example:

- `src/services/api/instructionAssembly.ts`
  - `buildProviderInstructionAssembly(...)`

Suggested return shape:

```ts
type ProviderInstructionAssembly =
  | {
      provider: 'anthropic'
      messages: Message[]
      systemPrompt: SystemPrompt
    }
  | {
      provider: 'openai'
      inputMessages: Message[]
      instructions: string
      runtimeContext?: string
    }
```

Or, if you want fewer transport details leaking upward, use a richer semantic object:

```ts
type InstructionAssembly = {
  provider: APIProvider
  stableInstructions: string[]
  runtimeSystemContext: Record<string, string>
  runtimeUserContext: Record<string, string>
  messages: Message[]
}
```

and let each provider encoder map that to its wire format.

Given the current codebase, the more practical option is the first one: return provider-ready assembly inputs.

### How the two provider paths should differ

#### Claude assembler

Input:

- base `systemPrompt`
- `systemContext`
- `userContext`
- `messages`

Output:

- `systemPrompt: appendSystemContext(systemPrompt, systemContext)`
- `messages: prependUserContext(messages, userContext)`

This preserves current behavior.

#### GPT assembler

Input:

- base `systemPrompt`
- `systemContext`
- `userContext`
- `messages`

Output:

- `instructions`: stable prompt text derived from `systemPrompt`
- `messages`: conversation history without pretending that all extra authority must be synthetic user content
- `runtimeContext`: explicit dynamic context string derived from `systemContext` and selected high-priority `userContext`

First-slice pragmatic rule:

- collapse `systemPrompt` into `instructions`
- keep user-authored conversation as conversation items
- move the synthetic `userContext` banner behind a GPT-specific formatter, not `prependUserContext()` directly
- make GPT context placement a dedicated function, e.g. `buildOpenAIContextPreamble()`

That still may render context as a message-like preamble initially, but it will be *owned by the GPT path* and easy to evolve into role-stacked developer/system items later.

### What not to change yet

Do **not** change these in this slice:

- tool loop mechanics
- tool schema backend
- compaction logic
- prompt corpus wording in `src/constants/prompts.ts`
- agent orchestration behavior
- cache invalidation strategy outside instruction assembly boundaries
- MCP/tool-search design

This document is only about instruction hierarchy and request assembly.

## Proposed implementation plan

### Step 1: Introduce provider-aware assembly before transport

Create a new function that receives:

- `provider`
- `messages`
- `systemPrompt`
- `systemContext`
- `userContext`

and returns provider-specific assembled instruction inputs.

Important scope note:

- the first slice should change semantic instruction assembly, not necessarily replace the current Anthropic SDK client plumbing on the OpenAI path
- the first slice should preserve the existing upstream contract around custom prompts and resolved context inputs

### Step 2: Change `src/query.ts` to use that dispatch

Replace the current direct calls to:

- `appendSystemContext(...)`
- `prependUserContext(...)`

with a single provider-aware assembly call.

This is the most important architectural move.

### Step 3: Keep `src/services/api/claude.ts` as the Claude-native encoder

`src/services/api/claude.ts` should continue owning Anthropic-specific details like:

- `buildSystemPromptBlocks()`
- Anthropic prompt caching block metadata
- Anthropic-specific system prompt prefixes/betas

### Step 4: Shrink `src/services/api/codex-fetch-adapter.ts` out of the instruction-semantics role

The adapter should eventually translate:

- provider-native GPT assembly

not:

- an Anthropic request body that happened to be generated first

In the near term, if transport constraints force continued adapter use, the adapter should accept a more GPT-native intermediate shape rather than mining Anthropic `system` and `messages` as its source of truth.

That means success for this slice is:

- OpenAI hierarchy decisions happen before the adapter
- the adapter becomes an encoder/bridge, not the place where authority structure is inferred

## Additional gaps to account for

### 1. Side-question / cache-safe rebuild path must not drift

`src/utils/queryContext.ts:88-179` rebuilds cache-safe params using the same `systemPrompt` + `userContext` + `systemContext` model. If only the main query path is made provider-aware, side-question and resume-related flows can keep reconstructing Anthropic-shaped hierarchy assumptions and drift from the main loop.

Implication:

- the new assembly contract should either be reused here or this path should remain explicitly constrained to Anthropic-family behavior until OpenAI support is implemented deliberately

### 2. Custom system prompt changes what context even exists

`src/utils/queryContext.ts:61-72` skips `getSystemContext()` when `customSystemPrompt` is set. That is part of the current contract, not an incidental detail. A provider-aware assembler must preserve that behavior intentionally or change it explicitly with eyes open.

Implication:

- the new assembly layer should operate on the already-resolved prompt/context inputs, not silently re-fetch context and accidentally widen the authority surface for custom-prompt sessions

### 3. Debug/tracing should record semantic assembly, not just Anthropic wire shape

Today, multiple debug and tracing paths assume Anthropic-shaped prompt data, including:

- `src/services/api/claude.ts:1493-1499`
- `src/utils/api.ts:281-435`

If GPT gets native assembly earlier in the stack, those paths may stop reflecting the real request semantics even if transport still works.

Implication:

- add a provider-neutral instruction-assembly debug record so prompt dumps, tracing, and regression comparisons remain meaningful across providers

## Risks and migration traps

### 1. Prefix caching regressions

The current code carefully preserves Anthropic prefix structure and caching boundaries. A naive GPT split could improve hierarchy correctness while accidentally reducing cache hit rates.

Mitigation:

- preserve stable-prefix discipline
- keep stable behavioral instructions in one deterministic field
- keep dynamic runtime context late and clearly separated

### 2. Hidden dependencies on synthetic `<system-reminder>` user messages

Some downstream logic may implicitly expect user context to appear as a synthetic user message. If GPT stops receiving that exact shape, behavior may shift.

Mitigation:

- audit any code or tests that inspect the first user message or rely on `<system-reminder>` wrappers
- change only the provider-specific assembly layer first, not the raw collected context

### 3. Anthropic assumptions embedded in analytics/debug/VCR tooling

There are multiple places that log or record `systemPrompt` and Anthropic-shaped request data, such as:

- `src/services/api/claude.ts:1493-1508`
- `src/services/api/claude.ts:3218-3242`

If GPT becomes native earlier in the stack, some of that instrumentation may stop reflecting the actual wire request.

Mitigation:

- preserve a semantic instruction-assembly debug record independent of raw provider body shape

### 4. Over-correcting into a full prompt rewrite

The current problem is request assembly hierarchy, not prompt wording. Rewriting prompt content simultaneously would make it impossible to tell whether gains came from hierarchy correctness or content changes.

Mitigation:

- keep content stable in the first slice
- change only assembly and placement

### 5. Codex adapter constraints may tempt another partial shim

It is easy to add more translation logic inside `codex-fetch-adapter.ts` and call that “provider awareness”. That would keep the real authority model hidden behind an Anthropic-first source shape.

Mitigation:

- put the dispatch before provider transport
- make OpenAI assembly an explicit top-level code path

## Verification strategy

### Static verification

- Confirm `src/query.ts` no longer directly applies `prependUserContext()` / `appendSystemContext()` universally.
- Confirm there is a provider-aware assembly function that branches on `getAPIProvider()` or an explicit provider parameter.
- Confirm the GPT path no longer depends on Anthropic request `system` as the source of truth for instructions.
- Confirm side-question / fallback rebuild paths do not silently reconstruct the old universal Anthropic-shaped hierarchy for OpenAI sessions.
- Confirm custom-system-prompt sessions preserve the current resolved-context contract unless deliberately changed.

### Request-shape verification

For Claude:

- verify requests still use top-level `system`
- verify no `system` role is injected into Claude `messages[]`
- verify `buildSystemPromptBlocks()` still owns Anthropic cache block behavior

For GPT:

- verify requests are assembled intentionally for OpenAI/Codex
- verify stable instructions are carried in `instructions` or GPT-native top-priority role items
- verify the GPT path does not require Anthropic `system` to exist first

### Behavioral verification

Run side-by-side prompt dump comparisons for the same conversation on Claude vs GPT and check:

- stable instructions preserved on both
- provider-native hierarchy differs where intended
- GPT no longer receives Claude-only structural assumptions as the governing format

### Regression checks

- existing Claude behavior unchanged
- no prompt-cache collapse on Claude
- no tool-call regression caused by changed context placement

## Suggested next implementation slice

1. Add a provider-aware assembly module at the query/model boundary.
2. Route Claude through a `buildAnthropicInstructionAssembly()` path that preserves existing behavior.
3. Route OpenAI through a `buildOpenAIInstructionAssembly()` path that produces native GPT instruction placement.
4. Keep the current prompt content unchanged.
5. Update the Codex adapter so it consumes GPT-native assembly inputs rather than inferring hierarchy from an Anthropic-shaped request.

The smallest good slice is not a rewrite of prompts or tools. It is introducing explicit provider-specific instruction assembly at the boundary currently occupied by `appendSystemContext()` and `prependUserContext()` in `src/query.ts`.