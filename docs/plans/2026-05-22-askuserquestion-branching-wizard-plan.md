# AskUserQuestion Branching Wizard (Cheap / Pre-Baked Tree) — Implementation Plan

Date: 2026-05-22
Status: Proposed (design-approved, revised after independent source review)

> Revision note (post-review): effort re-rated **M→L**. The state-hook rewrite is
> NOT the only real work — answer/annotation derivation and several flat-array
> assumptions live in the parent component and sibling views, not the hook. One
> factual error corrected (`lazySchema` is memoization, not Zod `z.lazy`). See the
> "Components the plan originally missed" and revised effort sections below.

## Goal

Let `AskUserQuestion` present a **shallow decision tree** instead of a flat list of
1–4 independent questions: an option can carry a follow-up question that is only
revealed when that option is chosen. The model emits the entire tree in **one tool
call** (single round-trip — no new model turns, no tool-contract break). The UI
walks the tree and reveals the relevant branch.

This is the "cheap" design explicitly chosen over the "dynamic" alternative (where
each answer round-trips to the model to generate the next question). Cheap keeps the
snappy single-shot feel; the only cost is that the model must generate the whole
tree up front, bounding practical depth to ~2–3 levels.

## Why cheap works

The current tool is stateless: model emits all questions at once, user answers, the
`answers` object returns as the tool result. Branching breaks the assumption that
"later questions are independent of earlier answers" — but only at *emit* time. If
the model pre-computes every branch as nested options, the UI can reveal the correct
path with no new round-trips. The model already branched; the UI only reveals.

## Current structure (verified in source)

- **Schema**: `src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx`
  - `questionOptionSchema` (L14–18): `{ label, description, preview? }`
  - `questionSchema` (L19–24): `{ question, header, options[2..4], multiSelect }`
  - `inputSchema` (L62–67): `{ questions[1..4], ...commonFields }` with a uniqueness
    refine over question texts and per-question option labels.
- **State hook**: `src/components/permissions/AskUserQuestionPermissionRequest/use-multiple-choice-state.ts`
  - Linear cursor: `State.currentQuestionIndex: number`; reducer actions
    `next-question` (`index + 1`), `prev-question` (`max(0, index - 1)`),
    `set-answer` (optionally advances). 179 lines, plain `useReducer`.
- **Review page**: `.../SubmitQuestionsView.tsx` — renders a flat list of
  `question → answer` rows + a Submit/Cancel `Select`. Nav bar shows per-question
  header chips with ✓.
- **Tool description**: `src/tools/AskUserQuestionTool/prompt.ts` — `DESCRIPTION` +
  `ASK_USER_QUESTION_TOOL_PROMPT` (the 4 use-cases) + preview-feature text.

## Design

### Data shape (pre-baked tree)
Add an optional recursive `next` to an option. Picking that option reveals its
`next` question; `next` absent/null = leaf (terminating choice).

```
option = { label, description, preview?, next?: question | null }
question = { question, header, options[2..4], multiSelect, next?: ... (via options) }
```

A flat question (no `next` anywhere) behaves exactly as today — full backward
compatibility. A 1-level tree IS today's behavior.

### UI behavior (already design-approved)
- Step dots (`●●○`) reflect depth along the chosen path, not total question count.
- Breadcrumb shows the chosen path (`Scope › Per account › Independent`).
- `‹ back` pops one level (restores the parent question + its prior selection).
- Review page renders the **path as a tree**, and may note pruned/skipped branches.
- Leaf with `next: null` ends the flow immediately on selection.

## Changes

### 1. Schema — `AskUserQuestionTool.tsx`  (effort: S → M)
- Make `questionOptionSchema` recursive: add `next: z.lazy(() => questionSchema()).nullish()`.
  - **Correction (review):** `lazySchema` (src/utils/lazySchema.ts) is just a memoized
    factory (`() => (cached ??= factory())`) — it is NOT Zod's `z.lazy`. So the
    recursive self-reference uses a genuinely new mechanism here, not "reuse what's
    already lazy-wrapped." `z.lazy` self-reference must coexist with the root
    `z.strictObject` + `.refine`; verify this composes in Zod v4 (it should, but it
    is untested in this file today — add a schema parse test).
