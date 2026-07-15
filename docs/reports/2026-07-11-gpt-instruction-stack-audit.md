# GPT Instruction-Stack Audit — 2026-07-11 (rev 3)

Read-only audit of the effective instruction stack delivered to GPT models in Cat Code.

Revision history: rev 1 = initial audit. rev 2 = first adversarial review (REVISE) + memory audit
+ openai/codex production comparison. rev 3 = second adversarial review (RED) — its verified
corrections are incorporated below; where a review claim did not survive re-verification, that is
stated with evidence. Nothing has been implemented; this document is the implementation authority.

## How the stack assembles (verified against current source)

Per-request provider: `resolveRequestProvider(model, baseProvider)` — `gpt-*` → `'openai'`,
everything else inherits (`src/utils/model/providers.ts:61-80`). Session provider set from the
initially resolved model (`src/main.tsx:2163`) and on `/model` switches
(`src/commands/model/model.tsx:64,216`; `src/screens/REPL.tsx:5338`).

- `getSystemPrompt(tools, mainLoopModel, …)` picks GPT vs Claude section variants via
  `isGPTPromptStyle(resolveRequestProvider(model))` (`src/constants/prompts.ts:693-694,832-856`;
  Agent-Mode variant `:544-545,616-629`). GPT variants: `src/constants/promptStyles/gpt.ts`.
- Per turn, `query.ts:486-489` resolves `currentProvider` from the current model; `query.ts:697-703`
  builds the provider assembly. OpenAI path (`src/services/api/instructionAssembly.ts:38-65`):
  `instructions` = systemPrompt + stable systemContext + userContext (claudeMd, currentDate);
  volatile keys (`gitStatus`, `cacheBreaker`) → developer-role input item (`:23,87-98`; rendered
  `codex-fetch-adapter.ts:1191-1202`). Anthropic path: systemContext appended to system;
  userContext prepended as a `<system-reminder>` user message (`src/utils/api.ts:479-516`).
- Tool schemas are request-provider-keyed (`toolToAPISchema`, `src/utils/api.ts:165-212`; Grep
  dash-flag renames `src/utils/openaiSchemaCompat.ts:9-15`; cache key `provider:tool`).
- Provider-branched tool prompts (exact list): Bash, FileWrite, TodoWrite, Grep, FileEdit, Skill,
  Agent (`rg isGPTPromptStyle src/tools`), plus the GPT-only Apply_patch description
  (`FilePatchTool/prompt.ts`) — 8 surfaces. Other tool descriptions are shared across providers.
- Codex adapter (`codex-fetch-adapter.ts:1170-1317`) is provider-native (instructions/input/tools,
  effort mapping incl. GPT-5.6 `none`, encrypted-reasoning round-trip, canonicalization for WS
  incremental sends).
- Compact/memory-extraction/session-memory/magic-docs prompts are provider-branched on the request
  provider (`compact.ts:1348-1376`; `services/*/prompts.ts`).
- `--bare` context skipping: repo-instruction discovery is skipped when
  `CLAUDE_CODE_DISABLE_CLAUDE_MDS` is set or bare mode is active with no explicit `--add-dir`
  (`src/context.ts:198-203`). Print mode (`-p`) alone does NOT skip repo instructions.

## PRIMARY FINDING — per-request provider routing leaks session/parent provider state

Class: **Confirmed defect** (two manifestations, source semantics). The fork's routing promise —
"the model string wins per request" — is implemented in request assembly, tool schemas, and the
adapter, but two consumers of provider state were never re-keyed from session/parent scope. Both
bite on the designed-for cross-provider path: a `gpt-*` worker dispatched from an Anthropic-provider
session (first-class: the Agent tool's model enum includes `gpt-5.6-sol/terra/luna`,
`AgentTool.tsx:351`; also custom-agent frontmatter models).

### Manifestation 1 — inbound tool-input rename-back keyed on session provider (silent Grep flag loss)

