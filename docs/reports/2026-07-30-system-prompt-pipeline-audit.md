# System-instruction pipeline audit

Date: 2026-07-30 (revision 5 — operator-approved remediation plan attached)
Pinned commit: `8448eec` on `migration`. Citations were re-checked against
this commit where the working tree was dirty (`src/screens/REPL.tsx` is
mid-edit by a concurrent session; its citations below use pinned-commit line
numbers). As of r5 `src/` is clean at `a424574`; the REPL citations were
re-verified there and still hold.

**Implementers: read §G (provenance) and §H (approved remediation plan)
first.** §H is the authoritative work order — every option below it was
chosen by the operator on 2026-07-30 and is not open for re-litigation.
§A–§F remain the diagnostic record.

Revision 5 changes (no cold review; operator-directed follow-up session):

- **A9 resolved with verified dates.** Anthropic's official model table was
  re-fetched 2026-07-30. Fable 5 and Sonnet 5 are confirmed wrong
  (both should be January 2026). The table's implicit convention is
  identified: it tracks **reliable knowledge cutoff**, not training data
  cutoff. The Opus 4.8/4.7 claim is **downgraded to latent** — those model
  IDs do not exist anywhere in this repo, so nothing reaches that
  fall-through today.
- **A5 widened (confirmed).** The default (non-agent-mode) prompt path
  embeds no identity prefix at all, so ordinary GPT sessions ship
  `instructions` with **no identity line whatsoever**, not merely the wrong
  variant. Severity assessment added: the prefix's load-bearing role is
  Anthropic 1P request gating, not prompt content, which is why the GPT-side
  absence is cosmetic today and the structural gap (B3) is the real risk.
- **A6 re-attributed.** Upstream Claude Code logs this failure
  (`Failed to get system prompt for agent ${agentType}: …`). The fork
  replaced it with a bare `catch (_error)`. This is a fork regression, not
  inherited behavior.
- **§G added and then fully resolved:** per-finding provenance
  (fork-introduced vs upstream-inherited). The exact fork base,
  `@anthropic-ai/claude-code@2.1.87`, was pulled from npm, so this is a
  same-version comparison with **no unresolved rows**. Headline result:
  **A2's name-only cache keying is upstream verbatim**, which makes H1 a
  deliberate divergence rather than a bug fix (§G1). A3, A7, and the H7
  duplication are ours; A2-iii, A2-iv, and B1 are upstream.
- **§H added:** the approved remediation plan, with difficulty scores and
  delegation tags (§H0).

Revision 4 changes, in response to the third RED review:

- **A8 added (confirmed, high):** a normal-turn model/prompt mismatch the
  audit had missed — the REPL builds the prompt from the main-loop model,
  but `query()` remaps the actual request model per permission mode
  (`opusplan`/`haiku` aliases in Plan mode) and reuses the unchanged
  prompt.
- **A2 narrowed:** the cache findings apply only to prompt paths that reach
  the section registry; `CLAUDE_CODE_SIMPLE` and active proactive/KAIROS
  return before it, so A2-i/i-b/iii/iv and the swarm statement do not hold
  there.
- **B2 promoted to A9 (confirmed):** Anthropic's official model table lists
  Fable 5's cutoff as January 2026; the source emits May 2026. Verifying
  this surfaced two more wrong cutoffs (Sonnet 5; Opus 4.8/4.7 via prefix
  fall-through).
- **Fingerprint wording fixed:** the value carries no conversation
  identity; it *may* change when the first user message changes, and
  distinct conversations can share it.
- Appendix: the `git diff --no-index --check` exit code is now documented
  (exit 1 = files differ, expected; the check passes when no whitespace
  diagnostics are emitted).

Revision 3 changes, in response to the second RED review:

- **A2-i / Fact 1 corrected.** The revision-2 claim that the provider-switch
  lock confines section staleness to same-provider switches was false. A
  confirmed cross-provider path exists: `/context` warms the section cache
  before any turn, and `/model gpt-*` legitimately switches provider while
  input tokens are zero without clearing that cache. Bonus finding: the
  `/context` warmer passes only two arguments, resurrecting the
  partial-args poisoning withdrawn in revision 2 — now with a live entry
  point.
- **A2-ii direction corrected.** The normal production direction is
  leader → teammate (spawn happens mid-turn, after the leader's prompt
  build); the bidirectional "cold-cache ordering" race claim is withdrawn.
- **A2-iv added:** mid-session `/config` language changes never reach the
  prompt (name-only cached `language` section).
- **A5 expanded:** the SDK identity prefix is also lost on OpenAI
  agent-mode headless sessions, by bypass rather than overwrite.
- **Fingerprint section:** removed the unsupported "prompt cache is reset
  anyway" reassurance; server-side impact is now explicitly unresolved.
- Accuracy fixes: A1's "every other consumer filters the marker" corrected
  (mode 3 does not — that is B1); A3's REPL citation corrected to the
  pinned commit (`3106`, not the drifted working-tree `3115`); A7's "every
  non-agent-mode prompt" narrowed to the default prompt path; the report
  file is untracked, so plain `git diff --check` never inspected it —
  whitespace was checked with `git diff --no-index --check`.

Revision 2 changes (kept for the record): A1's two originally named
triggers withdrawn (startup and interactive selection resolve the session
provider from the model first); `/summary` poisoning withdrawn as
unreachable dead code; late-MCP-connect staleness withdrawn (no output-byte
effect); Fact 2 qualified with the one-time `migrateFromUpstreamClaude`
copy; fingerprint half-resolved from source; call-site count and prefix
constant corrections.

---

## Scope and acceptance contract

Task (from the dispatching brief, paraphrased): audit how the system
instruction sent to the model is built and delivered, from source-file
assembly to the literal text that reaches the API. A finding counts as done
when it has an exact file:line, a concrete mechanism (what goes wrong and
under what trigger), and a labeled confidence — **confirmed** (both sides
traced in source) vs **suspected** (plausible but unverified). Behavioral
bugs are separated from cosmetic/naming issues. Read-only: no source files
edited, no live model requests.

Stages audited: prompt corpus and section registry
(`src/constants/prompts.ts`, `src/constants/systemPromptSections.ts`,
`src/bootstrap/state.ts`), context builders (`src/context.ts`), branch
selection (`src/utils/systemPrompt.ts`, `src/utils/queryContext.ts`,
`src/QueryEngine.ts`, `src/screens/REPL.tsx`), delivery (`src/query.ts`,
`src/services/api/instructionAssembly.ts`, `src/services/api/claude.ts`,
`src/services/api/codex-fetch-adapter.ts`), and the subagent side path
(`src/tools/AgentTool/runAgent.ts`).

**Explicitly out of scope:**

- `claudemd.ts` content-discovery internals beyond the tier-fallback
  question: `@include` guards, worktree deduplication, memory-file framing.
- Live wire captures / emitted-payload evidence. All findings are static
  source traces; none were demonstrated against a running model.
- Server-side prompt-cache semantics (how the API keys its prefix cache).

---

## A. Behavioral defects

### A1. `buildOpenAIInstructions` does not filter the `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` marker — reachable only via cross-provider fallback

**Mechanism (confirmed).** The boundary marker is inserted gated on
`shouldUseGlobalCacheScope()` (`src/constants/prompts.ts:853`, `:626` for
agent mode) = `getAPIProvider() === 'firstParty' && !DISABLE_EXPERIMENTAL_BETAS`
(`src/utils/betas.ts:233-238`) — the **session** provider. The OpenAI
instruction join has **no marker filtering**
(`src/services/api/instructionAssembly.ts:80`), and the codex adapter sends
`instructions` verbatim (`src/services/api/codex-fetch-adapter.ts:1284`,
`:1307`). The consumers that do filter it: `splitSysPromptPrefix` modes 1
and 2 (`src/utils/api.ts:380`, `:416`) and `/context`
(`src/utils/analyzeContext.ts:287`). Mode 3 does **not** filter it either —
that gap is B1.