- Keep `options.min(2).max(4)` and `questions.min(1).max(4)` at the **root**; nested
  follow-ups are reached via `next`, not the root `questions` array.
- Extend `UNIQUENESS_REFINE` to walk nested questions so labels/texts stay unique
  within each level. **Re-rated (review):** this is the fiddliest schema piece, not a
  freebie — both the runtime double-loop AND its inline parameter type are written
  for a flat `{questions:[{question,options:[{label}]}]}` shape and must become
  recursive over `option.next`.
- `outputSchema` `answers` stays a flat `Record<questionText, answer>` — branching
  affects *which* questions get answered, not the answer shape. (Confirms the
  model's tool-result contract is unchanged.)

### 2. State hook — `use-multiple-choice-state.ts`  (effort: M — the real work)
- Replace the linear `currentQuestionIndex: number` with a **path stack**: an array
  of `{ questionText, selectedLabel }` describing the route taken from a root
  question down to the current node.
- `next-question`: resolve the current option's `next`; push it onto the path. If
  `next` is null/absent and more *root* questions remain, advance to the next root
  question (preserving today's multi-root behavior). If neither, go to review.
- `prev-question`: pop the path (or step to the previous root question at depth 0).
- `set-answer`: unchanged shape; advancement now consults the tree.
- Derive `answers` from the active path only — answers on abandoned branches (user
  went back and chose differently) are dropped so they don't leak into the result.

### 2b. Answer/annotation derivation — `AskUserQuestionPermissionRequest.tsx`  (effort: M — added after review)
**This was the most under-counted piece.** Answer pruning and result-building do NOT
live in the hook; they live in the parent component:
- `submitAnswers` builds the returned `answers` and `annotations` via `questions.map`
  over the **flat root array** (L294/334/381–388). Abandoned-branch answers must be
  pruned **here at submit time**, walking the active path — not only in the reducer.
  Otherwise stale answers leak into both `answers` and `annotations`.
- `isInSubmitView = currentQuestionIndex === questions.length` (L253),
  `allQuestionsAnswered` (L263), and `maxIndex` are all derived here against the flat
  array and must be re-derived from the path/tree.
- **Single-question auto-submit shortcut (L442–448):** `isSingleQuestion =
  questions.length === 1` triggers `submitAnswers` directly, bypassing navigation.
  A 1-question tree that HAS a `next` would wrongly auto-submit on first selection.
  Gate this on "current node has no `next`."
- `hideSubmitTab = questions.length === 1 && !multiSelect` (L264) — same flat-array
  assumption; must account for whether a tree path remains.

### 3. Review page — `SubmitQuestionsView.tsx`  (effort: S)
- Render the chosen **path** as an indented tree instead of a flat list (layout
  already mocked and approved).
- Optionally annotate sibling branches not taken as "skipped" (nice-to-have; can be
  cut if it complicates the first pass).
- Submit/Cancel `Select` unchanged. "Back to change a branch" maps to existing
  prev/back.

### 4. Tool description — `prompt.ts`  (effort: S)
- Add a short paragraph telling the model it MAY nest a follow-up under an option via
  `next`, when a later question only makes sense given a specific choice. Stress:
  keep trees shallow (~2–3 levels), prefer flat questions when answers are
  independent. Do not change the existing 4 use-cases or preview text.

### 5. Renderer glue — `AskUserQuestionPermissionRequest.tsx` / `QuestionView.tsx`  (effort: S–M)
- Feed the current node (from the path stack) into `QuestionView` instead of
  `questions[currentQuestionIndex]`.
- Breadcrumb + step-dot props derived from the path.
- Preview pane logic unchanged (operates per-option).

### 5b. Components the plan originally MISSED (effort: S–M each — added after review)
- **`QuestionNavigationBar.tsx`** — renders one chip per `questions[i]` and keys the
  active tab off `index === currentQuestionIndex` plus a Submit tab at
  `currentQuestionIndex === questions.length`. A tree has no flat index; the nav bar
  must reflect the **path** (chips for the route taken), not the root array.
- **`PreviewQuestionView.tsx`** — threaded the same `currentQuestionIndex` / flat
  `questions` props; must consume the current tree node too.
- **Submit/Next button label** in `QuestionView` keys off
  `currentQuestionIndex === questions.length - 1` — flat-array assumption; re-derive
  from "is this node a leaf / is the path complete."

### 5c. Validation/classifier gaps (effort: S — added after review)
- `validateInput` (HTML preview check) and `toAutoClassifierInput` both iterate only
  top-level `questions[].options`. Nested `next` options would **skip HTML preview
  validation** and be absent from the classifier input string. Make both recurse over
  `option.next`. Not fatal, but a real correctness gap.

## Backward compatibility

- `next` is optional everywhere → existing flat-question callers, the SDK schema
  (`_sdkInputSchema`/`_sdkOutputSchema`), and the bridge/CCR `answers` injection path
  all keep working untouched.
- Output `answers` shape is identical, so the model's tool-result handling and any
  headless/PreToolUse `updatedInput` integrations are unaffected.

## Constraints / non-goals

- **Depth bound**: model emits the whole tree in one shot → practical limit ~2–3
  levels before the options payload bloats and model quality drops. This is for
  shallow, predictable trees (scope → sharing → overflow), NOT deep intake forms.
- **No dynamic branching** (no per-answer round-trips, no model-loop changes). If
  deep/open-ended trees are ever needed, that's a separate, larger effort.
- No change to the channel gate, permission flow, or auto-mode classifier (verified
  earlier: the classifier only intercepts Bash, not AskUserQuestion).

## Effort summary (revised after review)

Overall **M → L**. The original plan framed this as "M, state-hook is the only real
work, everything else S" — that was optimistic. The work is spread across more
surfaces than the hook:
- **State hook** (linear→path stack): M — still core, but not the whole story.
- **Answer/annotation derivation + auto-submit shortcut** (parent component): M —
  the riskiest under-counted piece; pruning and result-building live here, not in
  the hook.
- **UNIQUENESS_REFINE recursion + `z.lazy` self-reference**: M (was mis-rated S).
- **Nav bar, preview view, submit/next label, validate/classifier recursion**:
  S–M each, and were missing from the original changes list entirely.

Still fully additive and reversible (optional `next`; flat behavior preserved). The
backward-compat *claim* (output `answers` shape unchanged; SDK exports have no in-repo
consumers) holds — confirmed in review. The cost is breadth of touchpoints, not a
contract break.

## Backward-compat hazards surfaced by review
- **1-question tree + `next`** hits the single-question auto-submit fast-path and
  would submit on first pick. Must gate on "node has no `next`." (See §2b.)
- Nested options bypass **HTML preview validation** and **classifier input** today.
  (See §5c.)
- `_sdkInputSchema` / `_sdkOutputSchema` are public-SDK-only with **no in-repo
  consumers** → additive `next` is safe there. Original compat claim verified true.

## Verification

- `bun run build:dev:full` — compile + lint.
- Unit-test the reducer's path-stack transitions (next/prev/back, branch switch
  dropping abandoned answers, leaf termination, multi-root fallback). This part IS
  deterministically testable, unlike the prompt-frequency question.
- Behavioral check (manual): in a dev build, have the model emit a 2–3 level tree;
  walk it, go back, switch a branch, confirm the review page shows the correct path
  and the returned `answers` contains only the active-path questions. The model's
  *willingness* to nest is emergent and observed, not asserted.

## Relationship to the other plan

Separate from `2026-05-22-proactive-askuserquestion-plan.md` (prompt framing to make
the model ask more often). That plan governs *when* the model asks; this plan governs
*what shape* a question can take. They are independent and can land in either order.