Chain (all confirmed):
1. Outbound schema renames Grep `-A/-B/-C/-n/-i` → `lines_after/…` for OpenAI, keyed on the
   REQUEST model (`api.ts:165-201`). GPT sees and emits renamed keys.
2. Inbound decode `normalizeContentFromAPI` (`messages.ts:2677,2733`) → `normalizeToolInput`
   (`api.ts:631-640`) gates the reverse rename on `getAPIProvider()` — the SESSION provider.
   In an Anthropic session the rename-back is skipped.
3. `GrepTool.inputSchema` knows only dash keys (`GrepTool.ts:58-71`), not `.strict()` → zod strips
   the renamed keys. Flags silently vanish (case-sensitivity, context lines, line numbers), no error.

Not affected: `-p --model gpt-*` and `/model` (session provider follows the model,
`main.tsx:2163`). Record/replay canonicalization (`codex-fetch-adapter.ts:705-739`) is
self-consistent today (same gate both sides), so WS delta matching is unaffected — which is also
why the fix must change both sides in lockstep.

**Fix (single prescription — supersedes all earlier variants):** thread the authoritative
`requestProvider` already computed at `claude.ts:1131`
(`resolveRequestProvider(options.model, options.provider)`) through the three production decode
sites — `claude.ts:2375`, `claude.ts:2778`, `claude.ts:2887` — into `normalizeContentFromAPI` and
`normalizeToolInput`. Pass `'openai'` explicitly from the Codex record-side canonicalization
(`canonicalizeToolArgumentsForRecord`). Keep `getAPIProvider()` ONLY as fallback for legacy/direct
callers. Do NOT derive the provider from the response's model string, and do NOT rename
unconditionally (a Claude-emitted literal `lines_after` key would be silently mutated).

### Manifestation 2 — worker prompt style keyed to the parent, on BOTH assembly paths

There are two places a worker system prompt is assembled; both are affected, and the more common
one was missed in rev 1–2:

**Path A (common: ordinary spawn, no worktree/cwd override) — `AgentTool.tsx` preassembly:**
- Worker model resolved: `AgentTool.tsx:710`.
- Prompt body built from the UNCHANGED parent context: `selectedAgent.getSystemPrompt({ toolUseContext })`
  at `AgentTool.tsx:877-879` — built-ins branch style on the parent's `mainLoopModel`
  (`generalPurposeAgent.ts:61-68`).
- Env enhancement receives the correct model but a PARENT-derived provider argument:
  `enhanceSystemPromptWithEnvDetails([agentPrompt], resolvedAgentModel, …,
  resolveRequestProvider(toolUseContext.options.mainLoopModel, …))` at `AgentTool.tsx:892` —
  so on this path even the env-notes style is parent-keyed.
- The completed prompt is passed as `override.systemPrompt` (`AgentTool.tsx:937-941`), and
  `runAgent.ts:567` uses the override, BYPASSING `getAgentSystemPrompt` entirely.

**Path B (worktree/cwd spawns) — `runAgent.getAgentSystemPrompt` (`runAgent.ts:995-1035`):**
body uses the parent context (`:1006`) while the fallback prompt and env details use the worker's
`resolvedAgentModel` (`:1008-1013, 1025-1034`) — the intended contract, applied in two of three places.

**Agent-Mode roles ARE reachable:** the per-call `model` override (`AgentTool.tsx:351`, passed at
`:924`) wins over the definitions' `model: 'inherit'` in `getAgentModel`
(`src/utils/model/agent.ts:88-98`), so `agent-mode-coding-worker` / `agent-mode-verifier`
(`rolePrompts.ts:163-170, 307-314`) hit the same mismatch under an explicit GPT override.

