# Audit — single-argument `resolveRequestProvider` call sites

**Date:** 2026-08-22 · Triggered by `a5345456`, which fixed one instance of this shape in
`src/tools/AgentTool/agentToolUtils.ts` and raised the obvious question: how many others.

## The shape

`resolveRequestProvider(model, baseProvider?)` (`src/utils/model/providers.ts:190`) decides a
request's provider. Omit the second argument and it falls back to `getAPIProvider()`, the
**process-global session provider**. In this repo the per-request provider is decided by the
model string, and a subagent can carry its own `mainLoopProvider` that differs from the
session's. So an omitted second argument silently answers "what is the session on?" when the
caller meant "what is THIS worker on?".

**Reachability, the same path in every case.** A `gpt-*` worker spawns a child on a Claude
model; `runAgent.ts:764` gives that child `mainLoopProvider: 'openai'` with a non-`gpt-*`
model. The child's `options.provider` is `'openai'` while the process-global
`getAPIProvider()` is `'firstParty'`. Divergence requires exactly that: a non-`gpt-*` model
plus a provider that did not come from the model string.

## Result

**65 call sites** in `src/` (excluding tests): 47 already two-argument, **18 single-argument**.
Of those 18: **11 CORRECT, 7 LATENT BUG, 0 unclear.**

The correct ones are genuinely session-scoped side calls where the global fallback is the
right answer: `queryHaiku` (`claude.ts:3601`), the away summary (`awaySummary.ts:45`),
teleport (`teleport.tsx:128`), session title (`sessionTitle.ts:108`), `/rename`
(`generateSessionName.ts:45`), the agent wizard (`generateAgent.ts:145`), skill improvement
(`skillImprovement.ts:215`), and `REPL.tsx:2748`, which is the session's own
`mainLoopProvider` and therefore the value every worker-scoped site inherits.
`queryContext.ts:124` deserves a special mention: it deliberately rebuilds the **main loop's**
cache-safe prefix, so a worker provider there would break the very cache match it exists to
preserve.

Worth stating plainly: the worker-facing surfaces of `AgentTool`, `runAgent` and the built-in
agents are already correctly two-argument throughout. The fixed commit really was an outlier
there, and most of what is left is fine.

## The 7 latent bugs

| `file:line` | Decides | Consequence when wrong |
|---|---|---|
| **`src/utils/api.ts:165`** (FIXED `7664e580`) | tool-schema cache key, OpenAI property renaming, `tool.prompt({provider})` text, `Apply_patch` grammar, `eager_input_streaming` | Codex request carries Anthropic-shaped schemas and descriptions; `Apply_patch` loses its grammar fields; a first-party-only flag set on a Codex request. **And `getToolSchemaCache()` is process-wide and keyed on that provider, so the poisoned entry is then served to correctly-routed callers.** The damage escapes the worker that caused it. |
| **`src/services/api/claude.ts:507`** (FIXED `7664e580`) | `isCodex` in `configureEffortParams` | `EFFORT_BETA_HEADER` (an Anthropic beta) pushed onto a Codex request. Reverse direction: a real Anthropic worker on a Codex session silently loses its effort beta header. |
| `src/constants/prompts.ts:742` (`getSystemPrompt`) | the whole system-prompt style | Anthropic-style core policy sent to a Codex request, or GPT-style to Claude. Also moves the prompt-cache prefix. |
| `src/constants/prompts.ts:575` | agent-mode sections | same family |
| `src/constants/prompts.ts:1012` | model-description env block | same family, reached only via the two above |
| `src/services/deferredContinuationRunner.ts:252` | is this persisted job a Codex job | a legitimately queued continue-after-limit job is killed and marked needs-attention; the resumed turn never runs |
| `src/services/deferredContinuationRunner.ts:256` | the terminal reason for the above | wrong reason recorded |

**Both top findings sit on the hot path**, and in both cases the correctly-scoped value is
already computed in the same lexical scope: `claude.ts:1166` does
`resolveRequestProvider(options.model, options.provider)` into `requestProvider`, which is
live at the `toolToAPISchema` call (~`:1376`) and the `configureEffortParams` call (~`:1746`).
Verified by reading both. Nothing downstream re-checks; `client.ts:453` only emits a
diagnostic.

The clearest smell in the `prompts.ts` family is `src/services/SessionMemory/sessionMemory.ts`,
verified directly: it resolves correctly with two arguments at `:413`, then nine lines later
calls `getSystemPrompt(tools, mainLoopModel)` at `:422` with one.

## The deferred-continuation pair is a different shape

`cat-code deferred-continuation-worker` (`cli.tsx:66-68`) is a fresh launchd process that runs
`prepareBackgroundDeferredContinuation()` before the CLI graph loads, so `getAPIProvider()`
there is the persisted `lastUsedProvider` from global config, set by whatever session ran most
recently **anywhere on the machine**. `DeferredContinuationJobV1.context` is a `.strict()` zod
schema with `model` but **no `provider` field**, so there is nothing better to pass: fixing it
means a schema migration, not an argument. The gate may also be redundant, since
`evaluateDeferredContinuationEligibility` (`deferredContinuation.ts:1167`) already refuses
non-Codex at creation. The same gap exists in the argv the worker builds: `--model
job.context.model` with no `--provider`.

## Correction found while fixing

This audit said the `toolToAPISchema` fix was a one-call-site change. It is not:
`toolToAPISchema` has **three** call sites — `claude.ts:1384` (fixed), plus
`src/services/compact/autoCompact.ts:401` and `src/utils/analyzeContext.ts:321`. The new
`provider` option was therefore made OPTIONAL, so those two keep the `getAPIProvider()`
fallback and their behaviour is unchanged. They remain latently mis-scoped in the same way if
either is ever reached from a worker whose provider diverges. Note also that
`autoCompact.ts:360` carries a comment claiming it mirrors "the same `toolToAPISchema` the
request path itself uses", which is now one argument less true. Follow-up, not swept.

## Adjacent findings, different shape

- `src/utils/hooks/skillImprovement.ts:215` uses `getSmallFastModel()` while all five sibling
  side calls use `getSmallFastModelForProvider()`. On a Codex session it builds an OpenAI
  assembly around a Haiku model. Wrong-model, not wrong-scope.
- `src/tools/AgentTool/resumeAgent.ts:220` is the only `getAgentModel` caller omitting the 5th
  `parentProvider` argument (`runAgent.ts:385` passes it). Its only consumer is Bedrock
  region-prefix inheritance and no reachable failure was constructed.
- `src/constants/promptStyle.ts:23` (`isGPTPromptStyleForModel`) has zero production callers.

## Order of work

1. ~~**`src/utils/api.ts:165`**~~ — **FIXED in `7664e580`.**
2. ~~**`src/services/api/claude.ts:507`**~~ — **FIXED in `7664e580`.** Four tests, both
   directions of the effort bug covered, mutation-checked twice: revert both lines and it is
   0 pass / 4 fail.
3. **The `prompts.ts` family** — largest per-occurrence blast radius but narrower
   reachability, and it needs a threaded parameter rather than an argument. Precedent exists
   in the same file: `enhanceSystemPromptWithEnvDetails` already takes an optional 5th
   `provider?`.
4. **The deferred-continuation pair** — schema migration; weigh against simply deleting a gate
   that may be redundant.