**Withdrawn triggers (revision 2).** For the marker to leak, the session
provider must be `firstParty` while a request routes to OpenAI. The two
workflows named in revision 1 cannot produce that state:

- Startup: `main.tsx:2152` calls
  `setSessionProvider(resolveStartupProvider(resolvedInitialModel, …))`, and
  `resolveStartupProvider` returns the model-implied provider first
  (`src/utils/model/providers.ts:170-180`). A `cat-code -p --model gpt-5.6-*`
  one-shot therefore runs with session provider `openai` → no marker ever
  inserted.
- Interactive selection: `/model` calls
  `setSessionProvider(resolveModelSelectionProvider(model))`
  (`src/commands/model/model.tsx:98`, `:260`). Note this *also* means a
  pre-turn provider switch changes the marker decision for subsequent
  builds — the residual staleness that creates is A2-i's cross-provider
  path, not a marker leak (the marker is static-side and rebuilt per turn).

**Remaining trigger (suspected).** Cross-provider model fallback: with
`--fallback-model gpt-*` configured in an Anthropic session,
`FallbackTriggeredError` handling swaps only the request provider
(`src/query.ts:946-952`) and re-enters `buildProviderInstructionAssembly`
(`src/query.ts:697`) with the marker-bearing `systemPrompt` built under
`firstParty`. Every link is source-traced, but the configuration is unusual
and no emitted request was captured, so the reachable leak is **suspected**.

**Impact if reached.** A bare `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` line in
the GPT model's instructions. Regardless of reachability, the missing
filter is a defense-in-depth gap: one
`if (block === SYSTEM_PROMPT_DYNAMIC_BOUNDARY) continue` in
`buildOpenAIInstructions` closes it (and the same skip belongs in
`splitSysPromptPrefix` mode 3, per B1).

### A2. The section cache is keyed by name only, ignoring the arguments each compute closure captured

Root design flaw (**confirmed**): `resolveSystemPromptSections` returns
`cache.get(name)` for any warm name
(`src/constants/systemPromptSections.ts:50-52`) with no keying on captured
arguments; the cache is one process-global Map
(`src/bootstrap/state.ts:1680-1693`) shared by every in-process
`getSystemPrompt()` caller. Staleness becomes a defect when a captured
input drifts in a way that changes the compute's *output bytes*; the
instances below are those where that provably holds.

**Path scope (added in r4):** every instance below applies only to the
prompt paths that reach `resolveSystemPromptSections` — the default build
and the dedicated agent-mode build. `CLAUDE_CODE_SIMPLE` returns before the
registry (`src/constants/prompts.ts:663-670`), and an active
proactive/KAIROS session returns from its own assembly
(`prompts.ts:699-722`) that reads language, memory, and environment
directly and includes no output-style section. In those modes A2-i's
cross-provider staleness, A2-i-b's `/context` poisoning, A2-iii's split
output style, and A2-iv's frozen language do **not** occur (proactive picks
up a language change on the next build), and the swarm statement in A2-ii
is moot. The cache is also
partly deliberate — it damps mid-session GrowthBook flips
(`src/constants/prompts.ts:479`; cf. `src/Tool.ts:304`,
`src/tools/AgentTool/forkSubagent.ts:64`) — so the fix is keying (or
targeted invalidation), not removal.

- **A2-i — model/provider switch staleness, including a confirmed
  cross-provider path (revised in r3).** `env_info_simple`
  (`prompts.ts:740-742`), `frc` (`:763`), and `session_guidance`
  (`:727-734`) are cached; none of the seven `clearSystemPromptSections()`
  call sites across five files (`postCompactCleanup.ts:62`,
  `EnterWorktreeTool.ts:99`, `ExitWorktreeTool.ts:143`, `setup.ts:359`,
  `sessionRestore.ts:382/426/550`) fire on a model or provider switch, so
  the QueryEngine refresh (`src/QueryEngine.ts:553-589`) is a no-op for
  them. Revision 2 wrongly claimed the provider-switch lock confines this
  to same-provider switches. The **cross-provider sequence is reachable
  and confirmed**: (1) `/context` warms the whole registry before any turn
  — `analyzeContextUsage` calls `getSystemPrompt(tools, runtimeModel)`
  (`src/utils/analyzeContext.ts:938`); (2) `/model gpt-*` is permitted
  while no input tokens have been consumed
  (`canApplyModelSelection`, `src/utils/model/providers.ts:124-132`:
  `(!isProviderSwitchLocked() && totalInputTokens === 0) || sameProvider`)
  and sets the session provider (`model.tsx:98`) without touching the
  section registry; (3) the first GPT turn then builds GPT-style static
  sections but serves the cached Claude-style `session_guidance`, the old
  Anthropic provider/model lines in `env_info_simple`, and the old `frc` —
  a style-mixed prompt until `/clear`/`/compact`/worktree/restore.
  **Confirmed.** Recommended follow-up (not done here — read-only audit): a
  pairwise regression test covering cache warming (`/context`) followed by
  pre-turn provider selection.
- **A2-i-b — `/context` is a live partial-args cache warmer (new in r3;
  resurrects the entry point withdrawn in r2).** The same
  `analyzeContext.ts:938` call passes only `(tools, runtimeModel)` — no
  additional working directories, no mcpClients. Run `/context` while the
  registry is cold (session start before the first turn, or after a
  `/compact`) in a session with `--add-dir` directories, and
  `env_info_simple` is cached **without** the "Additional working
  directories" block; every subsequent turn serves it until the next cache
  clear. (`mcp_instructions` is unaffected — it is `DANGEROUS_uncached`.)
  Also note `runtimeModel` comes from `getRuntimeMainLoopModel`, which can
  differ from the main-loop model, warming `env_info_simple` under a model
  the main loop is not using. **Confirmed mechanism.**
- **A2-ii — in-process swarm teammates read or seed the shared cache with
  mismatched tool sets (direction corrected in r3).**
  `src/utils/swarm/inProcessRunner.ts:1126-1131` calls
  `deps.getSystemPrompt(tools, mainLoopModel, undefined, mcpClients)` with
  the teammate's restricted pool (`:1110-1120`) and no additional dirs. In
  the normal production path a teammate is spawned by an `Agent` tool call
  mid-turn (`src/tools/AgentTool/AgentTool.tsx:653` region), i.e. *after*
  the leader's request already built its prompt — so the cache is warm and
  the reachable direction is **leader → teammate**: a restricted teammate
  inherits `session_guidance`/using-tools text for tools it does not
  possess, and the leader's `env_info_simple`. The reverse
  (teammate poisons the leader) would require the section cache to be
  cleared mid-turn between the leader's build and the spawn (e.g. an
  auto-compact cleanup); that window is **suspected only** — no production
  sequence was traced, and the r2 "cold-cache ordering decides who poisons
  whom" claim is withdrawn. **Confirmed mechanism (leader → teammate);
  feature-gated to swarm builds; no live repro run.**