Effect: a GPT worker gets the Claude-narrative body (and on Path A, Claude-styled env notes).
The identity prefix on the non-OpenAI branch is the provider-neutral "You are an agent for Cat
Code" (`src/constants/system.ts:35-42`) — no wrong-identity claim, a style/contract mismatch only.
Confirmed mismatch by source semantics; performance cost is a behavioral hypothesis (the variants
encode equivalent rules by design, `gpt.ts:1-9`).

**Fix:** compute the worker's request provider once and use it in BOTH paths — `AgentTool.tsx`
preassembly (body + env-enhancement provider argument) and `runAgent.getAgentSystemPrompt`.

### Required test coverage (production wiring, not leaf functions)

1. First-party session + GPT worker end-to-end through real response assembly (all three decode
   sites — streaming and non-streaming): renamed Grep keys map back to dash keys.
2. Codex record/replay byte-equality under a deliberately mismatched session provider (firstParty).
3. Path A: ordinary built-in, no cwd, per-call GPT override → body, identity prefix, and env-note
   style all GPT-keyed.
4. Path B: same with worktree/cwd override.
5. One Agent-Mode role (coding worker or verifier) with per-call GPT override.

### Adjacent, deferred (do NOT bundle)

Edit vs Apply_patch is chosen from global session state (`tools.ts:213-214`) inside `getTools`.
Worker-specific pools already exist (`assembleToolPool`, `tools.ts:385`; called per worker at
`AgentTool.tsx:814` area) — the missing piece is only a provider input to pool assembly plus an
audit of its consumers, not a per-agent-pool architecture. Deferred because changing a worker's
tool roster has UX/permission implications beyond prompt correctness.

## Competing findings

### F2 — Agent-Mode delegation doctrine duplicated verbatim in one prompt (Structural, confirmed)

With Agent Mode active, the assembled GPT prompt contains the same three-sentence doctrine twice —
`gpt.ts:285` (Using Your Tools/DELEGATION) and `gpt.ts:349` (Session-Specific Guidance/AGENT MODE):
coding-worker threshold, sensitive-surface rule, independent-verification rule. Both sections are
included together (`prompts.ts:843-846` + `:729-731`; agent-mode assembly `:616-629` + `:550-554`).
Claude twins duplicate identically (`prompts.ts:389` vs `:642`). Independent review confirmed all
three sentences occur exactly twice in the emitted prompt. This is deterministic token waste
regardless of any model-behavior claim; the OpenAI guidance below additionally recommends removing
exactly this. Fix: own the doctrine in one section per mode.

### F3 — GPT prompt register vs current OpenAI guidance (Behavioral hypothesis — eval before acting)

`gpt.ts:1-9` cites OpenAI's prompt guidance as its reference for "contract-first, numbered priority
rules"; the file uses ALL-CAPS `RULE`/`CONTRACT` headers for judgment-call guidance
(`gpt.ts:110-124,294-316`). Current guidance for these exact models (verbatim, fetched 2026-07-11,
https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6):
- "Use ALWAYS, NEVER, must, and only for true invariants such as safety rules, required fields, or
  actions that should never happen. For judgment calls, such as when to search, ask, use a tool, or
  keep iterating, prefer decision rules."
- "Trim: repeated statements of the same rule; repeated style or process instructions that do not
  change behavior."
- "GPT-5-class models follow prompt contracts closely, so conflicting rules can create more
  instability than missing detail."
And OpenAI's own shipping harness (see comparison below) uses ~2,600 words of sentence-case prose
with near-zero ALL-CAPS for the GPT-5.6 family. Direction is corroborated by docs AND production
practice; magnitude on THIS stack is unmeasured — do not rewrite without an eval.

### F4 — Tool-description length is directly contested between providers (Behavioral hypothesis)

Anthropic (verbatim, fetched 2026-07-11,
https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use): "Provide
extremely detailed descriptions. This is by far the most important factor in tool performance. …
Aim for at least 3-4 sentences per tool description, more if the tool is complex."
OpenAI GPT-5.6 (same fetch as F3): "Tool descriptions should state what the tool does, when to use
it, important return fields, and error behavior," with "simplifying tool descriptions" listed as a
migration lever. Cat Code shares most tool descriptions across providers (8 provider-branched
surfaces, listed above); the shared ones follow the Anthropic register. Whether the shared
descriptions measurably penalize GPT here is unestablished — requires an eval with emitted
prompt/tool token counts.

