# Phase 0: GPT-Native Prompt Style — Layer 3: Service & Maintenance Prompts

**Status:** Ready for implementation (depends on Layer 1)
**Scope:** Rephrase internal model-to-model prompts (compaction, memory extraction, session memory, magic docs, auto-dream) for GPT-optimal delivery. Same behavioral rules, different instruction style.

---

## Context

Layers 1-2 (see `docs/prompts/2026-04-30-gpt-native-style-layer1-core.md` and `docs/prompts/2026-04-30-gpt-native-style-layer2-agents.md`) handle user-facing system prompts and agent prompts. This layer covers the internal "service" prompts — instructions sent to the model for maintenance operations like conversation compaction, memory extraction, and documentation updates.

These prompts are not user-facing but they directly affect system quality: how well summaries preserve context, how accurately memories are extracted, how documentation stays current. When GPT runs these operations, it should receive GPT-optimal instructions.

The OpenAI prompt engineering guide is the reference: https://developers.openai.com/api/docs/guides/prompt-guidance

Key GPT patterns relevant to service prompts:
- **Output contracts**: Exact section structure with per-section requirements — critical for compaction summaries that feed back into context
- **Completeness checklists**: "Before returning, verify all N sections are present and non-empty"
- **Phase completion gates**: For multi-phase operations (analyze → summarize), explicit "do not proceed to phase 2 until phase 1 is complete"
- **Structured output enforcement**: "Validate brackets/tags are balanced before finishing"

---

## What needs to happen

### Service prompt inventory

#### 1. Compact prompts (highest impact in this layer)
**File:** `src/services/compact/prompt.ts`

Current: `BASE_COMPACT_PROMPT`, `PARTIAL_COMPACT_PROMPT`, `PARTIAL_COMPACT_UP_TO_PROMPT` — each has `DETAILED_ANALYSIS_INSTRUCTION` + numbered output sections + example blocks.

These prompts already have decent structure (numbered sections, examples). GPT variants add:
- Explicit output contract: "Return exactly 9 sections in the order shown. Each section must be non-empty."
- Phase gate: "Complete the `<analysis>` block fully before writing `<summary>`. Do not interleave."
- Completeness verification: "Before finalizing, check: every user message listed? every file change noted? current work described with enough detail to resume?"
- The `NO_TOOLS_PREAMBLE` and `NO_TOOLS_TRAILER` are already imperative — keep as-is or tighten slightly.

Also applies to:
- `getCompactUserSummaryMessage()` — the summary framing message
- `formatCompactSummary()` — no change (this is string processing, not a prompt)

#### 2. Memory extraction prompts
**File:** `src/services/extractMemories/prompts.ts`

Current: `opener()` + type taxonomy + save instructions. Turn-budget strategy ("turn 1 — reads; turn 2 — writes").

GPT variant needs:
- Turn-budget as execution contract: "Turn 1: issue all Read calls in parallel. Turn 2: issue all Write/Edit calls in parallel. Maximum 2 turns total."
- Memory type selection as decision rules, not descriptive taxonomy
- Save procedure as numbered steps with verification: "After writing, confirm the file exists and MEMORY.md index is updated"
- Same tool restrictions, rephrased as binding constraints

Two functions: `buildExtractAutoOnlyPrompt()` and `buildExtractCombinedPrompt()`. The combined version adds team memory scope guidance — both need GPT variants.

#### 3. Session memory prompts
**File:** `src/services/SessionMemory/prompts.ts`

Current: template with section placeholders and update rules.

GPT variant needs:
- Section-by-section output requirements
- Explicit update rules as numbered constraints
- Completeness: "All template sections must appear in output"

#### 4. Magic Docs prompts
**File:** `src/services/MagicDocs/prompts.ts`

Current: documentation update instructions with preservation rules.

GPT variant needs:
- Preservation rules as binding constraints ("NEVER remove existing content unless explicitly incorrect")
- Update completeness: "For each change, verify the documentation reflects the current code state"

#### 5. Auto-dream consolidation prompt
**File:** `src/services/autoDream/consolidationPrompt.ts`

Current: multi-phase dream reflection (orientation → gathering → consolidation).

GPT variant needs:
- Phase completion gates between the three phases
- Output contract for consolidation output
- Probably the lightest-touch rewrite since this is already somewhat structured

---

## Implementation pattern

Same pattern as Layers 1-2 — use `isGPTPromptStyle()` to branch:

```ts
import { isGPTPromptStyle } from '../../constants/promptStyle.js'

export function getCompactPrompt(customInstructions?: string): string {
  const template = isGPTPromptStyle() ? GPT_BASE_COMPACT_PROMPT : BASE_COMPACT_PROMPT
  let prompt = NO_TOOLS_PREAMBLE + template
  // ... rest unchanged
}
```

GPT prompt variants can be defined as constants in the same file (like the existing Claude variants) or in a separate section within the file. No new files needed for this layer.

---

## Files involved

### Modified files
- `src/services/compact/prompt.ts`
- `src/services/extractMemories/prompts.ts`
- `src/services/SessionMemory/prompts.ts`
- `src/services/MagicDocs/prompts.ts`
- `src/services/autoDream/consolidationPrompt.ts`

### Files to read for context (do NOT modify)
- `src/constants/promptStyle.ts` — the style router (created in Layer 1)
- `src/memdir/memoryTypes.ts` — memory type taxonomy (shared between styles)
- `src/memdir/teamMemPrompts.ts` — team memory prompt builder (may need awareness of this)

---

## What does NOT change

- `formatCompactSummary()` — string processing, not a prompt
- Memory type definitions in `memoryTypes.ts` — shared taxonomy
- The `NO_TOOLS_PREAMBLE` and `NO_TOOLS_TRAILER` in compact — already imperative, no style difference
- User-overridable prompt files (`~/.cat-code/session-memory/config/prompt.md`, `~/.cat-code/magic-docs/prompt.md`) — user content, not ours to restyle

---

## Verification

1. `bun run build` — no type/import errors
2. Set `CLAUDE_CODE_USE_OPENAI=1`, trigger a `/compact` operation, inspect the prompt sent to the model — GPT-style compact prompt should appear
3. Trigger memory extraction (make a session long enough to auto-extract), inspect dumped prompts — GPT-style extraction prompt should appear
4. Unset the env var — Claude-style service prompts unchanged
5. For compact: verify the output structure (9 sections, analysis + summary) is preserved in GPT variant
6. For memory extraction: verify turn-budget contract and tool restrictions match the Claude version