- **A2-iii — mid-session output-style change produces a split prompt.**
  `getOutputStyleConfig()` is re-read each call and drives *static*
  sections (intro `prompts.ts:834`, doing-tasks gate `:838-841`), while the
  `# Output Style: …` section is cached (`:746-748`) and no command clears
  the section cache on a style change (verified: the seven sites above are
  the only callers). After a style change via `/config`, the intro
  references "your Output Style below" while the cached section still
  shows the old style (or is absent). **Confirmed mechanism.**
- **A2-iv — mid-session language change never reaches the prompt (new in
  r3).** The `/config` language picker applies immediately
  (`src/components/Settings/Config.tsx:1555`), and a settings write resets
  the settings-layer cache (`resetSettingsCache`,
  `src/utils/settings/settingsCache.ts` — its doc comment lists "settings
  write" as a trigger), so `getInitialSettings().language` returns the new
  value on the next prompt build. But `language` is a name-only cached
  section (`prompts.ts:743-745`) and `settings.language` has no other
  consumer in the prompt, so the change — including first *enabling* a
  language, which hits the cached-`null` latch — is invisible until
  `/clear`/`/compact`/worktree/restore. Either this is a defect, or the
  intended contract is "language changes apply next session", in which
  case that contract is recorded nowhere. **Confirmed mechanism.**

**Withdrawn instances (revision 2, still withdrawn):**

- */summary after compact* — unreachable as a command:
  `src/commands/summary/index.js` is a disabled stub and
  `manuallyExtractSessionMemory` (`sessionMemory.ts:392`) has no caller.
  Its partial-args hazard is now superseded by the *reachable* `/context`
  variant (A2-i-b); the dead call remains flagged in §C.
- *Late MCP connect* — no output-byte effect: MCP tools are namespaced
  `mcp__server__tool` and the guidance builders branch only on fixed core
  names (`prompts.ts:436-482`); MCP instructions are handled by the
  separately recomputed `DANGEROUS_uncached` section (`:754-761`).

### A3. Two truthiness parsers for `CLAUDE_CODE_AGENT_MODE`: `yes`, `on`, `TRUE` produce a hybrid non-prompt

**Mechanism (confirmed).** `fetchSystemPromptParts` gates the dedicated
agent-mode sections on `=== '1' || === 'true'` exact-match
(`src/utils/queryContext.ts:66`; same literal at
`8448eec:src/screens/REPL.tsx:3106` and `:2803`).
`buildEffectiveSystemPrompt` and `getSystemPrompt` use `isEnvTruthy`, which
also accepts `yes`, `on`, any casing (`src/utils/systemPrompt.ts:28-30`,
`src/constants/prompts.ts:514-516`, `src/utils/envUtils.ts:39-44`).

**Trigger.** `CLAUDE_CODE_AGENT_MODE=yes` (or `on`, `TRUE`, …). Result:
`agentModePromptSections` is never built, `buildEffectiveSystemPrompt`'s
agent-mode branch fails its `&& agentModePromptSections` guard
(`src/utils/systemPrompt.ts:68`) and falls through — but `getSystemPrompt`
built that "default" with `isAgentMode=true`, dropping the Doing-tasks and
Actions sections and swapping in agent-mode using-tools/guidance
(`src/constants/prompts.ts:836-849`). The session runs on an
agent-mode-flavored default prompt with no agent-mode doctrine, while
`getAgentModeUserContext` merging in QueryEngine still happens.

**Impact.** Silently degraded prompt in a mode designed around a strict
doctrine-first assembly. **Confirmed** (both parsers and the fall-through
read; not exercised live).

### A4. Model fallback mid-query never refreshes the system prompt

**Mechanism (confirmed).** On `FallbackTriggeredError`, query.ts swaps
`currentModel`/`currentProvider` and rebuilds only the instruction assembly
(`src/query.ts:946-978`, loop re-entry at `:697`) with the same
`systemPrompt`. The retried request carries the original model's prompt:
"You are powered by … \<old model\>", old knowledge cutoff, old provider
line, and — for a cross-provider fallback — the wrong prompt style
entirely. Unlike the deliberate switch handling
(`src/QueryEngine.ts:553-589`), nothing re-runs `fetchSystemPromptParts`
here, so even fresh sections would not be fetched.

**Trigger.** `--fallback-model` firing on overloaded/529. Same-family
fallback yields a wrong-identity/cutoff line for the remainder of the turn;
the prompt heals next turn. Cross-provider fallback would compound with A1.
**Confirmed mechanism; not exercised live.**

### A5. The non-interactive CLI identity prefix is lost in agent-mode headless sessions — by overwrite on Anthropic, by bypass on OpenAI

**Anthropic path — overwrite (confirmed).** Agent-mode prompts embed
`getCLISyspromptPrefix()` (no args → `"You are Cat Code."`) as their first
section (`src/constants/prompts.ts:618`). At request time claude.ts
prepends a second prefix computed with
`{isNonInteractive, hasAppendSystemPrompt}`
(`src/services/api/claude.ts:1511-1514`) — in a headless session
`"You are an agent for Cat Code."` or the Agent-SDK preset
(`src/constants/system.ts`). `splitSysPromptPrefix` recognizes prefix
blocks by membership in `CLI_SYSPROMPT_PREFIXES` and stores them in a
single overwritten variable (`src/utils/api.ts:420-421`; same in mode 1 at
`:383-384`), so the later block wins: the embedded default overwrites the
non-interactive variant, which vanishes from the request.

**OpenAI path — bypass (confirmed, added in r3).** The OpenAI instruction
string is frozen at assembly time from the systemPrompt array alone
(`src/services/api/instructionAssembly.ts:49`, join at `:80`), which in
agent mode contains only the embedded no-arg default prefix. claude.ts's
request-time prepend of the correct non-interactive prefix
(`claude.ts:1508-1519`) mutates only the Anthropic-shaped `system` blocks;
when the request is OpenAI, the frozen assembly is sent instead
(`claude.ts:1698-1707`). So a GPT agent-mode `-p`/SDK session's
instructions open with `"You are Cat Code."` and the non-interactive
variant never exists anywhere in the payload.

**Wider than stated above: ordinary GPT sessions carry no prefix at all
(confirmed, added in r5).** `getCLISyspromptPrefix` is embedded into a
prompt array in exactly two places: the agent-mode builder
(`prompts.ts:618`, called with **no arguments**, so always the interactive
default) and the `CLAUDE_CODE_SIMPLE` builder (`prompts.ts:667`, called with
arguments). The **default prompt path does not embed it** — its array opens
with the intro section (`prompts.ts:832-856`) and relies entirely on the
request-time prepend at `claude.ts:1511`. Since that prepend cannot reach
the OpenAI payload (see above), a normal GPT session's `instructions`
contain **no identity line whatsoever**. The GPT intro that opens them
(`promptStyles/gpt.ts:97`) states a role but never names the product.

**Severity qualification (r5).** The prefix's load-bearing job is Anthropic
1P request gating, not prompt content: `claude.ts:597` warns that a request
"will fail in 1P unless it uses `getCLISyspromptPrefix`". Codex/OpenAI has
no equivalent gate. So the GPT-side absence is cosmetic today. The durable
risk is the structural one in B3: the next request-time addition will miss
GPT silently, with no test to catch it.

**Trigger.** Agent mode + non-interactive (SDK/`-p`), either provider.
Interactive Anthropic sessions produce the identical default string twice,
so the single-slot behavior degrades into harmless dedupe.

**Impact.** Wrong identity-line variant; low severity, but a silent content
drop, and the single-slot design will eat any future second prefix-set
member the same way. Recommended follow-up: a test asserting the final
OpenAI `instructions` payload for an agent-mode non-interactive session.
**Confirmed** (static tracing; final payload not captured live).

### A6. A subagent whose `getSystemPrompt()` throws is silently given the generic default prompt

**Mechanism (confirmed).** `src/tools/AgentTool/runAgent.ts:1021-1030`:
`try { agentPrompt = agentDefinition.getSystemPrompt(…) } catch (_error) {
agentPrompt = getDefaultAgentPrompt(…) }` — no logging, no telemetry, no
transcript marker. A custom agent with a throwing prompt function runs with
none of its instructions and reports results as if it were the intended
agent.

**Trigger.** Any throwing `getSystemPrompt`. No currently-throwing
definition was found, so the practical trigger is **suspected**; the
swallow itself is confirmed.

**Provenance (r5): this is a fork regression, not inherited.** Upstream
Claude Code logs the failure at the same site. From the 2.1.27 bundle:
`catch(o){ I(\`Failed to get system prompt for agent ${V.agentType}: ${o
instanceof Error?o…` — a real log call with the agent type interpolated.
The fork replaced it with a bare `catch (_error)`. Restoring diagnostics
here is a revert to upstream behavior, not a new feature.

### A7. `length_guidance` duplicates an instruction already present in the static output section

The dynamic section emits `'Keep updates brief. Keep final answers concise
unless more detail is needed for clarity.'` unconditionally within the
default prompt build (`src/constants/prompts.ts:768-772`). The Claude-style
static section contains that exact sentence (`prompts.ts:497`); the GPT
static section carries a near-verbatim RULE 4
(`src/constants/promptStyles/gpt.ts:305`). Scope (narrowed in r3): this
duplication applies to the **default prompt path** of `getSystemPrompt`
(both styles) — the `CLAUDE_CODE_SIMPLE`, proactive, custom/override,
coordinator, and agent-mode assemblies do not include `length_guidance`.
**Confirmed.** Minor behavioral weight; wasted tokens in the uncached
dynamic region on every default-path request.

### A8. Normal-turn model/prompt mismatch: the prompt is built from the main-loop model, but the request model is remapped per permission mode (added in r4; high impact)

**Mechanism (confirmed).** The REPL builds the prompt from the unmapped
main-loop model (`getSystemPrompt(freshTools, mainLoopModelParam, …)`,
`8448eec:src/screens/REPL.tsx:3120`). `query()` then computes the *actual*
request model per permission mode on every call:
`currentModel = getRuntimeMainLoopModel({ permissionMode, mainLoopModel, … })`
(`src/query.ts:477-485`), where `opusplan` in Plan mode maps to Opus and
the `haiku` alias in Plan mode maps to Sonnet
(`src/utils/model/model.ts:231-249`) — and reuses the unchanged prompt in
the instruction assembly (`src/query.ts:697`).

**Trigger.** Ordinary Plan-mode turns with the `opusplan` or `haiku` model
settings — no fallback, no provider switch, no cache involvement. An
`opusplan` Plan-mode turn sends an Opus request whose prompt asserts a
Sonnet identity and cutoff; a `haiku`-alias Plan-mode turn sends Sonnet
with a Haiku prompt.

**Impact.** The serving model is told it is a different model, with a
different knowledge cutoff, on a fully supported everyday path. This is
the normal-turn sibling of A4 (fallback) — and note the codebase already
disagrees with itself here: `/context` computes its display prompt from
`getRuntimeMainLoopModel` (`src/utils/analyzeContext.ts:930-938`), so in
Plan mode `/context` and the actual turn build prompts for *different
models* against the same shared section cache (compounding A2-i-b).
Recommended follow-up (not done here): a public-path regression test
asserting the env-info model line matches the model actually sent for an
`opusplan` Plan-mode turn; the fix belongs to engine prompt-pipeline
ownership. **Confirmed** (all three links source-traced; not exercised
live).

### A9. Wrong knowledge cutoffs in the environment section: Fable 5, Sonnet 5, and Opus 4.8/4.7 (promoted from B2 and expanded in r4)

**Mechanism (confirmed).** `getKnowledgeCutoff`
(`src/constants/prompts.ts:993-1016`) hardcodes cutoffs. Anthropic's
official model table
(<https://platform.claude.com/docs/en/about-claude/models/overview>,
re-fetched 2026-07-30 for r5) contradicts two live entries.

**The table's implicit convention (identified in r5): it tracks the
official _reliable knowledge cutoff_ column, not _training data cutoff_.**
Every currently-correct entry matches the reliable column and several
diverge from the training column (Sonnet 4.6 reliable Aug 2025 / training
Jan 2026; Opus 4.5 reliable May 2025 / training Aug 2025; Haiku 4.5
reliable Feb 2025 / training Jul 2025). Any fix must preserve that
convention. For the two wrong entries the distinction is moot — both
official columns read Jan 2026.

Full comparison against the official table:

| Branch | Source emits | Official reliable | Official training | Verdict |
|---|---|---|---|---|
| `claude-fable-5` (`:995-996`) | May 2026 | **Jan 2026** | Jan 2026 | **wrong** |
| `claude-opus-5` (`:997-998`) | May 2026 | May 2026 | May 2026 | correct |
| `claude-sonnet-5` (`:999-1000`) | March 2026 | **Jan 2026** | Jan 2026 | **wrong** |
| `claude-sonnet-4-6` (`:1001-1002`) | August 2025 | Aug 2025 | Jan 2026 | correct |
| `claude-opus-4-6` (`:1003-1004`) | May 2025 | May 2025 | Aug 2025 | correct |
| `claude-opus-4-5` (`:1005-1006`) | May 2025 | May 2025 | Aug 2025 | correct |
| `claude-haiku-4` (`:1007-1008`) | February 2025 | Feb 2025 | Jul 2025 | correct |
| `claude-opus-4`/`claude-sonnet-4` fall-through (`:1009-1013`) | January 2025 | Jan 2025 (4.1, Sonnet 4.5) | — | correct for what reaches it |

**Opus 4.8 / 4.7: downgraded to latent (r5).** The r4 claim that these fall
through to `'January 2025'` against an official Jan 2026 is arithmetically
right but **not reachable in this repo**: `rg -a 'opus-4-8|opus-4-7' src/`
returns exactly one hit, `src/utils/undercover.ts:49`, where the strings
appear as *examples of unreleased version numbers*. There are no model-ID
constants, no routing entries, and no selectable models for either. Nothing
reaches that fall-through today. It becomes live the moment those IDs are
added, and the explicit branches must be inserted **above** the
`claude-opus-4` prefix test or they will be shadowed by it.

**Impact.** Every session on Fable 5 (the flagship default) and Sonnet 5 is
told a wrong cutoff in its environment section. Fable 5 is told it knows
four months more than it reliably does, which biases it toward confident
claims about a period it has no reliable knowledge of. **Confirmed**
(source vs the official published table, both re-verified in r5).

**Provenance (r5): ours.** `git blame` puts both wrong values in
`8b5ce81` (2026-07-29, "feat(model): add the Claude 5 family and retire
Claude 4.6"). The enclosing function is inherited (`^86051a8`); the two
wrong dates are fork-authored.

---

## B. Suspected (plausible, not fully verified)

- **B1. Unfiltered marker on the Anthropic no-boundary fallback.** With the
  boundary absent, `splitSysPromptPrefix` mode 3 joins everything into one
  org-scoped block (`src/utils/api.ts:453-476`) — the designed 3P behavior,
  no needless cache busting. But that loop, unlike modes 1 and 2, does
  **not** skip the boundary marker. Reaching it with a marker-bearing
  prompt requires a build-time/split-time disagreement on
  `shouldUseGlobalCacheScope()`; candidate windows are stale-snapshot
  replays (`CacheSafeParams` side-question/fork paths) around a pre-turn
  provider switch. **Low likelihood; same cheap defense-in-depth fix as
  A1.**
- **B2 — promoted to A9 in r4** (Fable 5's cutoff confirmed wrong against
  Anthropic's official model table, alongside Sonnet 5 and Opus 4.8/4.7).
- **B3. Request-time system-prompt appends never reach OpenAI requests.**
  claude.ts appends `ADVISOR_TOOL_INSTRUCTIONS` and
  `CHROME_TOOL_SEARCH_INSTRUCTIONS` at request time
  (`src/services/api/claude.ts:1516-1517`), but OpenAI requests use the
  assembly frozen earlier (`claude.ts:1698-1707`), so any claude.ts-level
  append is Anthropic-only by construction. The confirmed instance of this
  pattern is A5's OpenAI prefix bypass; the advisor/chrome appends sit
  behind Anthropic-leaning gates today (`isToolSearchEnabled` is
  model-gated, `claude.ts:1242`), so for them it remains a **suspected
  design gap** — the risk is that the next request-time append silently
  misses the GPT path.

---

## C. Cosmetic, naming, and dead-code hazards (no behavioral effect found)

- `FRONTIER_MODEL_NAME` declared and never used
  (`src/constants/prompts.ts:141`); `CLAUDE_4_5_OR_4_6_MODEL_IDS` holds
  Claude 5 IDs under a stale name (`:144`); the env line lists Haiku 4.5
  under "the most recent Claude model family is Claude 5" (`:978`).
- `getAgentModeSystemPromptSections` computes `envInfo` in its
  `Promise.all` and discards it via `void` (`prompts.ts:538-541`, `:613`);
  the section registry recomputes it. Wasted `getIsGit`/`uname` work per
  call.
- The 40-line "Reading session transcripts" literal is duplicated verbatim
  in both builders (`prompts.ts:576` and `:790`); both register under the
  same cache key, so if the copies drift, whichever computes first silently
  wins.
- Of the three OpenAI/non-OpenAI prefix pairs in `src/constants/system.ts`,
  two are byte-identical (`DEFAULT`, `AGENT_SDK`) — dead differentiation —
  while the Agent-SDK preset pair genuinely differs ("…within the Claude
  Agent SDK." vs "…within an agent SDK runtime.").
- **Dead-code latent hazard:** `manuallyExtractSessionMemory`
  (`sessionMemory.ts:392`) is uncalled (summary command is a disabled
  stub, `src/commands/summary/index.js`), but its
  `getSystemPrompt(tools, mainLoopModel)` call (`:422`) passes no
  additional working directories and no mcpClients — the same partial-args
  shape that is live-reachable through `/context` (A2-i-b). Re-enabling
  `/summary` adds a second entry point.

---

## D. The two pre-confirmed facts, re-verified

- **Fact 1 (stale sections on model switch): holds, and is broader than
  revision 2 stated.** The revision-2 "same-provider only" qualification is
  withdrawn: the `/context` → `/model gpt-*` → first-turn sequence (A2-i)
  is a confirmed pre-turn **cross-provider** staleness path, yielding a
  style-mixed prompt (GPT statics + Claude-style cached guidance + old
  provider/model env lines). The stale `env_info_simple` also includes the
  "This session is running through the X provider" line
  (`prompts.ts:979`).
- **Fact 2 (User-tier CLAUDE.md has no `~/.claude` loader fallback):
  holds, with a migration qualification.** The loader chain has no
  fallback: `getMemoryPath('User')` →
  `join(getClaudeConfigHomeDir(), 'CLAUDE.md')`
  (`src/utils/config.ts:1814-1819`), default `~/.cat-code`, no legacy path
  (`src/utils/envUtils.ts:15-21`), vs Project-tier's three paths per
  directory (`src/utils/claudemd.ts:900-920`, rules `:922-944`). **But** a
  one-time startup migration exists: `migrateFromUpstreamClaude`
  (`src/entrypoints/init.ts:48-51` →
  `src/migrations/migrateFromUpstreamClaude.ts:114`) copies
  `~/.claude/CLAUDE.md` into `~/.cat-code/` — skipped when
  `CLAUDE_CONFIG_DIR` points elsewhere, when the `.migrated-to-cat-code`
  stamp exists, when **`~/.cat-code/` already exists**, or when no legacy
  source dir exists (`migrateFromUpstreamClaude.ts:122-143`). The gap
  therefore bites when the migration was skipped, or when
  `~/.claude/CLAUDE.md` changes *after* the one-time copy (never
  re-synced). This machine demonstrates the skip case: `~/.cat-code/` was
  already a populated config dir, so the existing-dest guard (`:131`)
  prevented the copy, and the live `~/.claude/CLAUDE.md` (2,158 bytes) is
  invisible to User-tier loading.

Answer to the open question from the brief (`splitSysPromptPrefix` with the
boundary absent): mode 3 (`src/utils/api.ts:453-476`) joins everything into
one org-scoped block — designed behavior for 3P providers and for the
`CLAUDE_CODE_SIMPLE`/proactive prompt shapes that never insert the marker.
No needless cache busting on the Anthropic path; the marker-related defects
are A1 (confirmed missing filter, suspected reachability) and B1
(suspected).

---

## E. Unresolved / externally unverifiable

- **Attribution fingerprint — client-side behavior resolved; impact
  unresolved (revised in r3).** `computeFingerprint`
  (`src/utils/fingerprint.ts`) is
  `SHA256(salt + firstUserMessageChars[4,7,20] + version)[:3]`: stable
  across requests while the first user message is unchanged, and it **may**
  change when that message changes (new conversation, compaction replacing
  the first message). It carries no conversation identity — only three
  selected characters, a salt, and the version, truncated to three hex
  characters (`src/utils/fingerprint.ts:40` region) — so distinct
  conversations can deterministically share a value and changed messages
  can collide.
  What this *means* for caching is unresolved: the attribution header is
  the first system block with `cacheScope: null`
  (`src/services/api/claude.ts:1510`) ahead of the globally-scoped static
  block, global-scope caching is deliberately cross-conversation
  (`src/utils/api.ts:350` region), and client-side cleanup does not reset
  any server cache — so whether a fingerprint change invalidates the
  server's global prefix entry is a server-semantics question this audit
  cannot answer. Resolving it needs an emitted-payload/cache-hit
  experiment.
- B1's trigger window remains unverified as stated above. (B2 was resolved
  in r4 — see A9.)
- `claudemd.ts` discovery internals are out of scope per §Scope.
- No live model request or wire capture was made anywhere in this audit;
  every "confirmed" label means source-traced on both sides, not
  wire-demonstrated.

---

## F. Verification appendix

Representative commands (all read-only, from repo root):

```text
rg -n "SYSTEM_PROMPT_DYNAMIC_BOUNDARY" src/ --glob '!*.test.*' -a
rg -n "clearSystemPromptSections|getSystemPrompt\(" src/ -a --glob '!*.test.*'
rg -n "setSessionProvider|isProviderSwitchLocked" src/ -a --glob '!*.test.*'
rg -n "manuallyExtractSessionMemory|migrateFromUpstream" src/ -a --glob '!*.test.*'
rg -n "resetSettingsCache|setSessionSettingsCache" src/ -a --glob '!*.test.*'
git show 8448eec:src/screens/REPL.tsx | grep -n "CLAUDE_CODE_AGENT_MODE"
rg -n "getRuntimeMainLoopModel" src/query.ts src/utils/model/model.ts src/utils/analyzeContext.ts
```

External verification (r4): Anthropic's model overview
(<https://platform.claude.com/docs/en/about-claude/models/overview>) was
fetched on 2026-07-30 to check the knowledge-cutoff table cited in A9.

Key negative results relied on above: `manuallyExtractSessionMemory` has no
caller; `clearSystemPromptSections` has exactly the seven sites listed in
A2-i; the section registry is used only from `src/constants/prompts.ts`;
no settings/config path clears the section registry.

Dirty-tree caveat: `src/screens/REPL.tsx` is mid-edit by a concurrent
session; its citations use `git show 8448eec:` line numbers (`3106`,
`2803`, `3120` all verified against the pinned commit). All other cited
files were clean in the working tree at verification time.

Test evidence (this session's own runs):
`bun test src/constants/prompts.test.ts src/utils/providerPromptRegressions.test.ts`
→ 20 pass / 0 fail. These suites do not cover the A2-i cache-warm ×
provider-switch interaction, A5's final OpenAI prefix payload, or A8's
Plan-mode runtime-model remap — all three are recommended additions.

Docs battery for this report: the file is untracked, so plain
`git diff --check` does not inspect it; whitespace checked with
`git diff --no-index --check /dev/null docs/reports/2026-07-30-system-prompt-pipeline-audit.md`.
Expected result: **exit code 1** (the two paths differ — that is what
`--no-index` reports) with **no whitespace diagnostics emitted**; the check
passes on the absence of diagnostics, not on the exit code.
`bun run maps:lint` passed (18 maps; 8 warnings pre-existing in unrelated
map files).

---

## G. Provenance: fork-introduced vs upstream-inherited (added in r5)

**Read this first: this fork no longer syncs from upstream.** There is no
future merge, and nobody upstream will fix anything for us. So provenance
here does **not** mean "someone else's problem" and never justifies waiting
or deferring. Every finding in this report is ours to fix, whatever its
origin.

**What provenance is still good for, then:**

1. **Freedom.** None of this code is on loan. There is no merge-conflict
   cost to redesigning an inherited module, so an implementer should build
   the right thing rather than the upstream-shaped thing.
2. **A known-good reference.** Where upstream did something better, its
   version is a proven design rather than a speculative one. A6 is the
   clean case: upstream logged the error we now swallow, so restoring it is
   a revert to something that demonstrably worked, not a new invention.
3. **Process signal.** Fork-authored defects say something about our own
   review gaps. A9 was written one day before this audit and got the wrong
   column of a published table; A3 and A7 sit in fork-only subsystems that
   never had upstream's review passes.

What it is explicitly **not** good for: assigning blame, or deciding that
an upstream-origin bug is lower priority. A8 is upstream-origin and is the
highest-impact finding in the report.

**Method.** The fork's history begins at a squashed snapshot (`86051a8`,
2026-04-30, **v2.1.87**) that already contained fork work — its second
commit fixes Codex profile persistence — so `git blame` cannot separate
origins for anything inside it.

**The exact fork base is available from npm and was used.**
`npm pack @anthropic-ai/claude-code@2.1.87` yields a readable 13 MB
`package/cli.js`. This is a same-version comparison, so *absence* is
evidence here, not merely suggestive. (Two weaker sources were tried first
and are recorded only to save the next person the trip: 2.1.27 from
homebrew is 60 minors stale, and the compiled 2.1.214–2.1.218 builds in
`~/.local/bin/` are **not string-searchable** at all — `rg -a instructions`
returns 0.)

| Finding | Origin | Evidence at 2.1.87 |
|---|---|---|
| A9 wrong cutoffs | **Ours** | `git blame` → `8b5ce81`, 2026-07-29. |
| A6 silent catch | **Ours (regression)** | Upstream logs it: `catch(o){ I(\`Failed to get system prompt for agent ${V.agentType}: …\`)`. The fork replaced it with `catch (_error)`. |
| A3 truthiness split | **Ours** | `CLAUDE_CODE_AGENT_MODE`: 0 hits. Agent mode is a fork subsystem, so both parsers and their disagreement are ours. |
| A7 duplicated length line | **Ours** | `length_guidance`: 0 hits. `Keep updates brief`: 0 hits. The section and its sentence are both fork additions. |
| §C `session_transcripts` duplication (H7) | **Ours** | `Reading session transcripts`: 0 hits; `session_transcripts` is not an upstream section. |
| A1 marker filter gap | **Ours** | Fork-only by construction: `codex`, `buildOpenAIInstructions` 0 hits; upstream has no OpenAI provider. |
| A5 OpenAI bypass, B3 | **Ours** | Same construction argument. |
| A2-i cross-provider path | **Ours (partly)** | Session-provider switching does not exist upstream. But two of the three stale sections it names (`env_info_simple`, `frc`) are upstream; only `session_guidance` is ours. |
| **A2 core: name-only cache keying** | **Upstream, verbatim** | The whole module is byte-equivalent: `function DQ(q,K){return{name:q,compute:K,cacheBreak:!1}}` … `if(!_.cacheBreak&&K.has(_.name))return K.get(_.name)??null`. That is `systemPromptSection` / `DANGEROUS_uncachedSystemPromptSection` / `resolveSystemPromptSections` / `clearSystemPromptSections`. **See the H1 consequence note below.** |
| A2-iii output-style split | **Upstream** | `output_style` is an upstream cached section (`DQ("output_style")`) under the upstream cache. |
| A2-iv frozen language | **Upstream** | `DQ("language")` is an upstream cached section. The "applies next session" behavior is inherited, which supports the H2 ruling. |
| A8 Plan-mode remap | **Upstream** | `function Hi(A){…"opusplan"…"haiku"…}` is `getRuntimeMainLoopModel` verbatim; its query call site mirrors `query.ts:477-485`. |
| A4 fallback | **Upstream** | `FallbackTriggered` present. |
| B1 mode-3 marker gap | **Upstream** | All five marker occurrences enumerated at 2.1.87: declaration, insertion, the `/context` filter, and the mode-1 and mode-2 filters. **There is no mode-3 filter upstream either.** |

Upstream 2.1.87 section registry, for reference: `ant_model_override`,
`brief`, `env_info_simple`, `frc`, `language`, `memory`, `output_style`,
`scratchpad`, `summarize_tool_results`, and the uncached `mcp_instructions`.
Fork additions: `session_guidance`, `session_transcripts`,
`length_guidance`.

**Caveat on A8.** The remap function and its call site are byte-confirmed
upstream. That upstream *also* builds its prompt from the unmapped model was
not independently verified in the minified bundle — it is a strong
inference from the matching call-site shape, not a byte match.

### G1. Consequence for H1: design it properly, the file is ours outright

A2's root design flaw is **not a fork defect**. The section module at
2.1.87 is byte-equivalent to ours, name-only keying included. Since there
is no upstream sync, that fact carries no cost and no constraint:

1. **Do not shape the fix to stay close to upstream.** There is no merge to
   protect. `systemPromptSections.ts` is ours to redesign, and the right
   key design beats an upstream-shaped one.
2. **Nobody else is going to fix this.** Inherited origin is not a reason to
   narrow H1's scope or defer it.
3. **A2-iii and A2-iv are upstream behavior too**, which is still useful for
   H2: the "language applies next session" contract is long-standing
   behavior rather than an accident this fork introduced, so documenting it
   rather than changing it is the lower-risk call.

The one thing origin genuinely tells the H1 implementer: `env_info_simple`
and `frc` predate the fork and are consumed by paths this audit did not
trace end-to-end, whereas `session_guidance` is ours and fully understood.
Expect fewer surprises keying the fork-owned section than the inherited
ones, and verify the inherited ones' consumers before assuming a key set.

---

## H. Approved remediation plan (operator decisions, 2026-07-30)

This section is the work order. Every option here was chosen by the
operator after the tradeoffs were presented. **Do not re-litigate the
choices**; if implementation reveals a chosen option is unworkable, stop and
report rather than substituting a different one.

Two sub-decisions are deliberately left **OPEN** below (H5, and the
`exceeds200kTokens` question in H3). Raise them; do not pick silently.

### H0. Difficulty and delegation

Difficulty is 1–10 on the program's usual scale. Model tag follows the
migration-orchestrator convention: **ANY** = any competent model,
**CLAUDE** = needs long-horizon coherence or judgment under a constraint,
so do not hand it to a GPT one-shot.

| Item | What it is | Diff | Model | Notes |
|---|---|---|---|---|
| H6 | Two cutoff strings | **1** | ANY | Exact values given in §A9. Nothing to decide. |
| H8 | Two `continue` statements | **1** | ANY | Precedent lines cited. No behavior change. |
| H2 | Document the language contract | **2** | ANY | Must be done **with** H1, not separately. |
| H4 | Unify truthiness on `isEnvTruthy` | **2** | ANY | Mechanical; 3 sites, 2 in `REPL.tsx`. |
| H7 | Extract the duplicated literal | **2** | ANY | Diff the two copies before extracting. |
| H9 | Restore the swallowed log | **2** | ANY | Match upstream's message; find the right logger. |
| H10 | Delete `length_guidance` | **2** | ANY | Removing a section shifts prompt output; expect snapshot-style test churn. |
| H5 | Prefix at the source | **4** | CLAUDE | One-line change guarded by an OPEN sub-decision and two explicitly rejected neighbours. Needs restraint, not cleverness. The optional payload test is the harder half. |
| H3 | Build from the remapped model | **5** | CLAUDE | Conceptually one line, but `REPL.tsx` is huge and multi-writer, and the `exceeds200kTokens` question must be raised rather than guessed. |
| H1 | Key the section cache | **8** | CLAUDE | The only genuinely hard item. Per-section key design, a process-global touched by every prompt build, a deliberate behavior (flag damping) that must survive, and a constraint inherited from H2. |

**Deferred findings, for later planning:**

| Item | Diff | Model | Why deferred |
|---|---|---|---|
| Remaining §C cosmetics | **1** | ANY | Operator declined (H7 note). |
| B1 trigger verification | **5** | ANY | Investigation, not a fix; H8 makes it moot in practice. |
| A4 fallback prompt refresh | **6** | CLAUDE | Bounded impact (one turn, only on failover); needs a rebuild inside the retry loop, so it depends on H1. |
| §E fingerprint / server cache | **7** | CLAUDE | Needs a live emitted-payload experiment, not a code change. |
| B3 structural fix (A5 option c) | **8** | CLAUDE | Unfreezing the OpenAI assembly touches Codex instruction caching. |

**Sequencing that actually matters:**

1. **H3 before H1.** H3 makes `/context` and the live turn agree on the
   model in Plan mode. Doing it first means H1 keys one entry where it
   would otherwise key two.
2. **H1 and H2 in the same session.** H2's "language stays session-scoped"
   ruling is a constraint on H1's key set. Split them and they silently
   contradict each other.
3. **H6 + H8 + H9 + H10 make one trivial batch** (all 1–2, all independent,
   four separate commits).
4. **H4, H5, H7 are independent** and can go anywhere.

### H1. A2 — key the section cache by its inputs (chosen: option a)

Rejected alternatives: targeted invalidation on each event, and fixing only
the `/context` warmer. The operator wants the class closed, not the
instances patched.

**Read §G1 before starting.** The name-only cache is byte-equivalent to
upstream 2.1.87, but this fork does not sync from upstream, so that is
context rather than a constraint: design the key properly instead of
preserving the upstream shape. §G1 does flag which sections are inherited
and therefore have consumers this audit did not trace.

Current shape: `systemPromptSection(name, compute)` produces a zero-argument
closure that captures everything (`systemPromptSections.ts:20-25`), and
`resolveSystemPromptSections` serves `cache.get(name)` for any warm name
(`:50-52`) from one process-global Map (`bootstrap/state.ts:1680-1693`).

Inputs the closures capture, and which therefore belong in the key: model,
provider, enabled tools, additional working directories, mcpClients, output
style config, language, `isAgentMode`, and the `gpt` style flag. Derive the
exact set per section from its registration site rather than from this list.

Binding constraints:

- **Do not key on GrowthBook feature values.** The damping of mid-session
  flag flips (`prompts.ts:479`; cf. `Tool.ts:304`,
  `forkSubagent.ts:64`) is deliberate and must survive. Flags are not
  inputs.
- `DANGEROUS_uncachedSystemPromptSection` must keep bypassing the cache
  entirely (`cacheBreak: true`, `:32-38`).
- The seven existing `clearSystemPromptSections()` sites stay as they are
  (`postCompactCleanup.ts:62`, `EnterWorktreeTool.ts:99`,
  `ExitWorktreeTool.ts:143`, `setup.ts:359`,
  `sessionRestore.ts:382/426/550`). Keying replaces the need for *new*
  ones; it does not make the existing ones wrong.
- Keying alone resolves A2-i, A2-i-b, and A2-iii, because a differing input
  now yields a different entry rather than a stale hit.

Still fix `/context`'s partial-args call at `analyzeContext.ts:938`
(`getSystemPrompt(tools, runtimeModel)` — no additional working
directories, no mcpClients). Under keying it can no longer poison a turn,
but left alone it measures a prompt the session will never send, which
makes `/context` quietly wrong about token cost.

Verification: a pairwise test covering cache warm (`/context`) followed by
pre-turn provider selection, asserting the second build differs. Add a test
that two different argument sets under one section name produce two
entries.

### H2. A2-iv — language changes apply to new sessions only (chosen: option b)

**No code change.** The operator ruled that the current behavior is the
intended contract. The defect is that the contract is recorded nowhere.

Deliverable: document it where a user or implementer will actually hit it.
The setting is applied at `Config.tsx:1555` and consumed by the name-only
cached section at `prompts.ts:743-745`. A doc comment at the section
registration stating "language is read once per session; changes take
effect on the next `/clear`, `/compact`, or restart" is the minimum. If the
language picker has user-facing helper text, it should say so too.

Note the interaction with H1: once sections are keyed by input, language
would *become* live unless language is deliberately excluded from the key.
**H2 therefore constrains H1** — exclude `language` from the key, and say
why in a comment, or the two work items silently contradict each other.

### H3. A8 — build the prompt from the already-remapped model (chosen: option ii)

Rejected: rebuilding the prompt inside `query.ts` after `currentModel` is
computed (fixes A4 too, but largest blast radius), and patching only the
env-info lines.

Change the prompt build at `8448eec:src/screens/REPL.tsx:3120` —
`getSystemPrompt(freshTools, mainLoopModelParam, …)` — to build from
`getRuntimeMainLoopModel({ permissionMode, mainLoopModel, … })`
(`src/utils/model/model.ts:231-249`), matching what `query.ts:477-485`
computes for the actual request.

This also aligns the REPL with `/context`, which already builds its display
prompt from `getRuntimeMainLoopModel` (`analyzeContext.ts:930-938`). Today
the two disagree in Plan mode; after this they agree, which is a
precondition for H1's keying to produce one entry rather than two.

**OPEN sub-decision:** `getRuntimeMainLoopModel` takes `exceeds200kTokens`,
which `query.ts` derives from the most recent assistant message
(`doesMostRecentAssistantMessageExceed200k`). That input may not be
available or meaningful at REPL prompt-build time. Determine what
`/context` passes, and report the choice rather than guessing — passing a
wrong value reintroduces the same mismatch through a different door.

**A4 (fallback) is explicitly NOT in scope**, on impact grounds only: it
fires solely when a request fails over and the prompt heals on the next
turn. Its upstream origin is **not** a reason to defer it — no upstream fix
is coming (§G). Queue it behind H1, whose cache work it depends on.

**Concurrency note:** `REPL.tsx` was mid-edit by another session during the
r1–r4 audit. It was clean at `a424574` when r5 was written. Re-check
`git status` before editing and per CLAUDE.md §3, do not debug failures in
a dirty file you did not touch.

### H4. A3 — unify both agent-mode checks on `isEnvTruthy` (chosen: option a)

Widen the two exact-match gates (`queryContext.ts:66`,
`8448eec:REPL.tsx:3106` and `:2803`) to use `isEnvTruthy`
(`envUtils.ts:39-44`), matching `systemPrompt.ts:28-30` and
`prompts.ts:514-516`.

Accepted behavior change: anyone currently setting
`CLAUDE_CODE_AGENT_MODE=yes` moves from the broken hybrid state into real
agent mode. That is the intent, not a side effect.

Verification: a test asserting `yes`, `on`, `TRUE`, `1`, and `true` all
produce a prompt containing agent-mode doctrine, and that a falsy value
produces the Doing-tasks and Actions sections.

### H5. A5 — fix the prefix at the source (chosen: option b)

Rejected: fixing only the single-slot overwrite in `splitSysPromptPrefix`,
and unfreezing the OpenAI assembly. Fixing at the embed site is the only
cheap option that corrects **both** providers, because the corrected string
lands inside the frozen GPT payload.

Change `prompts.ts:618` from `getCLISyspromptPrefix()` to a call carrying
the real options.

**Reachability question answered (r5), and it is partly bad news:**

- `isNonInteractive` — **available.** `getIsNonInteractiveSession()` is
  exported from `bootstrap/state.ts:1096`.
- `hasAppendSystemPrompt` — **NOT available as a global.** There is no
  getter in `bootstrap/state.ts` or the settings layer. It is threaded
  through options only (`query.ts:735` → `claude.ts:1513`), and every other
  non-request-path caller hardcodes it: `prompts.ts:667`,
  `awaySummary.ts:75`, `toolUseSummaryGenerator.ts:78`,
  `WebFetchTool/utils.ts:511` all pass `false`.

**OPEN sub-decision for the operator — do not choose this silently:**

- *(i) Follow the in-file precedent.* Pass `hasAppendSystemPrompt: false`,
  as `prompts.ts:667` does 49 lines away. One line. Fixes the main case: a
  headless agent-mode session gets `You are an agent for Cat Code.` on both
  providers. **Residual gap:** an agent-mode session started with
  `--append-system-prompt` still gets the wrong variant, because the
  Agent-SDK-preset prefix is the one pair whose Anthropic and OpenAI
  strings genuinely differ (`system.ts:10` vs `:13`).
- *(ii) Thread the flag* into `getAgentModeSystemPromptSections` from its
  callers. Correct in all cases, wider change, touches the builder
  signature and every call site.

Do NOT also change `splitSysPromptPrefix`'s single-slot behavior as part of
this item; that was the rejected option (a) and is a separate decision.

**Not in scope: B3 / the structural gap.** Ordinary GPT sessions will still
carry no identity prefix, and request-time additions in `claude.ts` will
still miss the OpenAI payload. Per §A5's r5 severity note this is cosmetic
today. Recommended regardless: a test asserting the final OpenAI
`instructions` payload for an agent-mode non-interactive session, so the
next request-time addition fails a test instead of vanishing.

### H6. A9 — apply the verified cutoff dates (chosen: option a)

Official table re-fetched 2026-07-30; see §A9 for the full comparison. Two
edits in `prompts.ts`:

- `:996` — `claude-fable-5`: `'May 2026'` → **`'January 2026'`**
- `:1000` — `claude-sonnet-5`: `'March 2026'` → **`'January 2026'`**

Everything else in the function is correct and must not be touched.
`claude-opus-5` stays `'May 2026'`.

Preserve the convention identified in §A9: this table tracks the official
**reliable knowledge cutoff**, not training data cutoff. Note it in the
`// @[MODEL LAUNCH]` comment at `:992` so the next person adding a model
does not pick the wrong column — that is the exact mistake `8b5ce81` made.

Opus 4.8/4.7 are latent, not live (§A9), so **no branch is added for them
now**. If they are ever added, the branches must go *above* the
`claude-opus-4` prefix test or the prefix will shadow them.

### H7. §C — de-duplicate the shared-key prompt block only (chosen: option a)

The 40-line "Reading session transcripts" literal is duplicated verbatim at
`prompts.ts:576` and `:790`, and both register under the same cache key, so
whichever computes first silently wins and a future edit to one copy may or
may not take effect. Extract to one constant consumed by both sites.

**The remaining §C items stay untouched** per the operator's decision and
CLAUDE.md's no-drive-by-refactor rule: `FRONTIER_MODEL_NAME`,
`CLAUDE_4_5_OR_4_6_MODEL_IDS`, the `void envInfo` waste, and the identical
prefix pairs.

### H8–H10. Items needing no operator decision

- **H8 — A1 + B1: filter the boundary marker.** Add
  `if (block === SYSTEM_PROMPT_DYNAMIC_BOUNDARY) continue` to
  `buildOpenAIInstructions` (`instructionAssembly.ts:80`) and to
  `splitSysPromptPrefix` mode 3's loop (`utils/api.ts:453-476`). Modes 1
  and 2 already do this (`:380`, `:416`) and are the style precedent. No
  behavior change on any currently-working path.
- **H9 — A6: restore the swallowed error.** `runAgent.ts:1023` becomes a
  logging catch, matching upstream's message shape (§G). Revert to upstream
  behavior; do not add new telemetry surfaces beyond it.
- **H10 — A7: drop the duplicated length instruction.** Delete the
  `length_guidance` dynamic section (`prompts.ts:768-772`). Verified: it
  has exactly one registration site (`prompts.ts:769`) and no other
  consumer, so removal is self-contained. The static copies at
  `prompts.ts:497` and `promptStyles/gpt.ts:305` stay — they are cached,
  whereas `length_guidance` sits in the uncached dynamic region and costs
  tokens on every default-path request.

### Verification required before claiming completion

All work here is engine (`src/`), so CLAUDE.md §3's engine battery applies:

```bash
bun run build:dev:full
bun test src/constants/prompts.test.ts src/utils/providerPromptRegressions.test.ts
```

Plus focused suites for each touched subsystem, routed per
`docs/maps/build-release-testing.md` §Test Routing.

Baseline to beat: those two suites were 20 pass / 0 fail at r4. Root
`bun run typecheck` is **known-red (~1,862 pre-existing errors)** and is not
a gate; if you reason about types, the bar is zero *new* errors.

New tests this plan requires: the H1 pairwise cache test, the H4 truthiness
matrix, and the H5 OpenAI `instructions` payload assertion. §F noted all
three as absent today.

Commit per CLAUDE.md §4: explicit paths only, one commit per finding,
directly to the current branch, no push, never `--no-verify`.