### Cache note (verified local behavior; server-side impact is inference)

The volatile split (gitStatus/cacheBreaker → developer message) is sound and tested
(`providerPromptRegressions.test.ts:218-247`). Within a session the GPT `instructions` blob is
mostly stable; the known per-turn recompute inside it is `mcp_instructions`, and only when
MCP-instructions delta mode is DISABLED (`prompts.ts:754-761` gate; when delta mode is on,
instructions arrive as attachments instead). `/model` switches and `/clear`–`/compact` section
rebuilds also rewrite the blob. What is verified is the local request-prefix mutation; the exact
server-side cache economics on the ChatGPT/Codex backend are not publicly documented and are
inferred from prefix-caching behavior, not measured. Overlaps the closed 2026-07-06 cache
investigation; not claimed as new.

## Memory-instruction audit

Channels (they are distinct — conflating them was rev 2's error):
1. **Memory doctrine** — `loadMemoryPrompt()` (`memdir.ts:419-507`) → system-prompt section
   (`prompts.ts:736`; agent-mode `:555`); on GPT it sits inside `instructions`.
2. **Memory INDEXES (MEMORY.md)** — injected via the claudeMd payload (`context.ts:210-233` →
   `getClaudeMds`, `claudemd.ts:1199-1241`) — UNLESS `tengu_moth_copse` is on, in which case
   `filterInjectedMemoryFiles` removes them from claudeMd (`claudemd.ts:1183-1198`).
3. **Topic-memory attachments** — relevance prefetch selects topic files (excluding MEMORY.md,
   `findRelevantMemories.ts:35-40`) and attaches them as user-message attachments with their own
   framing (`attachments.ts:2197,2362`; rendering `messages.ts:~3820`).
4. **Agent memory** — separate path (`memdir.ts:268-316`).

### M-1 — authority-framing mismatch on injected memory indexes (Confirmed, conditional; behavioral impact hypothesis)

When AutoMem/TeamMem MEMORY.md indexes ARE injected through claudeMd (the default,
`tengu_moth_copse` off), they inherit the generic supremacy banner `MEMORY_INSTRUCTION_PROMPT`:
"These instructions OVERRIDE any default behavior and you MUST follow them exactly as written"
(`claudemd.ts:89-90,1240`) — a banner written for instruction files (CLAUDE.md, rules), applied
indiscriminately to recalled-memory indexes. The memory doctrine simultaneously instructs
verify-before-trusting for memory content (MEMORY_DRIFT_CAVEAT `memoryTypes.ts:201-202`; "Before
recommending from memory" `:240-256`). These are different channels talking about overlapping
content with opposite authority framing — not "the same bytes framed three ways" (rev 2 overstated
this): the drift caveats speak to memory records; the banner covers the index that summarizes them.
On the Anthropic path the claudeMd channel additionally carries the `<system-reminder>`
"may or may not be relevant / treat as metadata" wrapper (`api.ts:505-511`); on GPT that wrapper is
absent because claudeMd sits inside `instructions` (`instructionAssembly.ts:80-84`), so the
MUST-follow banner is the only frame the index gets, at system authority. Per the verified OpenAI
guidance ("conflicting rules can create more instability than missing detail"), this lands harder
on GPT. openai/codex, for comparison, injects AGENTS.md as a plain user-role item in
`<INSTRUCTIONS>` markers with no supremacy banner.

Bounded fix: split the preamble by `file.type` in `getClaudeMds` — instruction files keep the
MUST-follow banner; AutoMem/TeamMem entries get accurate framing ("recalled memory index —
background context; verify against current state before acting"). Re-run the memory evals
(H1/H5/H6, annotated in `memoryTypes.ts:204-215,224-239`) to confirm no regression.

### M-2 (rev 2 version REJECTED) — narrowed observation

Rev 2 claimed the model has "no mechanism beyond the index" for accessing memory. False: the
doctrine supplies the absolute memory directory (`memdir.ts:237`), explains that MEMORY.md links to
topic files (`memdir.ts:219-229`) which the model can Read, and `tengu_moth_copse` adds relevance
prefetch that attaches topic files automatically (`attachments.ts:2197,2362`). The defensible
narrow observation: when the index lacks a useful pointer AND relevance-prefetch is disabled, no
explicit fallback search recipe is shown unless `tengu_coral_fern` is enabled
(`buildSearchingPastContextSection`, `memdir.ts:375-378`). Low severity.

### M-3 — save-timing under-specified (Structural, mild)
Per-type `<when_to_save>` is good decision-rule shape, but nothing states when in the turn to write
or to sweep before session end; partially mitigated by background extractMemories
(provider-branched). Explicit-ask saves covered (`memdir.ts:243`).

### M-4 — hand-forked near-duplicates (Structural, mild)
`teamMemPrompts.ts:82-86` re-inlines "When to access" bullets instead of reusing
WHEN_TO_ACCESS_SECTION (`memoryTypes.ts:216-222`) — an undocumented fork (unlike the documented
TYPES_SECTION duplication).

Calibration: the memory doctrine is one of the repo's most evidence-driven surfaces (eval
annotations with scores; decision-rule shape + examples fitting both providers). The real defect is
M-1's banner mismatch, not the doctrine's register.

## openai/codex production-harness comparison (repo main @ 2026-07-11, primary source)

| Dimension | openai/codex | Cat Code GPT path |
|---|---|---|
| Base-instruction ownership/lifetime | Per-model base prompt resolved ONCE at session construction; byte-stable for the session; mid-session model switch leaves it untouched (`<model_switch>` developer note carries the new model's guidance) | Styled system prompt rebuilt per turn from sections; `/model` switch re-styles the whole prompt |
| Wire placement | Non-Lite: the `instructions` field. GPT-5.6 (responses-lite): `instructions` sent empty; base prompt rides in a developer-role prefix of `input` (an AdditionalTools item may precede it) | Combined stack (styled prompt + dynamic sections + stable systemContext + claudeMd + currentDate) in the `instructions` field (`instructionAssembly.ts:49,75-85`; `codex-fetch-adapter.ts:1206-1210`) |
| AGENTS.md / CLAUDE.md | User-role input item in `<INSTRUCTIONS>` markers, injected once, later turns diff with explicit replace semantics; no supremacy banner | Inside `instructions` under `# claudeMd` with the MUST-OVERRIDE banner |
| Env/date/sandbox | `<environment_context>` user item, diff-only re-emission | Env in styled prompt section; date in instructions; gitStatus in a developer msg (the one codex-like piece) |
| Base prompt register (5.6) | ~2,600 words sentence-case prose, near-zero ALL-CAPS (one "DO NOT" in ~16k chars), personality-first | `gpt.ts`: RULE-stacked with ALL-CAPS headers |
| Tool descriptions | Typically concise (1-3 sentences in the inspected `*_spec.rs` files; Windows shell guidance is a longer exception); `strict:false`; policy in prompt/developer msgs; freeform Lark-grammar apply_patch | Mostly shared Anthropic-register descriptions; 8 provider-branched surfaces; Apply_patch grammar matches upstream |
| Compaction prompt | ~80 words ("CONTEXT CHECKPOINT") | Large provider-branched compact prompt |
| Cache invariants | `prompt_cache_key = thread_id`; strict-prefix-extension checks gate WS incremental sends; every non-input field equality-checked (request-construction invariants — backend cache economics are not published) | `prompt_cache_key` = sessionId; WS incremental + canonicalization (equivalent idea); instructions-stability not an enforced invariant |

Impact: F3/F4 direction corroborated by production practice (still eval-gated for this stack). The
everything-in-instructions architecture is a documented divergence from how OpenAI ships these
models — a candidate future restructure (stable instructions; claudeMd/env as diffed input items)
that would also dissolve M-1's GPT-side severity. NOT part of the selected bounded fix.

## External research citations (durable)

Verified first-hand via fetch on 2026-07-11 (quotes verbatim):
- GPT-5 prompting guide — https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide :
  "poorly-constructed prompts containing contradictory or vague instructions can be more damaging
  to GPT-5 than to other models, as it expends reasoning tokens searching for a way to reconcile
  the contradictions rather than picking one instruction at random." Also: "GPT-5 follows prompt
  instructions with surgical precision."
- GPT-5.6 prompt guidance — https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6 :
  quotes in F3 above, plus preambles ("Prompt for a short visible preamble before the first tool
  call, then sparse outcome-based updates at major phase changes.") and parallelism guidance.
- Anthropic tool definitions — https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use :
  "Provide extremely detailed descriptions. This is by far the most important factor in tool
  performance. … Aim for at least 3-4 sentences per tool description, more if the tool is complex."

Reported by the delegated research pass on 2026-07-11 but NOT independently re-verified here (treat
as secondary until re-fetched): Claude Opus 4.8 "provides more regular, higher-quality updates"
natively (platform.claude.com prompting-claude-opus-4-8); OpenAI "Unrolling the Codex agent loop"
blog details (direct fetch 403'd; content via search extraction); Responses API caching mechanics
pages (prompt-caching guide, Prompt Caching 201); OpenAI GPT-5.1/5.2 cookbook guides.

## What checked out sound

Per-request assembly + fallback rebuild loop (`query.ts:694-710,949`); queryHaiku/WebFetch
small-fast-model path builds its own OpenAI assembly (`claude.ts:3498-3538`); compact
provider-consistent (`compact.ts:1348-1390`); `--bare` context skipping (`context.ts:198-203`);
Apply_patch grammar tool (`api.ts:73-78,207-211`); GPT-5.6 effort mapping incl. `none`
(`codex-fetch-adapter.ts:1324-1347`); structured outputs translated to native json_schema
(`:1248-1261`). Independent review additionally ran `bun test src/utils/providerPromptRegressions.test.ts`
(12 pass), `src/services/api/codex-item-canonicalization.test.ts` (7 pass),
`src/constants/prompts.test.ts` (8 pass) — all green on the unmodified tree.

## Uncertainties

- Frequency of in-session cross-provider spawns in real usage (vs `-p` one-shots) — determines
  Manifestation 1's realized impact; transcript mining would resolve.
- The AgentTool GPT-only claim "without run_in_background agents run serially"
  (`AgentTool/prompt.ts:376,394`) is unverified against actual behavior.
- F3/F4 magnitude on this stack unmeasured (needs eval with emitted token counts).
- ChatGPT/Codex backend cache economics unpublished; only request-construction invariants are
  observable.

## Selected implementation task (final)

Fix the provider-keying leak:
1. Thread `requestProvider` (claude.ts:1131) through the three decode sites into
   `normalizeContentFromAPI`/`normalizeToolInput`; `'openai'` explicit in Codex record-side
   canonicalization; `getAPIProvider()` fallback for legacy callers only.
2. Worker-provider-keyed prompt style in BOTH assembly paths (`AgentTool.tsx:877,892,937` and
   `runAgent.ts:1006`), covering ordinary built-ins AND Agent-Mode roles under per-call overrides.
3. Test matrix as listed under "Required test coverage".

Unbundled follow-ups, in rough value order: M-1 banner split (then re-run memory evals);
F2 doctrine dedup; provider input to `assembleToolPool`/`getTools`; F3/F4 eval;
instructions-architecture restructure.
